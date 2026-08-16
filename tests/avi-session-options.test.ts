import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAviSessionOptions, parseAviModels } from '../src/lib/cli/provider-session-options-avi';

/**
 * Contract test for `avi models --json`.
 *
 * The Avi binary owns this payload; nothing but this file catches a rename on
 * that side before it reaches the model picker. The fixture below is a real
 * `avi models --json` entry, trimmed.
 */

const REAL_OUTPUT = JSON.stringify([
  {
    id: 'openai-subscription:gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    providerName: 'OpenAI Subscription',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextInput: 272000,
    images: true,
    isDefault: true,
  },
  {
    id: 'openai-subscription:gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    providerName: 'OpenAI Subscription',
    reasoning: ['low', 'high'],
    contextInput: 272000,
    images: true,
    isDefault: false,
  },
]);

test('models parse with their own reasoning levels', () => {
  const models = parseAviModels(REAL_OUTPUT);

  assert.equal(models.length, 2);
  assert.equal(models[0].value, 'openai-subscription:gpt-5.6-sol');
  assert.equal(models[0].label, 'GPT-5.6 Sol');
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(
    models[0].supportedReasoningEfforts.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  // Per-model, not global: sending a level the model rejects fails the turn.
  assert.deepEqual(
    models[1].supportedReasoningEfforts.map((effort) => effort.value),
    ['low', 'high'],
  );
});

test('the preselected effort is always one the model accepts', () => {
  const models = parseAviModels(REAL_OUTPUT);

  assert.equal(models[0].defaultReasoningEffort, 'high');
  for (const model of models) {
    const offered = model.supportedReasoningEfforts.map((effort) => effort.value);
    assert.ok(
      offered.includes(model.defaultReasoningEffort as string),
      `${model.value} preselects ${model.defaultReasoningEffort}, which it does not accept`,
    );
  }
});

test('a model without reasoning levels offers none', () => {
  const models = parseAviModels(JSON.stringify([
    { id: 'ollama:llama3', name: 'Llama 3', reasoning: [] },
  ]));

  assert.equal(models.length, 1);
  assert.deepEqual(models[0].supportedReasoningEfforts, []);
  assert.equal(models[0].defaultReasoningEffort, null);
});

test('the first model is the default when the payload does not say', () => {
  const models = parseAviModels(JSON.stringify([
    { id: 'a:one', name: 'One' },
    { id: 'b:two', name: 'Two' },
  ]));

  assert.equal(models[0].isDefault, true);
  assert.equal(models[1].isDefault, false);
});

test('entries without an id are dropped, not rendered blank', () => {
  const models = parseAviModels(JSON.stringify([
    { name: 'Nameless' },
    { id: '   ' },
    { id: 'ok:model', name: 'Fine' },
  ]));

  assert.deepEqual(models.map((model) => model.value), ['ok:model']);
});

test('a broken or empty probe yields no models rather than throwing', () => {
  // What a missing binary or a signed-out install produces. Offering models
  // here would let the picker propose something the session then fails on.
  assert.deepEqual(parseAviModels(''), []);
  assert.deepEqual(parseAviModels('No models configured. Run `avi login`.'), []);
  assert.deepEqual(parseAviModels('{"not":"an array"}'), []);
});

test('access options exclude the mode Avi cannot honour', () => {
  const options = buildAviSessionOptions(parseAviModels(REAL_OUTPUT));
  const values = options.accessOptions.map((option) => option.value);

  assert.deepEqual(values, ['default', 'acceptEdits', 'bypassPermissions']);
  // Avi cannot block a call without prompting, so offering "Don't Ask" would
  // silently downgrade to something weaker than the label promises.
  assert.equal(values.includes('dontAsk'), false);
});

test('reasoning support follows the models actually present', () => {
  assert.equal(buildAviSessionOptions(parseAviModels(REAL_OUTPUT)).supportsReasoningEffort, true);
  assert.equal(buildAviSessionOptions([]).supportsReasoningEffort, false);
});
