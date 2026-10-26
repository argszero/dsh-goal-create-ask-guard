# dsh-goal-create-ask-guard

Ask a human before `create_goal` starts an automatic continuation loop — and fail
closed where nobody can answer.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## The gap

`create_goal` has exactly one runtime gate: `requireDirectHuman`
(`packages/goal/tool-goal/src/authority.ts`). It asks whether the current
root-agent turn contains a human message. It never asks whether that human
wanted a goal — and the policy text the model reads says so plainly:
*"create_goal may infer goal intent from a direct human request in any
language."* Intent stays a model judgement, and a created goal is immediately
`active` with continuation enabled, so the goal-round driver starts injecting
rounds as soon as the agent idles.

## What this plugin does

It puts a decision in front of that call. `tools/pre-execute` returns a
`PreToolDecision`, and `{ kind: 'ask' }` routes the call through the approval
seam: it runs only when an approval service answers `allowed-once`, and every
other outcome denies it. Durable goal state is untouched — an approved call runs
the shipped tool body unchanged.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/dsh-goal-create-ask-guard
```

The bundle patch mounts one row:

```yaml
- insert:
    - id: goal-create-ask-guard
      name: '@argszero/dsh-goal-create-ask-guard'
```

## Configuration

```yaml
- id: goal-create-ask-guard
  name: '@argszero/dsh-goal-create-ask-guard'
  config:
    policy: ask      # ask (default) | allow | deny
```

| `policy` | `create_goal` |
|---|---|
| `ask` (default) | one approval request; runs only on a grant |
| `allow` | runs untouched, no prompt — identical to uninstalling the guard |
| `deny` | refused with a stable model-facing reason |

## Measured behaviour

Measured through the real tool pipeline, the real native executor, the real
`@deepseek-ai/dsh-tool-goal` body and the real `@deepseek-ai/dsh-user-approval`
service at upstream commit `22ddee3792` — not on stubs.

| arm | outcome |
|---|---|
| no guard (control) | goal created, `phase: active`, `activation: armed`, `maxGoalRounds: 40` |
| `ask` + granting answerer | allowed; goal identical to the control in every field; 1 approval request |
| `allow` | allowed; 0 approval requests; goal identical to the control |
| `ask`, no answerer composed (stock headless) | denied: `tool "create_goal" requires approval, but no approval channel is available`; no goal, no durable `goal/change` |
| `ask`, no approval service at all | denied with this plugin's own reason; no goal |
| approval policy `never` | denied: `the user rejected tool "create_goal"`; no goal |
| subagent-initiated call | no approval spent; core refuses: `this goal operation requires a direct human turn on a top-level agent` |
| other tools (`get_goal`, …) | untouched, no prompt |

Two consequences worth stating plainly:

- **An unanswered ask never reads as success.** With no answerer the call is
  denied, with a message that says the approval channel is absent rather than
  inviting a retry. There is no surface on which this guard silently permits the
  call.
- **It cannot tell a human who asked for a goal from one who did not.** The only
  human signal a plugin can observe is `source.kind === 'user'` on a turn
  message, and both cases share it; the runtime keeps intent a model judgement
  on purpose. So under the default `ask`, a plainly-asked goal is confirmed
  once as well. `policy: 'allow'` is the deployment's off switch.

## What this is not

The report behind it asked for three things. This plugin delivers the first:

- **(a) an approval gate before creation** — here.
- **(b) decoupling creation from continuation** — core-side. Recording a target
  cheaply and arming auto-run by separate intent is not something a plugin can
  express: `create_goal` persists an `active`, `armed` goal in one step.
- **(c) a user-confirmed `maxGoalRounds`** — core-side. The cap is a model
  argument; a plugin sees the chosen value only after the model picked it.

It also gates the **tool**, not the goal domain: `/goal <objective>` and the goal
API route create goals without this tool, and both are already explicit human
actions.

## Tests

```sh
npm test          # 11 unit arms
```

The full measurement suite that produced the table above runs inside a checkout
of the harness (it needs the workspace packages) and lives in
[`measure/c782-measure.spec.ts`](measure/c782-measure.spec.ts).

## License

MIT
