/**
 * c783 mount reading — the guard arrives as the artifact `dsh plugin add`
 * installed into a real profile, and is mounted by cordis rather than having
 * its `apply` called by hand.
 *
 * The profile is produced by the documented verb:
 *   dsh plugin --profile mount add github:argszero/dsh-goal-create-ask-guard
 * and `dsh --profile mount --dump-config` composes the entry
 * `- id: goal-create-ask-guard / name: '@argszero/dsh-goal-create-ask-guard'`
 * from that package's own cordis.patch.yml. This spec starts at the other end:
 * it imports the module that verb installed, mounts it the way the Loader
 * mounts an entry (`ctx.plugin`), and dispatches `create_goal` through the real
 * tool pipeline to observe the decision that mounted plugin produces.
 *
 * Everything else — tools runtime, native executor, the goal tool body, the
 * approval service, root agents — is the shipped implementation, unchanged
 * from c782's measurement.
 */
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The profile the documented verb created; overridable for a different run. */
const PROFILE_DIR = process.env['C783_PROFILE_DIR'] ?? ''
const INSTALLED_PKG = join(PROFILE_DIR, 'node_modules', '@argszero', 'dsh-goal-create-ask-guard')
const INSTALLED_ENTRY = join(INSTALLED_PKG, 'lib', 'index.js')

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
function stubAgent(rawId: string, suppliedCtx: Context): StubAgent {
  const session = suppliedCtx.sessions.create(SessionId(rawId))
  const inbox = createInboxStub()
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox,
    get status() { return status },
    ctx: suppliedCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, inbox }
}

/** Open one message-triggered turn carrying `text` from `source`. */
function openTurn(stub: StubAgent, source: MessageSource, text: string): number {
  const turn = stub.session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.inbox.splice('next-turn', 0, 1, [])
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  return turn
}

interface Harness {
  readonly ctx: Context
  readonly root: StubAgent
  readonly approvals: ApprovalRequest[]
}

/**
 * Assemble the shipped goal stack. `mount` decides how the guard arrives:
 * nothing (control), or the module installed in the profile.
 */
