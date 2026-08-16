import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZaiSessionOptions,
  ZAI_MODEL_OPTIONS,
} from '../src/lib/cli/provider-session-options-zai';

/**
 * The Z.ai model list is hand-maintained (no CLI probe — the claude binary has
 * no knowledge of the endpoint), so these assertions are the only thing that
 * catches a stale catalog after Z.ai ships a new flagship. The ids must match
 * the ones served by GET https://api.z.ai/api/paas/v4/models.
 */

test('zai catalog exposes the current GLM lineup', () => {
  assert.deepEqual(
    ZAI_MODEL_OPTIONS.map((option) => option.value),
    ['glm-5.3', 'glm-5.2', 'glm-4.7'],
  );
});

test('glm-5.3 is the single default model', () => {
  const defaults = ZAI_MODEL_OPTIONS.filter((option) => option.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].value, 'glm-5.3');
});

test('no GLM model advertises reasoning effort', () => {
  const options = buildZaiSessionOptions();
  assert.equal(options.supportsReasoningEffort, false);
  for (const model of options.modelOptions) {
    assert.equal(model.defaultReasoningEffort, null);
    assert.deepEqual(model.supportedReasoningEfforts, []);
  }
});
