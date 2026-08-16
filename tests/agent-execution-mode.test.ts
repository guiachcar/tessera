import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import {
  getProviderExecutionCapabilities,
  resolveEffectiveExecutionMode,
} from '@/lib/session/agent-execution-mode';
import { useSettingsStore } from '@/stores/settings-store';

test('new installations prefer PTY execution', () => {
  assert.equal(normalizeUserSettings({}).agentExecutionMode, 'pty');
});

test('Claude Code, Codex, and OpenCode can use either execution mode', () => {
  for (const providerId of ['claude-code', 'codex', 'opencode']) {
    assert.deepEqual(getProviderExecutionCapabilities(providerId), {
      pty: true,
      gui: true,
    });
    const capabilities = getProviderExecutionCapabilities(providerId);
    assert.equal(resolveEffectiveExecutionMode('gui', capabilities), 'gui');
    assert.equal(resolveEffectiveExecutionMode('pty', capabilities), 'pty');
  }
});

test('every registered provider declares at least one usable execution mode', () => {
  // A provider missing from the capability map falls back to {pty:false,
  // gui:false}, which the launcher reads as "unsupported" and refuses — the
  // click does nothing and no request reaches the server. Adding a provider
  // without adding it here is silent, so the list is asserted explicitly.
  for (const providerId of ['claude-code', 'codex', 'opencode', 'kimi', 'zai', 'avi']) {
    const capabilities = getProviderExecutionCapabilities(providerId);
    assert.ok(
      capabilities.pty || capabilities.gui,
      `${providerId} declares no usable execution mode`,
    );
  }
});

test('Kimi Code, Z.ai GLM, and Avi use structured GUI chat', () => {
  for (const providerId of ['kimi', 'zai', 'avi']) {
    const capabilities = getProviderExecutionCapabilities(providerId);
    assert.deepEqual(capabilities, {
      pty: false,
      gui: true,
    });
    assert.equal(resolveEffectiveExecutionMode('gui', capabilities), 'gui');
    assert.equal(resolveEffectiveExecutionMode('pty', capabilities), 'gui');
  }
});

test('an explicitly PTY-only provider falls back from GUI preference to PTY', () => {
  assert.equal(
    resolveEffectiveExecutionMode('gui', { pty: true, gui: false }),
    'pty',
  );
});

test('a GUI-only provider falls back from PTY preference to GUI', () => {
  assert.equal(
    resolveEffectiveExecutionMode('pty', { pty: false, gui: true }),
    'gui',
  );
});

test('unknown providers do not advertise an execution mode', () => {
  assert.deepEqual(getProviderExecutionCapabilities('future-agent'), {
    pty: false,
    gui: false,
  });
});

test('invalid persisted execution modes normalize to the PTY default', () => {
  assert.equal(
    normalizeUserSettings({ agentExecutionMode: 'unknown' as never }).agentExecutionMode,
    'pty',
  );
});

test('settings cannot close while an execution-mode save is pending', () => {
  const previous = useSettingsStore.getState();
  try {
    useSettingsStore.setState({ isOpen: true, pendingSaveCount: 1 });
    useSettingsStore.getState().close();
    assert.equal(useSettingsStore.getState().isOpen, true);

    useSettingsStore.setState({ pendingSaveCount: 0 });
    useSettingsStore.getState().close();
    assert.equal(useSettingsStore.getState().isOpen, false);
  } finally {
    useSettingsStore.setState({
      isOpen: previous.isOpen,
      pendingSaveCount: previous.pendingSaveCount,
    });
  }
});
