import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFileTree,
  type WorkspaceDirectoryNode,
} from '../src/lib/workspace-files/file-tree';

test('buildFileTree groups files under nested directories', () => {
  const tree = buildFileTree([
    'src/app/page.tsx',
    'src/lib/utils.ts',
    'README.md',
  ]);

  assert.equal(tree.length, 2);
  const [srcDir, readme] = tree;
  assert.equal(srcDir.type, 'directory');
  assert.equal(srcDir.name, 'src');
  assert.equal(readme.type, 'file');
  assert.equal(readme.name, 'README.md');

  const src = srcDir as WorkspaceDirectoryNode;
  assert.deepEqual(
    src.children.map((child) => child.name),
    ['app', 'lib'],
  );
  const appDir = src.children[0] as WorkspaceDirectoryNode;
  assert.equal(appDir.path, 'src/app');
  assert.equal(appDir.children[0]?.name, 'page.tsx');
});

test('buildFileTree sorts directories before files, both naturally', () => {
  const tree = buildFileTree([
    'zeta.ts',
    'file10.ts',
    'file2.ts',
    'alpha/inner.ts',
  ]);

  assert.deepEqual(
    tree.map((node) => `${node.type}:${node.name}`),
    ['directory:alpha', 'file:file2.ts', 'file:file10.ts', 'file:zeta.ts'],
  );
});

test('buildFileTree counts files recursively per directory', () => {
  const tree = buildFileTree([
    'src/a.ts',
    'src/deep/b.ts',
    'src/deep/deeper/c.ts',
  ]);

  const src = tree[0] as WorkspaceDirectoryNode;
  assert.equal(src.fileCount, 3);
  const deep = src.children[0] as WorkspaceDirectoryNode;
  assert.equal(deep.fileCount, 2);
});

test('buildFileTree ignores empty and slash-only paths', () => {
  const tree = buildFileTree(['', '/', 'ok.ts']);
  assert.deepEqual(tree.map((node) => node.name), ['ok.ts']);
});
