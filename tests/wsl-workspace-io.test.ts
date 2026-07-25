import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listWorkspaceFilesViaWsl,
  resolveWslWorkspaceRelativePath,
  shouldUseWslWorkspaceIo,
  WorkspaceWslIoError,
} from '../src/lib/workspace-files/wsl-workspace-io';

test('resolveWslWorkspaceRelativePath normalizes and blocks escapes', () => {
  assert.equal(resolveWslWorkspaceRelativePath('src/app/page.tsx'), 'src/app/page.tsx');
  assert.equal(resolveWslWorkspaceRelativePath('src\\app\\page.tsx'), 'src/app/page.tsx');
  assert.equal(resolveWslWorkspaceRelativePath('./a/../b.txt'), 'b.txt');
  assert.throws(() => resolveWslWorkspaceRelativePath('../outside.txt'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath('a/../../outside.txt'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath('/etc/passwd'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath(''), WorkspaceWslIoError);
});

test('shouldUseWslWorkspaceIo is false outside a Windows host', () => {
  // This suite runs on Linux/WSL where the server accesses files natively.
  assert.equal(shouldUseWslWorkspaceIo('/home/user/project', '/home/user/project'), false);
});

test('listWorkspaceFilesViaWsl lists files with canonical pruning', async () => {
  // On non-Windows hosts spawnCli degrades to a native spawn, so this
  // exercises the exact find invocation used in production.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-io-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'x');
  fs.writeFileSync(path.join(tmp, 'README.md'), 'x');
  fs.writeFileSync(path.join(tmp, '.env'), 'secret');
  fs.writeFileSync(path.join(tmp, '.env.example'), 'x');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'ignored.js'), 'x');
  fs.writeFileSync(path.join(tmp, '.git', 'config'), 'x');

  const result = await listWorkspaceFilesViaWsl(tmp);
  assert.deepEqual(result.files, ['.env.example', 'README.md', 'src/index.ts']);
  assert.equal(result.truncated, false);
});
