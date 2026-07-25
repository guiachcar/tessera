/**
 * Kimi Code CLI Protocol Parser (ACP)
 *
 * Parses JSON-RPC 2.0 lines emitted by `kimi acp` into Tessera ParsedMessages.
 * Kimi speaks the Agent Client Protocol (the same protocol OpenCode uses), with
 * a smaller surface:
 *  - session/update notifications: user_message_chunk, agent_message_chunk,
 *    agent_thought_chunk, tool_call, tool_call_update, plan,
 *    available_commands_update
 *  - server request: session/request_permission (options approve /
 *    approve_for_session / reject)
 *  - responses to client requests (session/prompt completion carries only a
 *    stopReason — Kimi reports no token usage over ACP)
 *
 * Kimi tool_call updates carry no rawInput/kind: the tool name rides the title
 * ("ToolName: subtitle") and the streaming JSON arguments ride content text
 * blocks. This parser is PURE — side effects are described on ParsedMessage and
 * executed by the caller.
 */

import { randomUUID } from 'crypto';
import type { ParsedMessage } from '../types';
import logger from '@/lib/logger';
import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';
import { buildToolDisplay } from '@/lib/tool-display';
import type { TodoItem } from '@/types/cli-jsonl-schemas';
import type { ContentBlock, ImageContentBlock } from '@/lib/ws/message-types';

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: number | string;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number | string;
}

interface PendingRequest {
  method: string;
  startedAtMs: number;
}

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  startedAtMs: number;
}

interface PermissionOptionIds {
  accept: string;
  decline: string;
}

interface SessionState {
  pendingRequests: Map<number | string, PendingRequest>;
  pendingToolCalls: Map<string, PendingToolCall>;
  permissionOptionIds: Map<string, PermissionOptionIds>;
  accumulatedText: string;
  activeThinkingId: string | null;
  lastTodoSnapshots: TodoItem[];
}

const MAX_ACCUMULATED_TEXT_LENGTH = 100;
const DISPLAY_ONLY_KIMI_SESSION_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'current_mode_update',
  'plan',
  'user_message_chunk',
]);

export class KimiProtocolParser {
  private sessionStates = new Map<string, SessionState>();

