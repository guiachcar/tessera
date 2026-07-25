import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ZaiAdapter,
  ZAI_ANTHROPIC_BASE_URL,
  appendZaiWslEnv,
  resolveZaiApiKey,
} from '../src/lib/cli/providers/zai/adapter';

test('zai adapter identity and default command', () => {
  const adapter = new ZaiAdapter();
  assert.equal(adapter.getProviderId(), 'zai');
  assert.equal(adapter.getDisplayName(), 'Z.ai GLM');
});

test('zai inherits the claude stream-json spawn args including --model', () => {
  const adapter = new ZaiAdapter();
  const args = adapter.getCliArgs({ sessionId: 'abc', model: 'glm-5.2' });

  assert.ok(args.includes('--print'));
  assert.ok(args.includes('stream-json'));
  const modelIndex = args.indexOf('--model');
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], 'glm-5.2');
  const sessionIndex = args.indexOf('--session-id');
  assert.equal(args[sessionIndex + 1], 'abc');
});

test('zai spawn env redirects to the Z.ai endpoint and never leaks the Anthropic key', () => {
  const adapter = new ZaiAdapter();
  const previous = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'test-key-123';
  try {
    const overrides = (adapter as unknown as {
      buildSpawnEnvOverrides(): Record<string, string | undefined>;
    }).buildSpawnEnvOverrides();

    assert.equal(overrides.ANTHROPIC_BASE_URL, ZAI_ANTHROPIC_BASE_URL);
    assert.equal(overrides.ANTHROPIC_AUTH_TOKEN, 'test-key-123');
    assert.ok('ANTHROPIC_API_KEY' in overrides);
    assert.equal(overrides.ANTHROPIC_API_KEY, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = previous;
    }
  }
});

test('resolveZaiApiKey trims and defaults to empty', () => {
  assert.equal(resolveZaiApiKey({ ZAI_API_KEY: '  abc  ' } as NodeJS.ProcessEnv), 'abc');
  assert.equal(resolveZaiApiKey({} as NodeJS.ProcessEnv), '');
});

test('WSLENV gains the Z.ai vars without duplicating existing entries', () => {
  assert.equal(
    appendZaiWslEnv(undefined),
    'ANTHROPIC_BASE_URL/u:ANTHROPIC_AUTH_TOKEN/u:API_TIMEOUT_MS/u',
  );
  assert.equal(
    appendZaiWslEnv('FOO/p:ANTHROPIC_BASE_URL/u'),
    'FOO/p:ANTHROPIC_BASE_URL/u:ANTHROPIC_AUTH_TOKEN/u:API_TIMEOUT_MS/u',
  );
});
