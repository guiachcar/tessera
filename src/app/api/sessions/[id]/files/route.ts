import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { resolveSessionWorkspaceFilesystemRoot } from '@/lib/session/session-workspace-root';
import { workspaceFileWatchManager } from '@/lib/workspace-files/workspace-file-watch-manager';
import { walkWorkspaceFiles } from '@/lib/workspace-files/workspace-file-scan';

interface SessionRef {
  sessionId: string;
  title: string;
}

function listReferenceSessions(projectId: string, currentSessionId: string): {
  chats: SessionRef[];
  tasks: SessionRef[];
} {
  const rows = getDb().prepare(`
    SELECT id, title, task_id
    FROM sessions
    WHERE project_id = ?
      AND archived = 0
      AND deleted = 0
      AND id != ?
    ORDER BY updated_at DESC
  `).all(projectId, currentSessionId) as Array<{ id: string; title: string; task_id: string | null }>;

  const chats: SessionRef[] = [];
  const tasks: SessionRef[] = [];
  for (const r of rows) {
    const entry = { sessionId: r.id, title: r.title || '(generating title)' };
    if (r.task_id == null) chats.push(entry);
    else tasks.push(entry);
  }
  return { chats, tasks };
}

const LIST_DEADLINE_MS = 30_000;

// The walk cannot be cancelled, but the HTTP response must not hang with it —
// stalled network/FUSE/9P mounts otherwise keep the client spinner alive forever.
function withListDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('workspace_list_timeout'));
    }, LIST_DEADLINE_MS);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) {
    return auth.response;
  }

  const session = dbSessions.getSession(id);
  const projectId = session?.project_id ?? null;

  const refs = projectId ? listReferenceSessions(projectId, id) : { chats: [], tasks: [] };

  const root = await resolveSessionWorkspaceFilesystemRoot(id);
  if (!root) {
    return NextResponse.json({
      files: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'no-root',
      workDir: null,
    });
  }

  try {
    const stat = await withListDeadline(fs.stat(root));
    if (!stat.isDirectory()) {
      return NextResponse.json({
        files: [],
        chats: refs.chats,
        tasks: refs.tasks,
        truncated: false,
        reason: 'not-a-directory',
        workDir: root,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'workspace_list_timeout') {
      return jsonError('walk_timeout', 'The workspace filesystem did not respond in time', 504);
    }
    return NextResponse.json({
      files: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'unreadable',
      workDir: root,
    });
  }

  try {
    const result = await withListDeadline(
      Promise.resolve(workspaceFileWatchManager.ensureSnapshotForRoot(root))
        .then((snapshot) => snapshot ?? walkWorkspaceFiles(root)),
    );
    return NextResponse.json({
      files: result.files,
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: result.truncated,
      workDir: root,
    });
  } catch (error) {
    logger.warn({ error, sessionId: id, root }, 'Workspace file listing failed');
    if (error instanceof Error && error.message === 'workspace_list_timeout') {
      return jsonError('walk_timeout', 'The workspace filesystem did not respond in time', 504);
    }
    return jsonError('walk_failed', 'Could not list workspace files', 502);
  }
}
