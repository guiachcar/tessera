import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionWorkspaceRootPath,
  toRelativeWorkspacePath,
} from '../src/lib/workspace-tabs/file-path-actions';

test('toRelativeWorkspacePath strips POSIX workspace roots', () => {
  assert.equal(
    toRelativeWorkspacePath('/home/user/proj', '/home/user/proj/src/app.ts'),
    'src/app.ts',
  );
  assert.equal(toRelativeWorkspacePath('/home/user/proj/', '/home/user/proj/a.md'), 'a.md');
  assert.equal(toRelativeWorkspacePath('/home/user/proj', '/home/user/proj'), '');
});

test('toRelativeWorkspacePath rejects paths outside the workspace', () => {
  assert.equal(toRelativeWorkspacePath('/home/user/proj', '/home/user/other/x.ts'), null);
  // Prefix that is not a directory boundary must not match.
  assert.equal(toRelativeWorkspacePath('/home/user/proj', '/home/user/proj2/x.ts'), null);
  assert.equal(toRelativeWorkspacePath('', '/home/user/proj/x.ts'), null);
  assert.equal(toRelativeWorkspacePath('/home/user/proj', null), null);
});

test('toRelativeWorkspacePath handles Windows roots case-insensitively', () => {
  assert.equal(
    toRelativeWorkspacePath('C:\\Users\\Dev\\proj', 'c:/users/dev/proj/src/App.tsx'),
    'src/App.tsx',
  );
  assert.equal(
    toRelativeWorkspacePath('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\a.ts'),
    'a.ts',
  );
});

test('getSessionWorkspaceRootPath prefers workDir, falls back to absolute projectDir', () => {
  assert.equal(
    getSessionWorkspaceRootPath({ workDir: '/home/u/proj', projectDir: '/other' }),
    '/home/u/proj',
  );
  assert.equal(getSessionWorkspaceRootPath({ projectDir: '/home/u/proj' }), '/home/u/proj');
  assert.equal(getSessionWorkspaceRootPath({ projectDir: 'C:\\Users\\Dev\\proj' }), 'C:\\Users\\Dev\\proj');
  assert.equal(getSessionWorkspaceRootPath({ projectDir: 'encoded-name' }), null);
  assert.equal(getSessionWorkspaceRootPath(null), null);
});
