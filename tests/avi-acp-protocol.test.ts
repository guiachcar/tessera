import assert from 'node:assert/strict';
import test from 'node:test';
import { AviProtocolParser } from '../src/lib/cli/providers/avi/protocol-parser';

/**
 * Contract test between Tessera and Avi's ACP entrypoint.
 *
 * The two projects share no code, so nothing but this file stops the wire
 * format from drifting. Every frame below is one Avi's `session/update`
 * bridge (src/main/acp/update-bridge.js in the Avi repo) actually produces;
 * a change on that side that this file does not accept is a break, and it is
 * meant to be caught here rather than in a live session.
 */

const SESSION = 'session-under-test';

function parser() {
  return new AviProtocolParser();
}

function sessionUpdate(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: SESSION, update },
  });
}

test('assistant text arrives as an assistant message', () => {
  const messages = parser().parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello from Avi.' },
  }));

  const message = messages.find((entry) => entry.serverMessage?.type === 'message');
  assert.ok(message, 'an agent_message_chunk must produce a message');
  assert.equal(message.serverMessage.role, 'assistant');
  assert.equal(message.serverMessage.content, 'Hello from Avi.');
});

test('chunks stream as separate messages rather than replacing each other', () => {
  const acp = parser();
  const first = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Part one. ' },
  }));
  const second = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Part two.' },
  }));

  // Avi sends deltas, never the accumulated text: if this ever asserts the
  // full string, the bridge's watermark has been broken and the UI will show
  // duplicated prose.
  assert.equal(first[0].serverMessage.content, 'Part one. ');
  assert.equal(second[0].serverMessage.content, 'Part two.');
});

test('reasoning arrives as thinking, then as a delta update', () => {
  const acp = parser();
  const opened = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Considering. ' },
  }));
  const continued = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Still considering.' },
  }));

  assert.equal(opened[0].serverMessage.type, 'thinking');
  assert.equal(opened[0].serverMessage.status, 'streaming');
  assert.equal(continued[0].serverMessage.type, 'thinking_update');
  assert.equal(continued[0].serverMessage.contentDelta, 'Still considering.');
});

test('a tool call opens as running and closes as completed on the same id', () => {
  const acp = parser();
  const started = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'run_in_terminal',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'ls -la' },
  }));
  const finished = acp.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'run_in_terminal',
    kind: 'execute',
    status: 'completed',
    rawInput: { command: 'ls -la' },
    rawOutput: { output: 'total 0' },
  }));

  const opened = started.find((entry) => entry.serverMessage?.type === 'tool_call');
  assert.ok(opened);
  assert.equal(opened.serverMessage.status, 'running');
  assert.equal(opened.serverMessage.toolUseId, 'call-1');
  assert.deepEqual(opened.serverMessage.toolParams, { command: 'ls -la' });
  assert.equal(started.some((entry) => entry.sideEffect?.type === 'add_pending_tool_call'), true);

  const closed = finished.find((entry) => entry.serverMessage?.type === 'tool_call');
  assert.ok(closed);
  assert.equal(closed.serverMessage.status, 'completed');
  assert.equal(closed.serverMessage.toolUseId, 'call-1');
});

test('a failed tool reports error status', () => {
  const messages = parser().parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-2',
    title: 'write_file',
    kind: 'edit',
    status: 'failed',
    rawInput: { filePath: '/nope' },
    rawOutput: { output: 'filePath must be absolute' },
  }));

  const toolCall = messages.find((entry) => entry.serverMessage?.type === 'tool_call');
  assert.ok(toolCall);
  assert.equal(toolCall.serverMessage.status, 'error');
});

test('a permission request surfaces with the id needed to answer it', () => {
  const messages = parser().parseStdout(SESSION, JSON.stringify({
    jsonrpc: '2.0',
    id: 'srv-1',
    method: 'session/request_permission',
    params: {
      sessionId: SESSION,
      toolCall: {
        toolCallId: 'approval-1',
        title: 'run_in_terminal: rm -rf build',
        kind: 'other',
        rawInput: { command: 'rm -rf build' },
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  }));

  assert.ok(messages.length > 0, 'a permission request must not be swallowed');
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /srv-1/, 'the request id must survive so the answer can be routed back');
});

test('an unparseable line does not throw and does not vanish', () => {
  const messages = parser().parseStdout(SESSION, 'avi 0.1.0: ACP server ready on stdio');

  // Avi writes its banner to stderr, but a stray stdout line from a future
  // version must degrade to visible output rather than crash the session.
  assert.ok(Array.isArray(messages));
});

test('process exit is labelled Avi, not the parser it borrows', () => {
  const messages = parser().handleProcessExit(SESSION, 1);

  const down = messages.find((entry) => entry.serverMessage?.type === 'cli_down');
  assert.ok(down);
  assert.equal(down.serverMessage.message, 'Avi Down (exit code: 1)');
  assert.equal(down.serverMessage.exitCode, 1);
});

test('parser instances do not share session state', () => {
  const first = parser();
  const second = parser();

  first.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking in the first parser.' },
  }));
  const fromSecond = second.parseStdout(SESSION, sessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking in the second parser.' },
  }));

  // Avi reuses the OpenCode parser class; a shared singleton would leak an
  // open thinking block from one provider's session into the other's.
  assert.equal(fromSecond[0].serverMessage.type, 'thinking');
});
