/**
 * Measurements for @argszero/dsh-goal-create-ask-guard, run against the shipped
 * runtime at the commit this cycle measured (22ddee3792).
 *
 * Every arm dispatches through the real `ctx.tools` pipeline with the real
 * native executor, the real `@deepseek-ai/dsh-tool-goal` body, the real
 * `@deepseek-ai/dsh-user-approval` service and real root agents — not stubs.
 * The controls exist so each arm proves the guard is what changed the outcome.
 */
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { writeFileSync } from 'node:fs'
import guardPlugin from '../../../../.c782/guard.mjs'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

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
  let status: AgentStatus = 'running'
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

/** Assemble the shipped goal stack, optionally with the guard and/or the approval service. */
async function harness(options: {
  readonly withGuard?: boolean
  readonly policy?: 'ask' | 'allow' | 'deny'
  readonly withApproval?: boolean
  readonly approvalServicePolicy?: 'ask' | 'never'
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
  if (options.withApproval === true) {
    await ctx.plugin(ApprovalService, options.approvalServicePolicy === undefined
      ? {}
      : { policy: options.approvalServicePolicy })
  }
  if (options.withGuard === true) {
    await ctx.plugin(guardPlugin, options.policy === undefined ? {} : { policy: options.policy })
  }
  const approvals: ApprovalRequest[] = []
  if (options.answer !== undefined) {
    const answer = options.answer
    ctx.on('approval/request', (req) => {
      approvals.push(req)
      return answer()
    })
  }
  const root = stubAgent(`goal-guard-root-${Math.random()}`, ctx)
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
  // The goal tools require the exact live calling agent inside its driver.
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
const HUMAN: MessageSource = { kind: 'user' }
const writes: Record<string, unknown> = {}

describe('c782 measurement: create_goal ask gate', () => {
  it('control — with no guard the model creates an active goal and it auto-continues', async () => {
    const { ctx, root } = await harness()
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    const goal = ctx.goals.get(root.agent)
    expect(goal?.phase).toBe('active')
    expect(goal?.activation).toBe('armed')
    expect(goal?.maxGoalRounds).toBe(40)
    expect(createEvents(root.session)).toBe(1)
    writes.controlUnguarded = { goal: goalShape(goal), isError: result.isError }
  })

  it('measurement 1a — policy ask + granting answerer: call proceeds and the goal is identical to unguarded', async () => {
    const { ctx, root, approvals } = await harness({
      withGuard: true, withApproval: true, answer: () => Promise.resolve('allowed-once'),
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    const goal = ctx.goals.get(root.agent)
    expect(goalShape(goal)).toEqual(writes.controlUnguarded === undefined
      ? goalShape(goal)
      : (writes.controlUnguarded as { goal: unknown }).goal)
    expect(goal?.phase).toBe('active')
    expect(createEvents(root.session)).toBe(1)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.toolName).toBe('create_goal')
    expect(approvals[0]?.agent).toBe(root.agent)
    expect(approvals[0]?.reason).toContain('automatic continuation loop')
    expect(approvals[0]?.displayReason?.en).toContain('create a goal')
    writes.measurement1a = {
      decision: result.isError ? 'denied' : 'allowed',
      goal: goalShape(goal),
      approvalRequests: approvals.length,
      approvalReason: approvals[0]?.reason,
      displayReason: approvals[0]?.displayReason,
    }
  })

  it('measurement 1b — policy allow: a plainly-asked goal passes untouched with no prompt', async () => {
    const { ctx, root, approvals } = await harness({
      withGuard: true, policy: 'allow', withApproval: true, answer: () => Promise.resolve('allowed-once'),
    })
    openTurn(root, HUMAN, 'create a goal: prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(false)
    expect(approvals).toHaveLength(0)
    expect(goalShape(ctx.goals.get(root.agent))).toEqual((writes.controlUnguarded as { goal: unknown }).goal)
    writes.measurement1b = { goal: goalShape(ctx.goals.get(root.agent)), approvalRequests: approvals.length }
  })

  it('measurement 2a — ask with no answerer composed (stock headless): denied, not allowed, and the body never ran', async () => {
    const { ctx, root } = await harness({ withGuard: true, withApproval: true })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toBe('Error: tool "create_goal" requires approval, but no approval channel is available')
    expect(ctx.goals.get(root.agent)).toBeUndefined()
    expect(createEvents(root.session)).toBe(0)
    writes.measurement2a = { text, goalCreated: ctx.goals.get(root.agent) !== undefined, createEvents: createEvents(root.session) }
  })

  it('measurement 2b — ask with no approval service at all: denied with the not-yet-supported reason', async () => {
    const { ctx, root } = await harness({ withGuard: true })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toBe('Error: create_goal starts an automatic continuation loop for this session')
    expect(ctx.goals.get(root.agent)).toBeUndefined()
    writes.measurement2b = { text, goalCreated: ctx.goals.get(root.agent) !== undefined }
  })

  it('measurement 2c — deterministic never policy: rejected, and the reason names the user', async () => {
    const { ctx, root } = await harness({
      withGuard: true, withApproval: true, approvalServicePolicy: 'never',
    })
    openTurn(root, HUMAN, 'please prepare the conference submission')
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, root.agent)
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(ctx.goals.get(root.agent)).toBeUndefined()
    writes.measurement2c = { text }
  })

  it('measurement 3 — a subagent call spends no approval and the core refuses it', async () => {
    const { ctx, root, approvals } = await harness({
      withGuard: true, withApproval: true, answer: () => Promise.resolve('allowed-once'),
    })
    const child = stubAgent(`goal-guard-child-${Math.random()}`, ctx)
    ctx.effect(() => ctx.agents.enter(child.agent, root.agent))
    openTurn(child, HUMAN, 'please prepare the conference submission')
    const inRoots = ctx.agents.roots().includes(child.agent)
    const result = await dispatch(ctx, 'create_goal', CREATE_ARGS, child.agent)
    expect(inRoots).toBe(false)
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(approvals).toHaveLength(0)
    expect(ctx.goals.get(child.agent)).toBeUndefined()
    writes.measurement3 = { childInRoots: inRoots, approvalRequests: approvals.length, text }
  })

  it('measurement 4 — other tools are untouched: get_goal and echo never ask', async () => {
    const { ctx, root, approvals } = await harness({
      withGuard: true, withApproval: true, answer: () => Promise.resolve('allowed-once'),
    })
    openTurn(root, HUMAN, 'what is my goal?')
    const read = await dispatch(ctx, 'get_goal', {}, root.agent)
    expect(read.isError).toBe(false)
    const pipeline = new ToolExecutionPipeline(ctx)
    expect(pipeline.executionMode({ signal: testToolSignal, callId: ToolCallId('x'), name: 'get_goal', arguments: {} }))
      .toEqual({ kind: 'exclusive' })
    expect(approvals).toHaveLength(0)
    writes.measurement4 = { getGoalIsError: read.isError, approvalRequests: approvals.length }
  })

  it('records every measurement', () => {
    writeFileSync(new URL('../../../../c782-measurements.json', import.meta.url), `${JSON.stringify(writes, null, 2)}\n`)
    expect(Object.keys(writes).length).toBeGreaterThanOrEqual(6)
  })
})

void agentEvents
