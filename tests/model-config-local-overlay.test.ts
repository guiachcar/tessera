import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Env must be set before the module under test resolves getTesseraDataPath.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-model-overlay-'));
process.env.TESSERA_DATA_DIR = tmp;
process.env.TESSERA_PRODUCTION_DB = '1';

import {
  __resetRemoteModelConfigForTests,
  ensureRemoteModelConfigLoaded,
  getClaudeModelOptions,
  mergeModelOptions,
} from '../src/lib/model-config/remote-config';
import type { ProviderModelOption } from '../src/lib/cli/provider-session-option-types';

const EFFORTS = [
  { value: 'auto', label: 'Auto', description: '' },
  { value: 'high', label: 'High', description: '' },
];

function model(value: string, extra: Partial<ProviderModelOption> = {}): ProviderModelOption {
  return {
    value,
    label: value,
    isDefault: false,
    supportedReasoningEfforts: EFFORTS,
    ...extra,
  };
}

test('mergeModelOptions appends new models and replaces same-value entries', () => {
  const remote = [model('claude-opus-4-8', { isDefault: true }), model('claude-fable-5')];
  const overlay = [
    model('claude-opus-5'),
    model('claude-fable-5', { description: 'override' }),
  ];

  const merged = mergeModelOptions(remote, overlay);
  assert.deepEqual(
    merged.map((m) => m.value),
    ['claude-opus-4-8', 'claude-fable-5', 'claude-opus-5'],
  );
  assert.equal(merged[1].description, 'override');
  assert.equal(merged[0].isDefault, true);
});

test('an overlay default clears remote defaults (single default survives)', () => {
  const remote = [model('claude-opus-4-8', { isDefault: true })];
  const overlay = [model('claude-opus-5', { isDefault: true })];

  const merged = mergeModelOptions(remote, overlay);
  assert.equal(merged.find((m) => m.value === 'claude-opus-4-8')?.isDefault, false);
  assert.equal(merged.find((m) => m.value === 'claude-opus-5')?.isDefault, true);
});

test('model-config.local.json is loaded and merged into getClaudeModelOptions', async () => {
  __resetRemoteModelConfigForTests();

  fs.writeFileSync(
    path.join(tmp, 'model-config.json'),
    JSON.stringify({
      version: 5,
      etag: 'W/"mc-5"',
      fetchedAt: new Date().toISOString(),
      models: [model('claude-opus-4-8', { isDefault: true })],
    }),
  );
  fs.writeFileSync(
    path.join(tmp, 'model-config.local.json'),
    JSON.stringify({ models: [model('claude-opus-5')] }),
  );

  await ensureRemoteModelConfigLoaded();
  const options = getClaudeModelOptions();
  assert.deepEqual(
    options.map((m) => m.value),
    ['claude-opus-4-8', 'claude-opus-5'],
  );
});

test('a malformed overlay is ignored without breaking the remote list', async () => {
  __resetRemoteModelConfigForTests();

  fs.writeFileSync(
    path.join(tmp, 'model-config.json'),
    JSON.stringify({
      version: 5,
      etag: null,
      fetchedAt: new Date().toISOString(),
      models: [model('claude-opus-4-8', { isDefault: true })],
    }),
  );
  fs.writeFileSync(path.join(tmp, 'model-config.local.json'), '{ broken json');

  await ensureRemoteModelConfigLoaded();
  assert.deepEqual(getClaudeModelOptions().map((m) => m.value), ['claude-opus-4-8']);
});