  parseStdout(sessionId: string, line: string): ParsedMessage[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn('Kimi: non-JSON stdout line, emitting as raw message', {
        sessionId,
        line: trimmed.substring(0, 120),
      });
      return [{
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: trimmed,
        },
      }];
    }

    const hasMethod = typeof parsed.method === 'string';
    const hasId = 'id' in parsed;

    if (hasId && hasMethod) {
      return this.handleServerRequest(sessionId, parsed as JsonRpcServerRequest);
    }
    if (hasId) {
      return this.handleResponse(sessionId, parsed as JsonRpcResponse);
    }
    if (hasMethod) {
      return this.handleNotification(sessionId, parsed as JsonRpcNotification);
    }

    return [buildKimiSystemWarning(
      sessionId,
      'kimi_unknown_stdout',
      'Kimi emitted a JSON line without method or id.',
      { rawPreview: stringifyPreview(parsed) },
    )];
  }

  trackPendingRequest(sessionId: string, requestId: number | string, method: string): void {
    const state = this.getOrCreateState(sessionId);
    state.pendingRequests.set(requestId, {
      method,
      startedAtMs: Date.now(),
    });
  }

  /**
   * Returns (and forgets) the accept/decline option ids captured from a
   * session/request_permission, so the adapter answers with the exact ids the
   * CLI offered (kimi-code uses approve_once/reject; plan prompts use
   * plan_approve/plan_reject_and_exit).
   */
  consumePermissionOptionIds(sessionId: string, requestId: string): PermissionOptionIds | undefined {
    const state = this.sessionStates.get(sessionId);
    const optionIds = state?.permissionOptionIds.get(requestId);
    state?.permissionOptionIds.delete(requestId);
    return optionIds;
  }

  handleProcessExit(sessionId: string, exitCode: number): ParsedMessage[] {
    this.sessionStates.delete(sessionId);
    return [{
      serverMessage: {
        type: 'cli_down',
        sessionId,
        exitCode,
        message: `Kimi Down (exit code: ${exitCode})`,
      },
    }];
  }

  private handleServerRequest(sessionId: string, msg: JsonRpcServerRequest): ParsedMessage[] {
    if (msg.method === 'session/request_permission') {
      return this.handlePermissionRequest(sessionId, msg.id, msg.params ?? {});
    }

    logger.debug('Kimi: unknown server request suppressed', {
      sessionId,
      method: msg.method,
    });
    return [buildKimiSystemWarning(
      sessionId,
      'kimi_unknown_server_request',
      `Unhandled Kimi server request: ${msg.method}`,
      {
        method: msg.method,
        requestId: String(msg.id),
        rawPreview: stringifyPreview(msg.params ?? {}),
      },
    )];
  }

  private handleResponse(sessionId: string, msg: JsonRpcResponse): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const pending = state.pendingRequests.get(msg.id);
    state.pendingRequests.delete(msg.id);

    if (msg.error) {
      logger.error('Kimi: JSON-RPC error response', {
        sessionId,
        id: msg.id,
        method: pending?.method,
        code: msg.error.code,
        message: msg.error.message,
      });
      return [{
        serverMessage: {
          type: 'error',
          sessionId,
          code: String(msg.error.code),
          message: msg.error.message,
        },
      }];
    }

    if (pending?.method === 'session/prompt') {
      return this.handlePromptCompleted(sessionId, msg.result ?? {});
    }

    if (pending) {
      return [buildKimiSystemInfo(sessionId, 'kimi_response', `Kimi response received for ${pending.method}.`, {
        method: pending.method,
        result: msg.result ?? null,
      })];
    }

    return [];
  }

  private handleNotification(sessionId: string, msg: JsonRpcNotification): ParsedMessage[] {
    if (msg.method !== 'session/update') {
      return [buildKimiSystemWarning(
        sessionId,
        'kimi_unknown_notification',
        `Unhandled Kimi notification: ${msg.method}`,
        { method: msg.method, rawPreview: stringifyPreview(msg.params ?? {}) },
      )];
    }

    const update = msg.params?.update;
    if (!update || typeof update !== 'object') {
      return [buildKimiSystemWarning(
        sessionId,
        'kimi_malformed_session_update',
        'Kimi session/update notification did not include an update object.',
        { rawPreview: stringifyPreview(msg.params ?? {}) },
      )];
    }

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return this.handleUserMessageChunk(sessionId, update.content);
      case 'agent_message_chunk':
        return this.handleAgentMessageChunk(sessionId, update.content);
      case 'agent_thought_chunk':
        return this.handleThoughtChunk(sessionId, update.content);
      case 'tool_call':
      case 'tool_call_update':
        return this.handleToolCallUpdate(sessionId, update);
      case 'plan':
        return this.handlePlanUpdate(sessionId, update);
      case 'available_commands_update':
        return this.handleAvailableCommands(sessionId, update.availableCommands);
      case 'config_option_update':
        return this.handleConfigOptionUpdate(sessionId, update);
      default:
        logger.debug('Kimi: unsupported session update suppressed', {
          sessionId,
          sessionUpdate: update.sessionUpdate,
        });
        return this.handleUnsupportedSessionUpdate(sessionId, update);
    }
  }

  private handlePermissionRequest(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolUseId = String(toolCall.toolCallId ?? requestId);
    const toolName = extractKimiToolName(toolCall.title);
    const toolInput = parseKimiToolArguments(toolCall.content);
    const state = this.getOrCreateState(sessionId);
    state.permissionOptionIds.set(
      String(requestId),
      resolvePermissionOptionIds(params.options),
    );

    logger.info('Kimi: permission request received', {
      sessionId,
      requestId,
      toolUseId,
      toolName,
    });

    return [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'interactive_prompt',
          sessionId,
          promptType: 'permission_request',
          data: {
            question: `Allow ${toolName}?`,
            toolUseId,
            toolName,
            toolInput,
          },
        },
        sideEffect: {
          type: 'add_pending_permission_request',
          toolUseId,
          requestId: String(requestId),
          toolName,
          input: toolInput,
        },
      },
    ];
  }

  private handleUserMessageChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const normalizedContent = normalizeUserMessageContent(content);
    if (
      normalizedContent === undefined ||
      (typeof normalizedContent === 'string' && normalizedContent.length === 0) ||
      (Array.isArray(normalizedContent) && normalizedContent.length === 0)
    ) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'user_message',
          sessionId,
          content: normalizedContent,
          timestamp: new Date().toISOString(),
        },
      },
    ];
  }

  private handleAgentMessageChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const text = extractText(content);
    if (!text) return [];

    const state = this.getOrCreateState(sessionId);
    if (state.accumulatedText.length < MAX_ACCUMULATED_TEXT_LENGTH) {
      state.accumulatedText = (state.accumulatedText + text).slice(0, MAX_ACCUMULATED_TEXT_LENGTH);
    }

    return [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: text,
          // Stable id per chunk; first chunk of a contiguous run wins on both
          // client merge and history buffer, so live and flushed messages share
          // one id (translation attach).
          messageId: randomUUID(),
        },
      },
    ];
  }

  private handleThoughtChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const text = extractText(content);
    if (!text) return [];

    const state = this.getOrCreateState(sessionId);
    const timestamp = new Date().toISOString();

    if (!state.activeThinkingId) {
      state.activeThinkingId = randomUUID();
      return [{
        serverMessage: {
          type: 'thinking',
          sessionId,
          content: text,
          status: 'streaming',
          thinkingId: state.activeThinkingId,
          timestamp,
        },
      }];
    }

    return [{
      serverMessage: {
        type: 'thinking_update',
        sessionId,
        thinkingId: state.activeThinkingId,
        contentDelta: text,
        status: 'streaming',
        timestamp,
      },
    }];
  }

  private handleToolCallUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const toolUseId = String(update.toolCallId ?? '');
    if (!toolUseId) {
      return [buildKimiSystemWarning(
        sessionId,
        'kimi_tool_call_missing_id',
        'Kimi tool call update did not include a toolCallId.',
        { rawPreview: stringifyPreview(update) },
      )];
    }

    const pendingTool = state.pendingToolCalls.get(toolUseId);
    const toolName = pendingTool?.toolName ?? extractKimiToolName(update.title);
    const toolKind = pendingTool?.toolKind ?? inferKimiToolKind(toolName, update.kind);
    const status = normalizeToolStatus(update.status);
    // On start/progress the content blocks carry the (streaming) JSON tool
    // arguments; only on completion do they become the tool output.
    const isTerminal = status !== 'running';
    const parsedArguments = isTerminal ? undefined : parseKimiToolArguments(update.content);
    const toolParams = parsedArguments && Object.keys(parsedArguments).length > 0
      ? parsedArguments
      : pendingTool?.toolParams ?? {};
    const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
    const output = isTerminal ? extractToolOutput(update.content) : undefined;
    const timestamp = new Date().toISOString();

    const boundary = this.completeActiveThinking(sessionId, timestamp);
    const parsed: ParsedMessage = {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName,
        ...(toolKind ? { toolKind } : {}),
        toolParams,
        ...(toolDisplay ? { toolDisplay } : {}),
        status,
        ...(output ? { output } : {}),
        ...(status === 'error' && output ? { error: output } : {}),
        toolUseId,
        timestamp,
      },
    };

    if (!isTerminal) {
      state.pendingToolCalls.set(toolUseId, {
        toolName,
        ...(toolKind ? { toolKind } : {}),
        toolParams,
        startedAtMs: pendingTool?.startedAtMs ?? Date.now(),
      });

      parsed.sideEffect = {
        type: 'add_pending_tool_call',
        toolUseId,
        toolName,
        ...(toolKind ? { toolKind } : {}),
        toolParams,
        ...(toolDisplay ? { toolDisplay } : {}),
      };
      return [...boundary, parsed];
    }

    state.pendingToolCalls.delete(toolUseId);

    return [
      ...boundary,
      parsed,
      {
        serverMessage: null,
        sideEffect: { type: 'remove_pending_tool_call', toolUseId },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'remove_pending_permission_request', toolUseId },
      },
    ];
  }

  private handlePlanUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const rawEntries = Array.isArray(update.entries) ? update.entries : undefined;
    if (!rawEntries) {
      return [];
    }

    const state = this.getOrCreateState(sessionId);
    const entries = normalizeKimiTodos(rawEntries);
    state.lastTodoSnapshots = entries;

    return [
      ...this.completeActiveThinking(sessionId),
      buildKimiSystemInfo(sessionId, 'kimi_plan_update', 'Kimi plan updated.', {
        entries,
        rawEntries,
      }),
    ];
  }

  private handleAvailableCommands(sessionId: string, rawCommands: unknown): ParsedMessage[] {
    if (!Array.isArray(rawCommands)) {
      return [];
    }

    const commands = rawCommands
      .filter((command): command is Record<string, unknown> => isRecord(command) && typeof command.name === 'string')
      .map((command) => ({
        name: String(command.name),
        description: typeof command.description === 'string' ? command.description : '',
      }));

    return [
      {
        serverMessage: null,
        sideEffect: { type: 'store_commands', commands },
      },
      {
        serverMessage: {
          type: 'commands_ready',
          sessionId,
          commands,
          timestamp: new Date().toISOString(),
        },
      },
    ];
  }

  private handleConfigOptionUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    if (!Array.isArray(update.configOptions)) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      buildKimiSystemInfo(sessionId, 'kimi_config_option_update', 'Kimi config options updated.', {
        configOptions: update.configOptions,
      }),
    ];
  }

  private handleUnsupportedSessionUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    if (DISPLAY_ONLY_KIMI_SESSION_UPDATES.has(String(update.sessionUpdate ?? ''))) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      buildKimiSystemWarning(
        sessionId,
        'kimi_unsupported_session_update',
        `Unhandled Kimi session update: ${String(update.sessionUpdate ?? 'unknown')}`,
        { rawPreview: stringifyPreview(update) },
      ),
    ];
  }

  private handlePromptCompleted(
    sessionId: string,
    result: Record<string, any>,
  ): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const preview = state.accumulatedText.slice(0, 50);
    const hasMore = state.accumulatedText.length > 50;
    const messages: ParsedMessage[] = [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'notification',
          sessionId,
          event: 'completed',
          message: result.stopReason === 'cancelled' ? 'Task cancelled.' : 'Task completed.',
          preview: preview + (hasMore ? '...' : ''),
        },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'set_generating', value: false },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'auto_generate_title' },
      },
    ];

    state.accumulatedText = '';
    return messages;
  }

  private completeActiveThinking(sessionId: string, timestamp = new Date().toISOString()): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const thinkingId = state.activeThinkingId;
    if (!thinkingId) return [];

    state.activeThinkingId = null;
    return [{
      serverMessage: {
        type: 'thinking_update',
        sessionId,
        thinkingId,
        contentDelta: '',
        status: 'completed',
        timestamp,
      },
    }];
  }

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = {
        pendingRequests: new Map(),
        pendingToolCalls: new Map(),
        permissionOptionIds: new Map(),
        accumulatedText: '',
        activeThinkingId: null,
        lastTodoSnapshots: [],
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }
}

