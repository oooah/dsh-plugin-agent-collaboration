/**
 * A stop belongs to ONE run, and a bot session's approval belongs to US.
 *
 * Both rules came out of the same incident. A follow-up message arrived while the bot was
 * mid-turn; the follow-up's own budget expired while it waited on the pair's mutex, its stop
 * cancelled the OTHER run's in-flight request, and the approval dialog that run was sitting on
 * came back as `cancelled` — with nothing in the transcript explaining any of it.
 *
 * The rules are pure functions so they can be pinned without a host: which run a stop may reach,
 * and which session ids the approval bridge must claim.
 *
 * Run with: node --test tests/stop-scope.test.ts  (Node runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stopReachesTurn } from '../packages/core/agent-community/src/session-runner.ts'
import { ApprovalBridge } from '../packages/core/agent-community/src/approval-bridge.ts'

test('a stop reaches only the run that owns the pair\'s live turn', () => {
  assert.equal(stopReachesTurn('run-a', 'run-a'), true)
  // The waiter's stop must leave the owner alone — this is the collateral-cancel bug.
  assert.equal(stopReachesTurn('run-a', 'run-b'), false)
  // Nobody owns the turn (it is between runs): a run-scoped stop has nothing to cancel.
  assert.equal(stopReachesTurn(undefined, 'run-b'), false)
})

test('a stop with no run id means "whatever this pair is doing"', () => {
  assert.equal(stopReachesTurn('run-a', undefined), true)
  assert.equal(stopReachesTurn(undefined, undefined), true)
})

test('the approval bridge claims every bot-owned session id, table or no table', () => {
  // `roomAgentSessions` can be missing an entry (restored generation, rewritten table); the id
  // itself carries the mapping, so the bridge must still take the dialog. Without this it fell
  // through to the native approval UI, which has no surface for a hidden bot session — the turn
  // then hung until something else cancelled it.
  assert.deepEqual(
    ApprovalBridge.parseBotSession('ac:74fa8a7e-641d-494c-9abe-3c15572e8d5f:9dd15f10-95ba-4963-af9b-2491f1619500'),
    {
      roomId: '74fa8a7e-641d-494c-9abe-3c15572e8d5f',
      botId: '9dd15f10-95ba-4963-af9b-2491f1619500',
    },
  )
})

test('a cleared room\'s generation suffix is not part of the bot id', () => {
  assert.deepEqual(
    ApprovalBridge.parseBotSession('ac:room-1:bot-1:g7'),
    { roomId: 'room-1', botId: 'bot-1' },
  )
})

test('sessions this plugin does not own are left to the host', () => {
  for (const id of ['session-45b3c67d', '', 'ac', 'ac:', 'sub:abc']) {
    assert.equal(ApprovalBridge.parseBotSession(id), undefined, id)
  }
})
