import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeAdapter } from '../src/lib/cli/providers/claude-code/adapter';
import { ZaiAdapter } from '../src/lib/cli/providers/zai/adapter';

// Orchestrator sessions carry two extra SpawnOptions fields — mcpConfigPath
// (embedded Tessera MCP server) and appendSystemPrompt (maestro prompt) —
// that the Claude adapter must turn into CLI flags on every spawn. Regular
// sessions must see NO change in args (the previously hardcoded empty
// --append-system-prompt stays empty, and --mcp-config never appears).

test('regular spawn keeps the legacy args (no --mcp-config, empty system prompt)', () => {
  const adapter = new ClaudeCodeAdapter();
  const args = adapter.getCliArgs({ sessionId: 'abc', model: 'claude-opus-4-7' });

  assert.ok(!args.includes('--mcp-config'), 'regular sessions must not get an MCP config');
  const idx = args.indexOf('--append-system-prompt');
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], '', 'default append-system-prompt stays empty');
});

test('orchestrator spawn injects --mcp-config and --append-system-prompt', () => {
  const adapter = new ClaudeCodeAdapter();
  const args = adapter.getCliArgs({
    sessionId: 'abc',
    mcpConfigPath: '/home/u/.tessera/orchestrator-mcp.json',
    appendSystemPrompt: 'You are the Tessera Orchestrator',
  });

  const mcpIdx = args.indexOf('--mcp-config');
  assert.notEqual(mcpIdx, -1, '--mcp-config must be present');
  assert.equal(args[mcpIdx + 1], '/home/u/.tessera/orchestrator-mcp.json');

  const promptIdx = args.indexOf('--append-system-prompt');
  assert.notEqual(promptIdx, -1);
  assert.equal(args[promptIdx + 1], 'You are the Tessera Orchestrator');
});

test('orchestrator spawn on resume also carries the MCP flags', () => {
  const adapter = new ClaudeCodeAdapter();
  const args = adapter.getCliArgs({
    sessionId: 'abc',
    resume: true,
    mcpConfigPath: '/tmp/mcp.json',
    appendSystemPrompt: 'prompt',
  });

  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('--mcp-config'));
});

test('mcp injection never duplicates --settings or breaks effort settings merge', () => {
  const adapter = new ClaudeCodeAdapter();
  const args = adapter.getCliArgs({
    sessionId: 'abc',
    reasoningEffort: 'high',
    mcpConfigPath: '/tmp/mcp.json',
    appendSystemPrompt: 'prompt',
  });

  assert.equal(args.filter((a) => a === '--settings').length, 1, 'never pass --settings twice');
  assert.ok(args.includes('--mcp-config'));
});

test('zai inherits the orchestrator MCP injection from the Claude adapter', () => {
  const adapter = new ZaiAdapter();
  const args = adapter.getCliArgs({
    sessionId: 'abc',
    mcpConfigPath: '/tmp/mcp.json',
    appendSystemPrompt: 'prompt',
  });

  assert.ok(args.includes('--mcp-config'));
  const promptIdx = args.indexOf('--append-system-prompt');
  assert.equal(args[promptIdx + 1], 'prompt');
});
