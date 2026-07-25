export interface WorkspaceFileNode {
  type: "file";
  name: string;
  path: string;
}

export interface WorkspaceDirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: WorkspaceTreeNode[];
  fileCount: number;
}

export type WorkspaceTreeNode = WorkspaceDirectoryNode | WorkspaceFileNode;

interface MutableDirectoryNode {
  name: string;
  path: string;
  directories: Map<string, MutableDirectoryNode>;
  files: WorkspaceFileNode[];
}

function createMutableDirectory(name: string, path: string): MutableDirectoryNode {
  return {
    name,
    path,
    directories: new Map(),
    files: [],
  };
}

function compareNodeNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function finalizeDirectory(node: MutableDirectoryNode): WorkspaceDirectoryNode {
  const directories = Array.from(node.directories.values())
    .map(finalizeDirectory)
    .sort((a, b) => compareNodeNames(a.name, b.name));
  const files = [...node.files].sort((a, b) => compareNodeNames(a.name, b.name));
  const children: WorkspaceTreeNode[] = [...directories, ...files];
  const fileCount = children.reduce((count, child) => {
    if (child.type === "file") return count + 1;
    return count + child.fileCount;
  }, 0);

  return {
    type: "directory",
    name: node.name,
    path: node.path,
    children,
    fileCount,
  };
}

export function buildFileTree(filePaths: string[]): WorkspaceTreeNode[] {
  const root = createMutableDirectory("", "");

  for (const filePath of filePaths) {
    const parts = filePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let directory = root;
    for (const part of parts) {
      const childPath = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = createMutableDirectory(part, childPath);
        directory.directories.set(part, child);
      }
      directory = child;
    }

    directory.files.push({
      type: "file",
      name: fileName,
      path: filePath,
    });
  }

  return finalizeDirectory(root).children;
}
