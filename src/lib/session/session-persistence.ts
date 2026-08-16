import path from 'path';
import fs from 'fs';
import * as dbProjects from '../db/projects';
import * as dbSessions from '../db/sessions';
import type { AgentExecutionMode } from './agent-execution-mode';

/**
 * Validates a session workDir before it can auto-register a project.
 * Session creation auto-registers resolvedWorkDir as a project, so garbage
 * input (filesystem root, nonexistent paths, placeholders passed by agents
 * via the API) becomes a visible junk project with an empty/garbage name.
 * Returns an error message, or null when the dir is acceptable.
 */
export function validateSessionWorkDir(workDir: string): string | null {
  const root = path.parse(workDir).root;
  if (workDir === root) {
    return `workDir must not be the filesystem root (${root})`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workDir);
  } catch {
    return `workDir does not exist: ${workDir}`;
  }
  if (!stat.isDirectory()) {
    return `workDir is not a directory: ${workDir}`;
  }
  return null;
}

interface PersistCreatedSessionRecordOptions {
  collectionId?: string;
  hasCustomTitle?: boolean;
  parentProjectId?: string;
  providerId: string;
  resolvedWorkDir: string;
  sessionId: string;
  taskId?: string;
  parentSessionId?: string | null;
  title: string;
  executionMode: AgentExecutionMode;
  /**
   * Explicit session kind. 'orchestrator' is a Tessera-wide meta chat (MCP
   * self-server injected at spawn). When absent, kind is derived from
   * executionMode ('pty' → 'terminal', else default 'chat').
   */
  sessionKind?: 'orchestrator';
  worktreeBranch?: string;
  worktreeManaged?: boolean;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  providerState?: string | null;
}

interface PersistedSessionProject {
  decodedPath: string;
  displayName: string;
  projectId: string;
}

function resolveSessionProject({
  parentProjectId,
  resolvedWorkDir,
}: Pick<PersistCreatedSessionRecordOptions, 'parentProjectId' | 'resolvedWorkDir'>): PersistedSessionProject {
  if (parentProjectId) {
    const parent = dbProjects.getProject(parentProjectId);
    return {
      projectId: parentProjectId,
      decodedPath: parent?.decoded_path || resolvedWorkDir,
      displayName: parent?.display_name || path.basename(resolvedWorkDir) || resolvedWorkDir,
    };
  }

  return {
    projectId: resolvedWorkDir,
    decodedPath: resolvedWorkDir,
    // basename of root-ish paths is '' — never let a project go nameless.
    displayName: path.basename(resolvedWorkDir) || resolvedWorkDir,
  };
}

export function persistCreatedSessionRecord(
  options: PersistCreatedSessionRecordOptions,
): PersistedSessionProject {
  const project = resolveSessionProject(options);

  dbProjects.registerProject(project.projectId, project.decodedPath, project.displayName);

  dbSessions.createSession(
    options.sessionId,
    project.projectId,
    options.title,
    options.providerId,
    {
      workDir: options.resolvedWorkDir,
      worktreeManaged: options.worktreeManaged,
      taskId: options.taskId,
      collectionId: options.collectionId,
      parentSessionId: options.parentSessionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      providerState: options.providerState,
    },
  );

  if (options.sessionKind === 'orchestrator') {
    dbSessions.updateSession(options.sessionId, {
      provider_state: JSON.stringify({ kind: 'orchestrator' }),
    });
  } else if (options.executionMode === 'pty') {
    dbSessions.updateSession(options.sessionId, {
      provider_state: JSON.stringify({ kind: 'terminal' }),
    });
  }

  if (options.hasCustomTitle === true) {
    dbSessions.updateSession(
      options.sessionId,
      { has_custom_title: 1 },
      { skipTimestamp: true },
    );
  }

  if (options.worktreeBranch) {
    dbSessions.updateSession(options.sessionId, {
      worktree_branch: options.worktreeBranch,
      worktree_managed: options.worktreeManaged ? 1 : 0,
    });
  }

  return project;
}
