import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFixedPort } from '../electron/port-config';

// TESSERA_PORT pins the embedded Electron server to a single port so external
// links (e.g. tailscale serve, phone bookmarks) stay stable across restarts.
// Unset keeps the default port-scan behavior; invalid values must fail loudly
// instead of silently falling back to a different port.

test('unset TESSERA_PORT returns null (keeps port-scan behavior)', () => {
  assert.equal(parseFixedPort(undefined), null);
});

test('empty or whitespace-only TESSERA_PORT returns null', () => {
  assert.equal(parseFixedPort(''), null);
  assert.equal(parseFixedPort('   '), null);
});

test('valid TESSERA_PORT is returned as a number', () => {
  assert.equal(parseFixedPort('32123'), 32123);
  assert.equal(parseFixedPort(' 8080 '), 8080);
  assert.equal(parseFixedPort('1'), 1);
  assert.equal(parseFixedPort('65535'), 65535);
});

test('non-numeric TESSERA_PORT throws', () => {
  assert.throws(() => parseFixedPort('abc'), /TESSERA_PORT/);
  assert.throws(() => parseFixedPort('32123abc'), /TESSERA_PORT/);
});

test('out-of-range or fractional TESSERA_PORT throws', () => {
  assert.throws(() => parseFixedPort('0'), /TESSERA_PORT/);
  assert.throws(() => parseFixedPort('65536'), /TESSERA_PORT/);
  assert.throws(() => parseFixedPort('-1'), /TESSERA_PORT/);
  assert.throws(() => parseFixedPort('3000.5'), /TESSERA_PORT/);
});
