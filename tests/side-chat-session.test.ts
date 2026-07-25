import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/lib/db/database';
import {
  createSession,
  getSession,
  mapSessionRowToApi,
} from '../src/lib/db/sessions';
import { persistCreatedSessionRecord } from '../src/lib/session/session-persistence';
import { formatSideChatPrompt } from '../src/lib/session/session-reference';

// Real sql.js round-trip: a side chat session records its parent link and
// inherits the parent's project + work_dir, so the sidebar and the workspace
// APIs resolve the same tree the main session is working on.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-side-chat-test-'));
process.env.TESSERA_DATA_DIR = tmp;
process.env.TESSERA_PRODUCTION_DB = '1';

test('parent_session_id persists through create → get → API mapping', async () => {
  await initDatabase();
  createSession('main-1', 'proj-1', 'Main', 'claude-code', {
    workDir: '/tmp/work',
  });
  createSession('side-1', 'proj-1', 'Side chat · Main', 'claude-code', {
    workDir: '/tmp/work',
    parentSessionId: 'main-1',
  });

  const row = getSession('side-1');
  assert.ok(row, 'side chat row should exist');
  assert.equal(row.parent_session_id, 'main-1');
  assert.equal(row.work_dir, '/tmp/work');

  const api = mapSessionRowToApi(row, new Set(), new Set());
  assert.equal(api.parentSessionId, 'main-1');
});

test('regular sessions expose no parentSessionId', async () => {
  await initDatabase();
  createSession('plain-1', 'proj-1', 'Plain', 'claude-code', {});
  const row = getSession('plain-1');
  assert.ok(row);
  assert.equal(row.parent_session_id, null);
  assert.equal(mapSessionRowToApi(row, new Set(), new Set()).parentSessionId, undefined);
});

test('persistCreatedSessionRecord forwards parentSessionId to the sessions table', async () => {
  await initDatabase();
  persistCreatedSessionRecord({
    sessionId: 'side-2',
    resolvedWorkDir: '/tmp/work',
    title: 'Side chat · Main',
    providerId: 'claude-code',
    parentSessionId: 'main-1',
    hasCustomTitle: true,
  });

  const row = getSession('side-2');
  assert.ok(row);
  assert.equal(row.parent_session_id, 'main-1');
  assert.equal(row.has_custom_title, 1);
});

test('side chat prompt references the export and forbids unrequested edits', () => {
  const prompt = formatSideChatPrompt('/tmp/exports/session.md');
  assert.ok(prompt.startsWith('[/tmp/exports/session.md]'));
  assert.match(prompt, /side chat/i);
  assert.match(prompt, /Do NOT edit files/);
});