async function harness(options: {
  readonly mount?: { readonly plugin: unknown; readonly config: Record<string, unknown> }
  readonly withApproval?: boolean
  readonly answer?: () => Promise<ApprovalOutcome>
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(GoalService)
  await ctx.plugin(toolGoal)
  if (options.withApproval === true) await ctx.plugin(ApprovalService)
  if (options.mount !== undefined) {
    // The Loader's own mount call: a plugin object, its config — never `apply(...)` by hand.
    await ctx.plugin(options.mount.plugin as Parameters<Context['plugin']>[0], options.mount.config)
  }
  const approvals: ApprovalRequest[] = []
  if (options.answer !== undefined) {
    const answer = options.answer
    ctx.on('approval/request', (req) => {
      approvals.push(req)
      return answer()
    })
  }
  const root = stubAgent(`c783-mount-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, root, approvals }
}

/** Dispatch one tool call through the real pipeline. */
async function dispatch(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(agent, () => executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
}

/** The stable, comparable part of a goal view. */
function goalShape(goal: GoalView | undefined): Record<string, unknown> | null {
  if (goal === undefined) return null
  return {
    objective: goal.objective,
    phase: goal.phase,
    activation: goal.activation,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    revision: goal.revision,
  }
}

/** Count durable goal/change create events — proof the body did or did not run. */
function createEvents(session: Session): number {
  return session.snapshotEvents()
    .filter(event => event.type === 'goal/change' && (event.data as { operation?: string }).operation === 'create')
    .length
}

const CREATE_ARGS = { objective: 'prepare the conference submission', max_goal_rounds: 40 }
const writableString = (value: unknown): string => {
  expect(typeof value).toBe('string')
  return value as string
}
const HUMAN: MessageSource = { kind: 'user' }
const writes: Record<string, unknown> = {}

/** Load the module the documented verb installed, by its installed path. */
async function installedGuard(): Promise<unknown> {
  expect(existsSync(INSTALLED_ENTRY), `run the install verb first: ${INSTALLED_ENTRY} missing`).toBe(true)
  const module = await import(pathToFileURL(INSTALLED_ENTRY).href) as { default?: unknown }
  expect(module.default, 'the installed package must have a default export for the Loader to mount').toBeDefined()
  return module.default
}

describe('c783 mount reading: the installed artifact decides', () => {
  it('the installed manifest and its patch entry agree with what the module calls itself', async () => {
    const manifest = JSON.parse(readFileSync(join(INSTALLED_PKG, 'package.json'), 'utf8')) as {
      name: string
      version: string
      dsh?: { bundle?: { patch?: string } }
      peerDependencies?: Record<string, string>
    }
    const plugin = await installedGuard() as { name?: string; apply?: unknown }
    const patchPath = join(INSTALLED_PKG, writableString(manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml'))
    expect(existsSync(patchPath)).toBe(true)
    const patch = readFileSync(patchPath, 'utf8')
    // The composed entry names this package, so the patch cannot insert something else.
    expect(patch).toContain(manifest.name)
    expect(plugin.name).toBe(manifest.name)
    expect(typeof plugin.apply).toBe('function')
    writes.mount1 = {
      installedVersion: manifest.version,
      packageName: manifest.name,
      moduleName: plugin.name,
      peer: manifest.peerDependencies,
      patchEntry: patch.trim(),
    }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })

  it('control — with nothing mounted the model creates an active goal and it auto-continues', async () => {
    const { ctx, root, approvals } = await harness()
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    const goal = ctx.goals.get(root.agent)
    expect(goal?.phase).toBe('active')
    expect(goal?.activation).toBe('armed')
    expect(goal?.maxGoalRounds).toBe(40)
    expect(createEvents(root.session)).toBe(1)
    expect(approvals).toHaveLength(0)
    writes.controlUnguarded = { goal: goalShape(goal), isError: result.isError, approvalRequests: approvals.length }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })

  it('mounted with ask + a granting answerer: one approval carrying the guard reason, goal unchanged', async () => {
    const { ctx, root, approvals } = await harness({
      mount: { plugin: await installedGuard(), config: {} },
      withApproval: true,
      answer: () => Promise.resolve('allowed-once'),
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    const goal = ctx.goals.get(root.agent)
    const control = writes.controlUnguarded as { goal: unknown }
    expect(goalShape(goal)).toEqual(control.goal)
    expect(createEvents(root.session)).toBe(1)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.toolName).toBe('create_goal')
    // The reason text is this package's own constant: proof the mounted plugin spoke.
    expect(approvals[0]?.reason).toContain('automatic continuation loop')
    expect(approvals[0]?.displayReason?.en).toContain('create a goal')
    writes.mountedAsk = {
      decision: result.isError ? 'denied' : 'allowed',
      goal: goalShape(goal),
      approvalRequests: approvals.length,
      approvalReason: approvals[0]?.reason,
      displayReason: approvals[0]?.displayReason,
    }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })

  it('mounted with ask and no approval service at all: denied, and no goal is recorded', async () => {
    const { ctx, root, approvals } = await harness({
      mount: { plugin: await installedGuard(), config: {} },
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(true)
    expect(ctx.goals.get(root.agent)).toBeUndefined()
    expect(createEvents(root.session)).toBe(0)
    expect(approvals).toHaveLength(0)
    const text = JSON.stringify(result)
    // With no approval service the guard's own reason is what the model reads.
    expect(text).toContain('automatic continuation loop')
    writes.mountedNoService = { isError: result.isError, goal: null, createEvents: 0, text: text.slice(0, 240) }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })

  it('mounted with ask, approval service present but nobody answering: denied by the seam', async () => {
    const { ctx, root, approvals } = await harness({
      mount: { plugin: await installedGuard(), config: {} },
      withApproval: true,
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(true)
    expect(ctx.goals.get(root.agent)).toBeUndefined()
    expect(createEvents(root.session)).toBe(0)
    // The request is raised and never answered: unattributed, so no listener saw it either.
    expect(approvals).toHaveLength(0)
    const text = JSON.stringify(result)
    expect(text).toContain('requires approval, but no approval channel is available')
    writes.mountedNoAnswerer = { isError: result.isError, goal: null, createEvents: 0, approvalRequests: approvals.length, text: text.slice(0, 240) }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })

  it('mounted with allow: stands down, no approval, goal identical to the control', async () => {
    const { ctx, root, approvals } = await harness({
      mount: { plugin: await installedGuard(), config: { policy: 'allow' } },
      withApproval: true,
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    const control = writes.controlUnguarded as { goal: unknown }
    expect(goalShape(ctx.goals.get(root.agent))).toEqual(control.goal)
    expect(approvals).toHaveLength(0)
    writes.mountedAllow = { isError: result.isError, goal: goalShape(ctx.goals.get(root.agent)), approvalRequests: approvals.length }
    writeFileSync(join(PROFILE_DIR, '..', 'c783-mount.json'), JSON.stringify(writes, null, 2))
  })
})
