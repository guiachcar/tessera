import assert from 'node:assert/strict';
import test from 'node:test';
import { KimiProtocolParser, extractKimiToolName, parseKimiToolArguments } from '../src/lib/cli/providers/kimi/protocol-parser';
import {
  normalizeKimiAccessMode,
  normalizeKimiThinkingEffort,
  resolveKimiModeId,
} from '../src/lib/cli/providers/kimi/session-config';

const SESSION_ID = 'session-1';

function sessionUpdate(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'kimi-abc', update },
  });
}

test('agent_message_chunk becomes an assistant message', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello from Kimi' },
  }));

  assert.equal(messages.length, 1);
  const serverMessage = messages[0].serverMessage;
  assert.ok(serverMessage && serverMessage.type === 'message');
  assert.equal(serverMessage.role, 'assistant');
  assert.equal(serverMessage.content, 'Hello from Kimi');
});

test('agent_thought_chunk opens a thinking stream and a later message closes it', () => {
  const parser = new KimiProtocolParser();
  const thinking = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'pondering...' },
  }));
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].serverMessage?.type, 'thinking');

  const message = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'done' },
  }));
  assert.equal(message.length, 2);
  const closure = message[0].serverMessage;
  assert.ok(closure && closure.type === 'thinking_update');
  assert.equal(closure.status, 'completed');
});

test('tool_call start registers a pending tool call with parsed arguments', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'turn-1/call-1',
    title: 'shell: ls -la',
    status: 'in_progress',
    content: [{
      type: 'content',
      content: { type: 'text', text: '{"command": "ls -la"}' },
    }],
  }));

  assert.equal(messages.length, 1);
  const toolCall = messages[0].serverMessage;
  assert.ok(toolCall && toolCall.type === 'tool_call');
  assert.equal(toolCall.toolName, 'shell');
  assert.equal(toolCall.status, 'running');
  assert.deepEqual(toolCall.toolParams, { command: 'ls -la' });
  assert.equal(messages[0].sideEffect?.type, 'add_pending_tool_call');
});

test('tool_call_update completion emits output and clears pending state', () => {
  const parser = new KimiProtocolParser();
  parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'turn-1/call-1',
    title: 'shell: ls',
    status: 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: '{"command": "ls"}' } }],
  }));

  const messages = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'turn-1/call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file-a\nfile-b' } }],
  }));

  const toolCall = messages[0].serverMessage;
  assert.ok(toolCall && toolCall.type === 'tool_call');
  assert.equal(toolCall.status, 'completed');
  assert.equal(toolCall.toolName, 'shell');
  assert.equal(toolCall.output, 'file-a\nfile-b');
  // Completed args stay from the pending snapshot, not the output content.
  assert.deepEqual(toolCall.toolParams, { command: 'ls' });
  const sideEffects = messages.map((message) => message.sideEffect?.type).filter(Boolean);
  assert.deepEqual(sideEffects, ['remove_pending_tool_call', 'remove_pending_permission_request']);
});

test('session/request_permission emits an interactive prompt and pending request', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 12,
    method: 'session/request_permission',
    params: {
      sessionId: 'kimi-abc',
      toolCall: {
        toolCallId: 'turn-1/call-9',
        title: 'shell: rm -rf build',
        content: [{ type: 'content', content: { type: 'text', text: '{"command": "rm -rf build"}' } }],
      },
      options: [
        { optionId: 'approve', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  }));

  const prompt = messages.find((message) => message.serverMessage?.type === 'interactive_prompt');
  assert.ok(prompt);
  assert.equal(prompt.sideEffect?.type, 'add_pending_permission_request');
  assert.equal((prompt.sideEffect as { requestId?: string }).requestId, '12');
  assert.equal((prompt.sideEffect as { toolName?: string }).toolName, 'shell');
});

test('permission option ids are captured from the request and consumed once', () => {
  const parser = new KimiProtocolParser();
  parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 21,
    method: 'session/request_permission',
    params: {
      toolCall: { toolCallId: 'turn-2/call-1', title: 'edit_file: src/a.ts' },
      options: [
        { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'approve_always', name: 'Approve always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  }));

  const optionIds = parser.consumePermissionOptionIds(SESSION_ID, '21');
  assert.deepEqual(optionIds, { accept: 'approve_once', decline: 'reject' });
  assert.equal(parser.consumePermissionOptionIds(SESSION_ID, '21'), undefined);
});

test('plan-style permission prompts resolve their custom option ids', () => {
  const parser = new KimiProtocolParser();
  parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 30,
    method: 'session/request_permission',
    params: {
      toolCall: { toolCallId: 'turn-3/plan', title: 'Approve plan' },
      options: [
        { optionId: 'plan_approve', name: 'Approve', kind: 'allow_once' },
        { optionId: 'plan_reject_and_exit', name: 'Reject', kind: 'reject_once' },
      ],
    },
  }));

  const optionIds = parser.consumePermissionOptionIds(SESSION_ID, '30');
  assert.deepEqual(optionIds, { accept: 'plan_approve', decline: 'plan_reject_and_exit' });
});