const FALLBACK_ACCEPT_OPTION_ID = 'approve_once';
const FALLBACK_DECLINE_OPTION_ID = 'reject';

function resolvePermissionOptionIds(rawOptions: unknown): PermissionOptionIds {
  const options = Array.isArray(rawOptions)
    ? rawOptions.filter((option): option is Record<string, any> => isRecord(option))
    : [];

  const byKind = (kinds: string[]): string | undefined => {
    for (const kind of kinds) {
      const match = options.find((option) => option.kind === kind);
      if (match && typeof match.optionId === 'string') return match.optionId;
    }
    return undefined;
  };
  const byIdFragment = (fragment: string): string | undefined => {
    const match = options.find((option) =>
      typeof option.optionId === 'string' && option.optionId.includes(fragment),
    );
    return match?.optionId;
  };

  return {
    accept: byKind(['allow_once', 'allow_always']) ?? byIdFragment('approve') ?? FALLBACK_ACCEPT_OPTION_ID,
    decline: byKind(['reject_once', 'reject_always']) ?? byIdFragment('reject') ?? FALLBACK_DECLINE_OPTION_ID,
  };
}

function normalizeToolStatus(status: unknown): 'running' | 'completed' | 'error' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'running';
  }
}

/**
 * Kimi tool call titles are "ToolName" or "ToolName: subtitle".
 */
