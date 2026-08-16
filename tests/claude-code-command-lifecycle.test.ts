import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';

// Newer Claude Code CLIs emit top-level `command_lifecycle` stdout frames
// reporting each uuid-stamped message's terminal state
// (queued/started/completed). Tessera does not model them, so the parser must
// ignore them silently rather than fall through to the `default` branch and
// surface a generic "Unhandled Claude Code message type" warning in the chat
// transcript — same treatment as `rate_limit_event`.

const SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function systemWarnings(messages: ReturnType<typeof claudeCodeProtocolParser.parseStdout>) {
  return messages.filter((m) => m.serverMessage && (m.serverMessage as any).type === 'system');
}

test('command_lifecycle is ignored, not surfaced as an unhandled-type chat warning', () => {
  const line = JSON.stringify({
    type: 'command_lifecycle',
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000000',
    state: 'completed',
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);

  assert.equal(
    result.length,
    0,
    `command_lifecycle must produce no parsed messages; got: ${JSON.stringify(result)}`,
  );
  assert.equal(
    systemWarnings(result).length,
    0,
    'command_lifecycle must not emit a system warning to the chat',
  );
});
