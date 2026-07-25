"use client";

import {
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { setWorkspaceFileDragData } from "@/lib/dnd/panel-session-drag";
import {
  copyText,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import type { WorkspaceTreeNode } from "@/lib/workspace-files/file-tree";
import { cn } from "@/lib/utils";

interface PathContextMenuState {
  absolutePath: string;
  canOpenFile: boolean;
  position: { x: number; y: number };
}

export function WorkspaceFileTree({
  nodes,
  sessionId,
  workDir,
  forceExpanded = false,
}: {
  nodes: WorkspaceTreeNode[];
  sessionId: string | null;
  workDir: string | null;
  /** Expands every directory (used while a search filter is active). */
  forceExpanded?: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<PathContextMenuState | null>(null);

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderTreeNode(node: WorkspaceTreeNode, depth: number): ReactNode {
    const paddingLeft = 8 + depth * 12;

    if (node.type === "directory") {
      const expanded = forceExpanded || expandedPaths.has(node.path);
      const FolderIcon = expanded ? FolderOpen : Folder;
      const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);
      return (
        <div key={`dir:${node.path}`} className="flex flex-col">
          <button
            type="button"
            onClick={() => toggleDirectory(node.path)}
            onContextMenu={(event) => {
              if (!absolutePath) return;
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                absolutePath,
                canOpenFile: true,
                position: { x: event.clientX, y: event.clientY },
              });
            }}
            className="group flex min-w-0 items-center gap-1.5 border-l-2 border-l-transparent py-1.5 pr-2 text-left text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            style={{ paddingLeft }}
            title={node.path}
            aria-expanded={expanded}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-(--text-muted) transition-transform",
                expanded && "rotate-90",
              )}
            />
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {node.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-(--text-muted) tabular-nums">
              {node.fileCount}
            </span>
          </button>
          {expanded ? node.children.map((child) => renderTreeNode(child, depth + 1)) : null}
        </div>
      );
    }

    const isSelected = node.path === selectedPath;
    const absolutePath = toAbsoluteWorkspacePath(workDir, node.path);

    return (
      <div
        key={`file:${node.path}`}
        className={cn(
          "group relative border-l-2 transition-colors",
          isSelected
            ? "border-l-(--accent) bg-(--accent)/10 text-(--text-primary)"
            : "border-l-transparent text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
        )}
        style={{ paddingLeft: paddingLeft + 19 }}
        onContextMenu={(event) => {
          if (!absolutePath) return;
          event.preventDefault();
          event.stopPropagation();
          setSelectedPath(node.path);
          setContextMenu({
            absolutePath,
            canOpenFile: true,
            position: { x: event.clientX, y: event.clientY },
          });
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            previewWorkspaceFileTab(sessionId, "file", node.path);
          }}
          onDoubleClick={() => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            openWorkspaceFileTab(sessionId, "file", node.path);
          }}
          onDragStart={(event) => {
            if (!sessionId) return;
            setSelectedPath(node.path);
            setWorkspaceFileDragData(event.dataTransfer, sessionId, "file", node.path);
          }}
          draggable={Boolean(sessionId)}
          className="flex min-w-0 items-center gap-2 border-l-transparent py-1.5 pr-2 text-left transition-colors"
          title={node.path}
          data-testid={`workspace-file-row-${node.path}`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-(--text-muted) group-hover:text-(--text-primary)" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {node.name}
          </span>
        </button>
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-(--sidebar-hover)/95 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Tooltip content="Copy absolute path">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (!absolutePath || !node.path) return;
                copyText(absolutePath);
              }}
              disabled={!absolutePath}
              className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35"
              aria-label={`Copy absolute path for ${absolutePath || node.path}`}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {nodes.map((node) => renderTreeNode(node, 0))}
      {contextMenu ? (
        <WorkspaceFileContextMenu
          absolutePath={contextMenu.absolutePath}
          canOpenFile={contextMenu.canOpenFile}
          onClose={() => setContextMenu(null)}
          position={contextMenu.position}
        />
      ) : null}
    </div>
  );
}
