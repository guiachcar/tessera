import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { persistCreatedSessionRecord } from '@/lib/session/session-persistence';
import {
  broadcastSessionMutation,
  getOriginClientIdFromRequest,
} from '@/lib/ws/mutation-broadcast';

/**
 * POST /api/sessions/[id]/side-chat - Create a companion session bound to the
 * source session: same provider, project, and work_dir. The CLI spawns on the
 * first message, like any other session.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const { id: sessionId } = await params;
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session ID', code: 'invalid_session_id' },
      { status: 400 },
    );
  }

  const source = dbSessions.getSession(sessionId);
  if (!source || source.deleted) {
    return NextResponse.json(
      { error: 'Session not found', code: 'session_not_found' },
      { status: 404 },
    );
  }

  try {
    const sourceProject = source.project_id
      ? dbProjects.getProject(source.project_id)
      : undefined;
    const workDir =
      source.work_dir || sourceProject?.decoded_path || process.cwd();
    const title = `Side chat · ${source.title}`;

    const result = await sessionOrchestrator.createSession(auth.userId, {
      workDir,
      title,
      providerId: source.provider,
    });

    persistCreatedSessionRecord({
      sessionId: result.sessionId,
      resolvedWorkDir: workDir,
      title,
      executionMode: 'gui',
      providerId: source.provider,
      parentProjectId: source.project_id ?? undefined,
      parentSessionId: source.id,
      collectionId: source.collection_id ?? undefined,
      hasCustomTitle: true,
      model: source.model ?? undefined,
      reasoningEffort: source.reasoning_effort,
      serviceTier: source.service_tier,
    });

    broadcastSessionMutation(auth.userId, {
      kind: 'created',
      projectId: source.project_id ?? workDir,
      originClientId: getOriginClientIdFromRequest(request),
    });

    logger.info(
      { userId: auth.userId, sourceSessionId: source.id, sideChatSessionId: result.sessionId },
      'Side chat session created',
    );

    return NextResponse.json(
      {
        ...result,
        provider: source.provider,
        model: source.model ?? undefined,
        parentSessionId: source.id,
      },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create side chat';
    if (message.includes('Maximum session limit')) {
      return NextResponse.json(
        { error: 'Session limit exceeded', code: 'session_limit_reached' },
        { status: 429 },
      );
    }
    logger.error({ sessionId, error }, 'Failed to create side chat session');
    return NextResponse.json(
      { error: message, code: 'side_chat_failed' },
      { status: 500 },
    );
  }
}
