"use client";

import type { MouseEvent, ReactNode } from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  getSessionWorkspaceRootPath,
  openFilePathOnHost,
  parseLocalFileHref,
  toRelativeWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { useChatSessionId } from "./chat-session-context";

/**
 * Anchor renderer shared by the chat markdown surfaces. Web URLs open in the
 * system browser as before. Local filesystem paths inside the session
 * workspace open as Tessera file tabs; paths outside it fall back to the host
 * (default app via Electron's shell) instead of being treated as navigation.
 */
export function MarkdownLink({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  const sessionId = useChatSessionId();
  const workDir = useSessionStore((state) =>
    sessionId ? getSessionWorkspaceRootPath(state.getSession(sessionId)) : null,
  );
  const filePath = parseLocalFileHref(href);
  const workspaceRelativePath = filePath ? toRelativeWorkspacePath(workDir, filePath) : null;

  if (filePath) {
    const opensInTab = Boolean(sessionId && workspaceRelativePath);
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (sessionId && workspaceRelativePath) {
        previewWorkspaceFileTab(sessionId, "file", workspaceRelativePath);
        return;
      }
      openFilePathOnHost(filePath);
    };
    const handleDoubleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!sessionId || !workspaceRelativePath) return;
      event.preventDefault();
      openWorkspaceFileTab(sessionId, "file", workspaceRelativePath);
    };
    return (
      <a
        href={href}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={className}
        title={opensInTab ? `Open ${workspaceRelativePath}` : filePath}
        data-file-link="true"
      >
        {children}
      </a>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
