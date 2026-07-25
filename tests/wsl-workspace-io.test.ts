import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFindPruneArgs,
  listWorkspaceFilesViaWslUnc,
  resolveWslWorkspaceRelativePath,
  WorkspaceWslIoError,
} from '../src/lib/workspace-files/wsl-workspace-io';
import { IGNORED_WORKSPACE_DIR_NAMES } from '../src/lib/workspace-files/workspace-file-scan';

test('resolveWslWorkspaceRelativePath normalizes and blocks escapes', () => {
  assert.equal(resolveWslWorkspaceRelativePath('src/app/page.tsx'), 'src/app/page.tsx');
  assert.equal(resolveWslWorkspaceRelativePath('src\\app\\page.tsx'), 'src/app/page.tsx');
  assert.equal(resolveWslWorkspaceRelativePath('./a/../b.txt'), 'b.txt');
  assert.throws(() => resolveWslWorkspaceRelativePath('../outside.txt'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath('a/../../outside.txt'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath('/etc/passwd'), WorkspaceWslIoError);
  assert.throws(() => resolveWslWorkspaceRelativePath(''), WorkspaceWslIoError);
});

test('buildFindPruneArgs prunes exactly the always-ignored directory set', () => {
  const args = buildFindPruneArgs();
  for (const name of IGNORED_WORKSPACE_DIR_NAMES) {
    assert.ok(args.includes(name), `find prune missing ${name}`);
  }
  // Dotfiles must NOT be pruned wholesale — the client filters them.
  const nameValues = args.filter((_, i) => args[i - 1] === '-name');
  assert.ok(!nameValues.includes('.*'), 'find must not prune all dotfiles');
  assert.deepEqual(args.slice(-4), ['-o', '-type', 'f', '-print']);
});

test('listWorkspaceFilesViaWslUnc returns null for non-WSL roots', async () => {
  assert.equal(await listWorkspaceFilesViaWslUnc('/home/user/project'), null);
  assert.equal(await listWorkspaceFilesViaWslUnc('C:\\Users\\dev\\project'), null);
  assert.equal(await listWorkspaceFilesViaWslUnc('\\\\otherhost\\share\\dir'), null);
});
