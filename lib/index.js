/**
 * Ask a human before `create_goal` starts an automatic continuation loop.
 *
 * The goal tool has exactly one runtime gate — `requireDirectHuman`, which asks
 * whether the current root-agent turn contains a human message. It never asks
 * whether that human wanted a goal. The model is told so in the policy text it
 * reads: "create_goal may infer goal intent from a direct human request in any
 * language". Intent therefore stays a model judgement, and the created goal is
 * immediately `active` with continuation enabled, so the goal-round driver
 * begins injecting rounds as soon as the agent idles.
 *
 * This plugin puts a decision in front of that call. `tools/pre-execute`
 * returns a `PreToolDecision`, and `{ kind: 'ask' }` routes the call through the
 * approval seam: the call runs only when an approval service answers
 * `allowed-once`, and every other outcome denies it. The durable goal domain is
 * untouched — an approved call runs the shipped tool body unchanged, and a
 * refused one never reaches it.
 *
 * Three properties are deliberate, and each is measured against the shipped
 * runtime rather than assumed:
 *
 * - **Fail closed, never open.** With no approval answerer composed — a
 *   headless run, a script, an unattended box — the seam resolves `unavailable`
 *   and the call is denied. It never degrades into "nobody answered, so go
 *   ahead". The model is told which of the two happened.
 * - **No prompt for a call the core already refuses.** A goal can only be
 *   created on a top-level agent, so a subagent's `create_goal` is rejected by
 *   the tool body whatever the approval says. Asking a human about it would
 *   spend their attention on a decision that changes nothing, so this plugin
 *   leaves those calls alone and the core refuses them.
 * - **It gates the tool, not the domain.** `/goal <objective>` and the goal
 *   API route create goals without this tool, and both are already explicit
 *   human actions. This plugin covers the path where the model decides.
 *
 * What it does not do, and what no plugin can do here: it cannot tell a human
 * request that plainly asks for a goal from one that does not. The runtime
 * keeps that a model judgement on purpose, and the only human signal a plugin
 * can observe is `source.kind === 'user'` on a turn message, which both cases
 * share. So under the default `ask` policy a plainly-asked goal is confirmed
 * once as well; `policy: 'allow'` is the deployment's off switch.
 *
 * @module dsh-goal-create-ask-guard
 */

/** The one tool this plugin decides on. */
export const GUARDED_TOOL = 'create_goal'

/** Accepted `policy` values. */
export const POLICIES = ['ask', 'allow', 'deny']

/** Plugin name reported by the loader. */
export const name = '@argszero/dsh-goal-create-ask-guard'

/**
 * Hard requirement: the seam is the tool pipeline's pre-execute waterfall, so
 * an absent tool runtime must leave this plugin pending rather than loaded and
 * inert.
 */
export const inject = ['tools']

/** Audited approval reason: why the human is being asked. */
export const ASK_REASON = 'create_goal starts an automatic continuation loop for this session'

/** Localized prompt text shown with the approval request. */
export const DISPLAY_REASON = {
  en: 'The model wants to create a goal. A goal keeps working in automatic rounds until it is complete, paused, or blocked. Approve only if you want that.',
  zh: '模型想要创建一个 goal。goal 会自动按轮次持续工作，直到完成、暂停或被阻塞。仅当你确实希望如此时才批准。',
}

/** Model-facing denial used by the `deny` policy. */
export const DENY_REASON = 'creating a goal is disabled in this deployment; do not retry, and continue without a goal'

/**
 * Validate configuration even when `apply` is called directly outside Loader
 * normalization.
 * @param config - the plugin configuration, which may be absent entirely.
 * @returns the effective policy.
 */
export function resolvePolicy(config) {
  if (config === undefined || config === null) return 'ask'
  if (typeof config !== 'object') throw new TypeError('goal-create-ask-guard config must be an object')
  const policy = config.policy ?? 'ask'
  if (!POLICIES.includes(policy)) {
    throw new TypeError(`policy must be one of ${POLICIES.join(', ')}`)
  }
  return policy
}

/**
 * Whether the execution targets a top-level agent, i.e. one whose goal tools can
 * reach the domain at all. Without an agent registry the answer is unknown, and
 * an unknown is treated as a root agent: gating a call that did not need it only
 * costs a prompt, while skipping one that did need it would defeat the plugin.
 * @param ctx - the plugin context.
 * @param exec - the execution under decision.
 * @returns whether this execution belongs to a root agent.
 */
export function isRootAgent(ctx, exec) {
  const agents = ctx.get('agents')
  if (agents === undefined) return true
  return agents.roots().includes(exec.agent)
}

/**
 * Decide one execution. `pass` means "this plugin has no opinion", which the
 * caller turns back into the waterfall's `next()`.
 * @param ctx - the plugin context.
 * @param exec - the execution under decision.
 * @param policy - the validated effective policy.
 * @returns a `pass` marker or a decision to return.
 */
export function decide(ctx, exec, policy) {
  if (exec.name !== GUARDED_TOOL) return { kind: 'pass' }
  if (policy === 'allow') return { kind: 'pass' }
  if (exec.agent === undefined) return { kind: 'pass' }
  if (!isRootAgent(ctx, exec)) return { kind: 'pass' }
  if (policy === 'deny') return { kind: 'deny', reason: DENY_REASON }
  return { kind: 'ask', reason: ASK_REASON, displayReason: DISPLAY_REASON }
}

/**
 * Register the pre-execute decision for `create_goal`.
 * @param ctx - the plugin context.
 * @param config - `{ policy?: 'ask' | 'allow' | 'deny' }`, defaulting to `ask`.
 */
export function apply(ctx, config) {
  const policy = resolvePolicy(config)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decide(ctx, exec, policy)
    if (decision.kind === 'pass') return next()
    return decision
  })
}

export default { name, inject, apply }
