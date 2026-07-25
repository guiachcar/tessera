"use client";

import {
  AlertCircle,
  FolderTree,
  LoaderCircle,
  Maximize2,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import {
  useDocumentVisibility,
  useStableWorkspaceFilesSubscriberId,
  useWorkspaceFilesLiveSync,
} from "@/hooks/use-workspace-files-live-sync";
import { useWorkspaceFileList } from "@/hooks/use-workspace-file-list";
import { openWorkspaceExplorerTab } from "@/lib/workspace-tabs/open-workspace-tab";
import { WorkspaceFileTree } from "@/components/workspace/workspace-file-tree";
import { buildFileTree } from "@/lib/workspace-files/file-tree";

function EmptyState({
  title,
  body,
  icon = "file",
}: {
  title: string;
  body: string;
  icon?: "file" | "error";
}) {
  const Icon = icon === "error" ? AlertCircle : FolderTree;
  return (
    <div className="flex h-full items-center justify-center p-5">
      <div className="max-w-[240px] text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-(--divider) bg-(--sidebar-hover)">
          <Icon className="h-5 w-5 text-(--text-muted)" />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">
          {title}
        </p>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {body}
        </p>
      </div>
    </div>
  );
}

export function WorkspaceFilePanel({ sessionId }: { sessionId: string | null }) {
  const isDocumentVisible = useDocumentVisibility();
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-file-panel");
  const [query, setQuery] = useState("");
  const {
    error,
    files,
    loading,
    refreshFiles,
    truncated,
    workDir,
  } = useWorkspaceFileList(sessionId);

  useWorkspaceFilesLiveSync({
    enabled: Boolean(sessionId) && isDocumentVisible,
    onRefresh: refreshFiles,
    sessionId,
    subscriberId,
  });

  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files
      .filter((filePath) => filePath.toLowerCase().includes(trimmed));
  }, [files, query]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const isSearching = query.trim().length > 0;

  if (!sessionId) {
    return (
      <EmptyState
        title="No worktree selected"
        body="Select a session with a workspace to browse files."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-(--chat-header-border) px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <FolderTree className="h-4 w-4 shrink-0 text-(--text-muted)" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-(--text-primary)">
                Files
              </p>
              <p className="truncate text-[11px] text-(--text-muted)">
                {files.length.toLocaleString()} files
                {truncated ? " · truncated" : ""}
              </p>
            </div>
          </div>
          <Tooltip content="Open as tab">
            <button
              type="button"
              onClick={() => openWorkspaceExplorerTab(sessionId)}
              className="inline-flex shrink-0 rounded-md p-1.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              aria-label="Open file explorer as tab"
              data-testid="workspace-file-panel-expand"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-(--input-border) bg-(--chat-bg) px-2.5 focus-within:border-(--accent)">
          <Search className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            className="min-w-0 flex-1 bg-transparent text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted)"
          />
        </label>
      </div>

      {loading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : error ? (
        <EmptyState title="Files unavailable" body={error} icon="error" />
      ) : fileTree.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No matches" : "No files"}
          body={query.trim() ? "Try another search." : "This workspace has no readable files."}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] uppercase tracking-[0.18em] text-(--text-muted)">
              Workspace files
            </span>
            <span className="font-mono text-[11px] text-(--text-muted) tabular-nums">
              {visibleFiles.length.toLocaleString()}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <WorkspaceFileTree
              key={sessionId}
              nodes={fileTree}
              sessionId={sessionId}
              workDir={workDir}
              forceExpanded={isSearching}
            />
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
