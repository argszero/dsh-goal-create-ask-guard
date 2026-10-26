import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  decide,
  isRootAgent,
  resolvePolicy,
  ASK_REASON,
  DENY_REASON,
  DISPLAY_REASON,
  GUARDED_TOOL,
  POLICIES,
} from '../lib/index.js'

/** A context double exposing only `get` and `on`, the two surfaces the guard uses. */
function fakeContext(services = {}) {
  const listeners = []
  return {
    listeners,
    get: name => services[name],
    on(event, listener) { listeners.push({ event, listener }) },
  }
}

const agent = { id: 'a' }
const exec = (overrides = {}) => ({ name: GUARDED_TOOL, agent, callId: 'c1', ...overrides })

test('policy defaults to ask and rejects an unknown value', () => {
  assert.equal(resolvePolicy(undefined), 'ask')
  assert.equal(resolvePolicy(null), 'ask')
  assert.equal(resolvePolicy({}), 'ask')
  assert.equal(resolvePolicy({ policy: 'allow' }), 'allow')
  assert.equal(resolvePolicy({ policy: 'deny' }), 'deny')
  assert.throws(() => resolvePolicy({ policy: 'always' }), TypeError)
  assert.throws(() => resolvePolicy('ask'), TypeError)
})

test('every accepted policy is advertised', () => {
  assert.deepEqual(POLICIES, ['ask', 'allow', 'deny'])
})

test('ask is the decision for a root-agent create_goal, carrying a localized prompt', () => {
  const ctx = fakeContext()
  const decision = decide(ctx, exec(), 'ask')
  assert.equal(decision.kind, 'ask')
  assert.equal(decision.reason, ASK_REASON)
  assert.equal(decision.displayReason, DISPLAY_REASON)
  assert.equal(typeof decision.displayReason.en, 'string')
  assert.equal(typeof decision.displayReason.zh, 'string')
})

test('deny is the decision under the deny policy', () => {
  const ctx = fakeContext()
  const decision = decide(ctx, exec(), 'deny')
  assert.deepEqual(decision, { kind: 'deny', reason: DENY_REASON })
})

test('allow is not a decision: the guard stands down entirely', () => {
  const ctx = fakeContext()
  assert.deepEqual(decide(ctx, exec(), 'allow'), { kind: 'pass' })
})

test('every other tool passes through untouched', () => {
  const ctx = fakeContext()
  for (const name of ['get_goal', 'update_goal', 'bash', 'read']) {
    assert.deepEqual(decide(ctx, exec({ name }), 'ask'), { kind: 'pass' })
  }
})

test('an execution with no agent passes through: there is nobody to route an ask to', () => {
  const ctx = fakeContext()
  assert.deepEqual(decide(ctx, exec({ agent: undefined }), 'ask'), { kind: 'pass' })
})

test('a non-root agent passes through so the core can refuse it without spending a prompt', () => {
  const child = { id: 'child' }
  const root = { id: 'root' }
  const ctx = fakeContext({ agents: { roots: () => [root] } })
  assert.equal(isRootAgent(ctx, exec({ agent: root })), true)
  assert.equal(isRootAgent(ctx, exec({ agent: child })), false)
  assert.deepEqual(decide(ctx, exec({ agent: child }), 'ask'), { kind: 'pass' })
})

test('without an agent registry the root check is unknown and therefore gates', () => {
  const ctx = fakeContext()
  assert.equal(isRootAgent(ctx, exec()), true)
  assert.equal(decide(ctx, exec(), 'ask').kind, 'ask')
})

test('apply registers exactly one pre-execute listener that returns next() or a decision', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.equal(ctx.listeners.length, 1)
  const { event, listener } = ctx.listeners[0]
  assert.equal(event, 'tools/pre-execute')

  let forwarded = 0
  const next = () => { forwarded += 1; return Promise.resolve({ kind: 'allow' }) }

  const passthrough = await listener(exec({ name: 'get_goal' }), next)
  assert.deepEqual(passthrough, { kind: 'allow' })
  assert.equal(forwarded, 1)

  const asked = await listener(exec(), next)
  assert.equal(asked.kind, 'ask')
  assert.equal(forwarded, 1)
})

test('apply validates its config at mount time', () => {
  assert.throws(() => apply(fakeContext(), { policy: 'sometimes' }), TypeError)
})