test('session/prompt completion emits notification and generation side effects', () => {
  const parser = new KimiProtocolParser();
  parser.trackPendingRequest(SESSION_ID, 3, 'session/prompt');
  parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'All done.' },
  }));

  const messages = parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    result: { stopReason: 'end_turn' },
  }));

  const notification = messages.find((message) => message.serverMessage?.type === 'notification');
  assert.ok(notification && notification.serverMessage?.type === 'notification');
  assert.equal(notification.serverMessage.message, 'Task completed.');
  assert.equal(notification.serverMessage.preview, 'All done.');
  const sideEffects = messages.map((message) => message.sideEffect?.type).filter(Boolean);
  assert.deepEqual(sideEffects, ['set_generating', 'auto_generate_title']);
});

test('cancelled prompt reports a cancelled task', () => {
  const parser = new KimiProtocolParser();
  parser.trackPendingRequest(SESSION_ID, 4, 'session/prompt');
  const messages = parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    result: { stopReason: 'cancelled' },
  }));

  const notification = messages.find((message) => message.serverMessage?.type === 'notification');
  assert.ok(notification && notification.serverMessage?.type === 'notification');
  assert.equal(notification.serverMessage.message, 'Task cancelled.');
});

test('available_commands_update stores commands and notifies the client', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'init', description: 'Generate AGENTS.md' },
      { name: 'compact', description: 'Compact context' },
    ],
  }));

  assert.equal(messages[0].sideEffect?.type, 'store_commands');
  const ready = messages[1].serverMessage;
  assert.ok(ready && ready.type === 'commands_ready');
  assert.equal(ready.commands.length, 2);
});

test('plan updates snapshot todos as system info', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.parseStdout(SESSION_ID, sessionUpdate({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Explore repo', priority: 'medium', status: 'completed' },
      { content: 'Write fix', priority: 'medium', status: 'in_progress' },
    ],
  }));

  const info = messages.find((message) => message.serverMessage?.type === 'system');
  assert.ok(info && info.serverMessage?.type === 'system');
  assert.equal(info.serverMessage.subtype, 'kimi_plan_update');
  assert.deepEqual(info.serverMessage.metadata?.entries, [
    { content: 'Explore repo', status: 'completed' },
    { content: 'Write fix', status: 'in_progress' },
  ]);
});

test('JSON-RPC error responses surface as error messages', () => {
  const parser = new KimiProtocolParser();
  parser.trackPendingRequest(SESSION_ID, 7, 'session/prompt');
  const messages = parser.parseStdout(SESSION_ID, JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32000, message: 'Authentication required' },
  }));

  const error = messages[0].serverMessage;
  assert.ok(error && error.type === 'error');
  assert.equal(error.message, 'Authentication required');
});

test('process exit clears state and reports cli_down', () => {
  const parser = new KimiProtocolParser();
  const messages = parser.handleProcessExit(SESSION_ID, 1);
  assert.equal(messages[0].serverMessage?.type, 'cli_down');
});

test('extractKimiToolName strips the subtitle', () => {
  assert.equal(extractKimiToolName('shell: ls -la'), 'shell');
  assert.equal(extractKimiToolName('search_web'), 'search_web');
  assert.equal(extractKimiToolName(''), 'Tool');
  assert.equal(extractKimiToolName(undefined), 'Tool');
});

test('parseKimiToolArguments tolerates partial streaming JSON', () => {
  assert.deepEqual(parseKimiToolArguments([{ type: 'content', content: { type: 'text', text: '{"a": 1}' } }]), { a: 1 });
  assert.deepEqual(parseKimiToolArguments([{ type: 'content', content: { type: 'text', text: '{"a": ' } }]), {});
  assert.deepEqual(parseKimiToolArguments(undefined), {});
});

test('tessera session controls map to kimi ACP mode ids', () => {
  assert.equal(resolveKimiModeId('plan', 'default'), 'plan');
  assert.equal(resolveKimiModeId('plan', 'bypassPermissions'), 'plan');
  assert.equal(resolveKimiModeId('work', 'default'), 'default');
  assert.equal(resolveKimiModeId('work', 'bypassPermissions'), 'yolo');
  assert.equal(resolveKimiModeId('work', 'auto'), 'auto');
  assert.equal(resolveKimiModeId(undefined, undefined), 'default');
});

test('kimi access mode and thinking normalization reject unknown values', () => {
  assert.equal(normalizeKimiAccessMode('auto'), 'auto');
  assert.equal(normalizeKimiAccessMode('acceptEdits'), undefined);
  assert.equal(normalizeKimiThinkingEffort('max'), 'max');
  assert.equal(normalizeKimiThinkingEffort('ultracode'), undefined);
  assert.equal(normalizeKimiThinkingEffort(null), undefined);
});