export function extractKimiToolName(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) return 'Tool';
  const name = title.split(':')[0]?.trim();
  return name || 'Tool';
}

function inferKimiToolKind(toolName: string, acpKind: unknown): ToolCallKind | undefined {
  const inferred = inferToolCallKindFromToolName(toolName);
  if (inferred) return inferred;

  switch (acpKind) {
    case 'execute':
      return 'shell_command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_edit';
    case 'read':
      return 'file_read';
    case 'search':
      return 'search_grep';
    case 'fetch':
      return 'web_fetch';
    default:
      return undefined;
  }
}

/**
 * Kimi streams the tool call's JSON arguments as text content blocks. The JSON
 * may be truncated mid-stream, in which case an empty object is returned and
 * the previous snapshot is kept by the caller.
 */
export function parseKimiToolArguments(content: unknown): Record<string, any> {
  const text = extractText(content).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolOutput(content: unknown): string | undefined {
  const text = extractText(content).trim();
  return text || undefined;
}

function extractText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(extractContentText).filter(Boolean).join('');
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (isRecord(content.content)) return extractContentText(content.content);

  if (content.type === 'resource' && isRecord(content.resource)) {
    if (typeof content.resource.text === 'string') return content.resource.text;
  }

  return describeKimiAttachment(content);
}

