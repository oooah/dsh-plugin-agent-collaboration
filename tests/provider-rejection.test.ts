/**
 * A bot turn has to fail LOUDLY when the provider refuses the request itself.
 *
 * `providerFailure` is the only thing standing between "the provider said no" and "the model
 * chose not to speak": both end the turn as `turn/end` with `reason.kind === 'error'`, and the
 * second one is legitimate (the repair prompt handles it). Everything the host rejects BEFORE
 * network I/O belongs to the first group, and the one that bit us in the field was
 *
 *   provider "workbuddy" model "cn:deepseek-v4.1-flash" does not support reasoning effort "max"
 *
 * — a model that publishes no reasoning levels rejects ANY explicit level. It carries no HTTP
 * status, so a status-only pattern read it as an empty answer: every turn "completed" in ~20 ms,
 * the panel showed a grey「模型输出为空」notice, and nothing anywhere said the request had been
 * refused. These cases pin the classification that recovers the difference.
 *
 * Run with: node --test tests/provider-rejection.test.ts  (Node runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeProviderRejection } from '../packages/core/agent-community/src/session-runner.ts'

test('a configuration-level rejection counts as a provider rejection', () => {
  for (const message of [
    'provider "workbuddy" model "cn:deepseek-v4.1-flash" does not support reasoning effort "max"',
    'pi-ai provider "workbuddy" model "cn:deepseek-v4.1-flash" does not support reasoning effort "off"',
    'DeepSeek Messages does not support reasoning effort max',
    'UNSUPPORTED_REASONING_EFFORT',
  ]) {
    assert.equal(looksLikeProviderRejection(message), true, message)
  }
})

test('transport and auth failures stay reported', () => {
  for (const message of [
    'request failed: upstream returned 502',
    'HTTP 429 rate limited',
    'HTTP_500',
    'Unauthorized',
    'forbidden: invalid api key',
    'request timed out',
    'ECONNRESET',
    'fetch failed',
  ]) {
    assert.equal(looksLikeProviderRejection(message), true, message)
  }
})

test('a reasoning-only or stopped turn is NOT a request failure', () => {
  for (const message of [
    '',
    'agent-community: model produced no visible answer text (reasoning-only)',
    'aborted by the user',
    'turn blocked',
  ]) {
    assert.equal(looksLikeProviderRejection(message), false, message)
  }
})
