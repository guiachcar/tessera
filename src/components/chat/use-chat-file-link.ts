"use client";

import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  getSessionWorkspaceRootPath,
  parseLocalFileHref,
  toRelativeWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { useChatSessionId } from "./chat-session-context";

/**
 * Decide whether a chat text fragment refers to a workspace file and produce
 * the workspace-relative path the file API expects. Absolute paths must live
 * inside the session workspace; relative candidates need a slash or a file
 * extension so ordinary prose stays unlinked.
 */
export function resolveChatWorkspaceRelativePath(
  raw: string | null | undefined,
  workDir: string | null,
): string | null {
  if (!raw) return null;
  let text = raw.trim().replace(/\\/g, "/");
  if (!text || text.length > 300) return null;
  if (/[\s`"']/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^file:/i.test(text) && !/^[a-z]:\//i.test(text)) {
    return null;
  }

  // \\wsl.localhost\<distro>\home\... → /home/... so it can be relativized
  // against the session's WSL display root.
  const wslUncMatch = /^\/\/wsl(?:\$|\.localhost)\/[^/]+(\/.*)$/i.exec(text);
  if (wslUncMatch) text = wslUncMatch[1];

  const absolute = parseLocalFileHref(text);
  if (absolute) {
    const relative = toRelativeWorkspacePath(workDir, absolute);
    return relative || null;
  }

  if (text.endsWith("/")) return null;
  if (text.split("/").includes("..")) return null;
  if (!text.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(text)) return null;

  const cleaned = text.replace(/^\.\//, "").replace(/^\/+/, "");
  return cleaned || null;
}

/** File-path parameter of a file-oriented tool call, when present. */
export function getToolCallFilePathParam(
  toolName: string,
  toolKind: string | undefined,
  toolParams: Record<string, unknown> | undefined,
): string | null {
  const isFileTool = toolKind === "file_read"
    || toolKind === "file_edit"
    || toolKind === "file_write"
    || ["read", "edit", "write", "write_file", "notebookedit", "multiedit"].includes(toolName.toLowerCase());
  if (!isFileTool) return null;
  const candidate = [toolParams?.file_path, toolParams?.notebook_path, toolParams?.path]
    .find((value): value is string => typeof value === "string");
  return candidate ?? null;
}

export interface ChatWorkspaceFileTarget {
  relativePath: string;
  preview: () => void;
  openPinned: () => void;
}

/** Hook form: resolves a candidate against the surrounding chat session. */
export function useChatWorkspaceFileTarget(
  raw: string | null | undefined,
): ChatWorkspaceFileTarget | null {
  const sessionId = useChatSessionId();
  const workDir = useSessionStore((state) =>
    sessionId ? getSessionWorkspaceRootPath(state.getSession(sessionId)) : null,
  );
  const relativePath = resolveChatWorkspaceRelativePath(raw, workDir);

  const preview = useCallback(() => {
    if (sessionId && relativePath) previewWorkspaceFileTab(sessionId, "file", relativePath);
  }, [relativePath, sessionId]);
  const openPinned = useCallback(() => {
    if (sessionId && relativePath) openWorkspaceFileTab(sessionId, "file", relativePath);
  }, [relativePath, sessionId]);

  if (!sessionId || !relativePath) return null;
  return { relativePath, preview, openPinned };
}
