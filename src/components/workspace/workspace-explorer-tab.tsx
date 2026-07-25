"use client";

import { AlertCircle, FolderTree, LoaderCircle, Search } from "lucide-react";
import { useContext, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useDocumentVisibility,
  useStableWorkspaceFilesSubscriberId,
  useWorkspaceFilesLiveSync,
} from "@/hooks/use-workspace-files-live-sync";
import { useWorkspaceFileList } from "@/hooks/use-workspace-file-list";
import { WorkspaceFileTree } from "@/components/workspace/workspace-file-tree";
import { buildFileTree } from "@/lib/workspace-files/file-tree";
import type { WorkspaceExplorerSessionRef } from "@/lib/workspace-tabs/special-session";
import { TabIdContext } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";

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
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-(--divider) bg-(--sidebar-hover)">
          <Icon className="h-5 w-5 text-(--text-muted)" />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">{title}</p>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">{body}</p>
      </div>
    </div>
  );
}

export function WorkspaceExplorerTab({
  explorerRef,
}: {
  explorerRef: WorkspaceExplorerSessionRef;
}) {
  const tabId = useContext(TabIdContext);
  const isTabActive = useTabStore((state) => state.activeTabId === tabId);
  const isDocumentVisible = useDocumentVisibility();
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-explorer-tab");
  const [query, setQuery] = useState("");
  const {
    error,
    files,
    loading,
    refreshFiles,
    truncated,
    workDir,
  } = useWorkspaceFileList(explorerRef.sourceSessionId);

  useWorkspaceFilesLiveSync({
    enabled: isTabActive && isDocumentVisible,
    onRefresh: refreshFiles,
    sessionId: explorerRef.sourceSessionId,
    subscriberId,
  });

  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files.filter((filePath) => filePath.toLowerCase().includes(trimmed));
  }, [files, query]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const isSearching = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <div className="shrink-0 border-b border-(--chat-header-border) px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-(--text-muted)" />
              <h2 className="text-sm font-semibold text-(--text-primary)">Files</h2>
            </div>
            <p className="mt-1 text-xs text-(--text-muted)">
              {files.length.toLocaleString()} files
              {truncated ? " · truncated" : ""}
            </p>
          </div>
          <label className="flex h-9 w-[min(24rem,45vw)] items-center gap-2 rounded-md border border-(--input-border) bg-(--sidebar-bg) px-3 focus-within:border-(--accent)">
            <Search className="h-4 w-4 shrink-0 text-(--text-muted)" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="min-w-0 flex-1 bg-transparent text-sm text-(--text-primary) outline-none placeholder:text-(--text-muted)"
            />
          </label>
        </div>
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
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-5xl px-3 py-3">
            <WorkspaceFileTree
              key={explorerRef.sourceSessionId}
              nodes={fileTree}
              sessionId={explorerRef.sourceSessionId}
              workDir={workDir}
              forceExpanded={isSearching}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