function normalizeUserMessageContent(content: unknown): string | ContentBlock[] | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  const convertedBlocks = blocks
    .map(convertKimiContentBlock)
    .filter((block): block is ContentBlock => block !== undefined);

  if (convertedBlocks.length === 0) {
    return undefined;
  }

  const containsStructuredContent = convertedBlocks.some((block) => block.type !== 'text');
  if (!containsStructuredContent) {
    return convertedBlocks
      .map((block) => block.type === 'text' ? block.text : '')
      .join('');
  }

  return convertedBlocks;
}

function convertKimiContentBlock(content: unknown): ContentBlock | undefined {
  if (typeof content === 'string') {
    return content ? { type: 'text', text: content } : undefined;
  }

  if (!isRecord(content)) {
    return undefined;
  }

  if (content.type === 'image') {
    const mediaType = typeof content.mimeType === 'string' ? content.mimeType : '';
    const data = typeof content.data === 'string' ? content.data : '';
    if (isSupportedImageMime(mediaType) && data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data,
        },
      };
    }
  }

  const text = extractContentText(content);
  if (text) {
    return { type: 'text', text };
  }

  const description = describeKimiAttachment(content);
  return description ? { type: 'text', text: description } : undefined;
}

function describeKimiAttachment(content: Record<string, any>): string {
  switch (content.type) {
    case 'image': {
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'image';
      const uri = typeof content.uri === 'string' ? ` ${content.uri}` : '';
      return `[Image: ${mimeType}${uri}]`;
    }
    case 'audio': {
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'audio';
      return `[Audio: ${mimeType}]`;
    }
    case 'resource_link': {
      const name = typeof content.name === 'string' && content.name ? content.name : 'resource';
      const uri = typeof content.uri === 'string' ? ` ${content.uri}` : '';
      return `[Resource: ${name}${uri}]`;
    }
    case 'resource': {
      const resource = isRecord(content.resource) ? content.resource : {};
      const uri = typeof resource.uri === 'string' ? resource.uri : 'resource';
      const mimeType = typeof resource.mimeType === 'string' ? ` ${resource.mimeType}` : '';
      return `[Resource: ${uri}${mimeType}]`;
    }
    default:
      return '';
  }
}

function isSupportedImageMime(value: string): value is ImageContentBlock['source']['media_type'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp';
}

function normalizeKimiTodos(rawTodos: unknown): TodoItem[] {
  if (!Array.isArray(rawTodos)) return [];
  return rawTodos
    .filter((todo): todo is Record<string, unknown> => isRecord(todo))
    .map((todo) => ({
      content: typeof todo.content === 'string' ? todo.content : '',
      status: normalizeTodoStatus(todo.status),
    }))
    .filter((todo) => todo.content.length > 0);
}

function normalizeTodoStatus(status: unknown): TodoItem['status'] {
  switch (status) {
    case 'completed':
    case 'cancelled':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function buildKimiSystemInfo(
  sessionId: string,
  subtype: string,
  message: string,
  metadata: Record<string, any>,
): ParsedMessage {
  return {
    serverMessage: {
      type: 'system',
      sessionId,
      message,
      severity: 'info',
      subtype,
      metadata,
      timestamp: new Date().toISOString(),
    },
  };
}

function buildKimiSystemWarning(
  sessionId: string,
  subtype: string,
  message: string,
  metadata: Record<string, any>,
): ParsedMessage {
  return {
    serverMessage: {
      type: 'system',
      sessionId,
      message,
      severity: 'warning',
      subtype,
      metadata,
      timestamp: new Date().toISOString(),
    },
  };
}

function stringifyPreview(value: unknown, maxLength = 500): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}...`
    : serialized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const kimiProtocolParser = new KimiProtocolParser();
