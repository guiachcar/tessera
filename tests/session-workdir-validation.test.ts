import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSessionWorkDir } from '../src/lib/session/session-persistence';

// Session creation auto-registers the resolved workDir as a project. A junk
// workDir (filesystem root, nonexistent path, a file) used to become a
// visible junk project with an empty/garbage name in the sidebar — e.g. an
// agent-created session with workDir '/' registered the root as a project.

test('rejects the filesystem root', () => {
  assert.match(validateSessionWorkDir('/') ?? '', /filesystem root/);
});

test('rejects nonexistent directories', () => {
  assert.match(validateSessionWorkDir('/no/such/place-xyz-123') ?? '', /does not exist/);
});

test('rejects a plain file as workDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wd-'));
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'x');
  assert.match(validateSessionWorkDir(file) ?? '', /not a directory/);
});

test('accepts a real directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wd-'));
  assert.equal(validateSessionWorkDir(dir), null);
});
