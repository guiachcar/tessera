/**
 * Kimi Code CLI Adapter (ACP)
 *
 * Implements the CliProvider interface for MoonshotAI's Kimi Code CLI by
 * driving `kimi acp` over JSON-RPC 2.0 (Agent Client Protocol), mirroring the
 * OpenCode adapter:
 *  - handshake: initialize → session/new | session/resume
 *  - turns: session/prompt; interrupts: session/cancel
 *  - permissions: session/request_permission answered with approve/reject
 *  - the ACP session id is persisted in sessions.provider_state as
 *    {"kimiSessionId": "..."} for resume after a process restart
 *
 * Auth is delegated to the CLI (`kimi login`); there is no read-only auth
 * probe, so status checks are version-only and login failures surface as ACP
 * auth_required errors at session start.
 */

import type { ChildProcess } from 'child_process';
import type {
  CheckStatusOptions,
  CliProvider,
  CliStatusResult,
  GeneratedTitle,
  ParsedMessage,
  SpawnOptions,
  SpawnResult,
  CliRawLogSink,
  TranslatedText,
} from '../types';
import type { ContentBlock } from '@/lib/ws/message-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import { isBinaryAvailable } from '../registry';
import { execCli, parseVersion, probeBinaryAvailable } from '../../cli-exec';
import { getAgentEnvironment, normalizeCwdForCliEnvironment, spawnCli } from '../../spawn-cli';
import {
  resolveProviderCliCommand,
  resolveProviderCliCommandWithMetadata,
} from '../../provider-command';
import {
  classifyVersionFailure,
  classifyVersionOnlyStatus,
  summarizeExecProbe,
} from '../../status-detection';
import { updateProviderStateWithRetry } from '../../process-manager-side-effects';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import logger from '@/lib/logger';
import { kimiProtocolParser } from './protocol-parser';
import { normalizeKimiThinkingEffort, resolveKimiModeId } from './session-config';

const CLI_TIMEOUT_MS = 120_000;
const STATUS_CHECK_TIMEOUT_MS = 5_000;
const ONE_SHOT_TIMEOUT_MS = 120_000;
const PROVIDER_ID = 'kimi';
const DEFAULT_COMMAND = 'kimi';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponsePayload {
  id: number | string;
  result?: Record<string, any>;
  error?: { code?: number | string; message?: string };
}

interface KimiRuntimeConfig {
  sessionId: string;
  cwd: string;
  kimiSessionId: string | null;
  model?: string;
  reasoningEffort?: string | null;
  sessionMode?: ProviderRuntimeControls['sessionMode'];
  accessMode?: ProviderRuntimeControls['accessMode'];
}

type KimiPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export class KimiAdapter implements CliProvider {
  private _nextRequestId = 3;
  private _processRuntimeConfig = new WeakMap<ChildProcess, KimiRuntimeConfig>();
  private _initialConfigSent = new WeakSet<ChildProcess>();
  private _startupReaders = new WeakMap<ChildProcess, KimiStartupReader>();
  private _processRawLogs = new WeakMap<ChildProcess, CliRawLogSink>();

  private _attachRawLog(
    proc: ChildProcess,
    rawLog: CliRawLogSink | undefined,
    metadata: Record<string, unknown>,
  ): void {
    if (!rawLog) return;

    this._processRawLogs.set(proc, rawLog);
    rawLog({ direction: 'event', phase: 'spawn', data: JSON.stringify(metadata) });
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      rawLog({ direction: 'stdout', phase: 'process', data: chunk.toString() });
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      rawLog({ direction: 'stderr', phase: 'process', data: chunk.toString() });
    });
  }

  private _writeStdin(proc: ChildProcess, phase: string, payload: string): boolean {
    this._processRawLogs.get(proc)?.({ direction: 'stdin', phase, data: payload });
    return proc.stdin?.write(payload) ?? false;
  }

  getProviderId(): string {
    return PROVIDER_ID;
  }

  getDisplayName(): string {
    return 'Kimi Code';
  }

  async isAvailable(environment?: 'native' | 'wsl'): Promise<boolean> {
    if (environment) {
      return probeBinaryAvailable(DEFAULT_COMMAND, environment);
    }
    return isBinaryAvailable(DEFAULT_COMMAND);
  }

  async checkStatus(options: CheckStatusOptions): Promise<CliStatusResult> {
    const commandMetadata = await resolveProviderCliCommandWithMetadata(
      PROVIDER_ID,
      DEFAULT_COMMAND,
      options.environment,
      options.userId,
    );
    // Kimi has login/logout but no read-only status command, so only the
    // version probe is meaningful here; ACP reports auth_required at session
    // start when the OAuth token is missing or expired.
    const versionResult = await execCli(
      commandMetadata.command,
      ['--version'],
      options.environment,
      STATUS_CHECK_TIMEOUT_MS,
    );
    const version = parseVersion(versionResult.stdout);
    // Stricter than the shared version-only classifier: `kimi --version`
    // always prints a version and exits 0 when installed, and Windows-native
    // probes go through cmd.exe where a missing binary still exits 1 (never
    // ENOENT). Require a real version; keep the timeout leniency for slow boots.
    const { status, detectionReason } = versionResult.ok || versionResult.timedOut
      ? classifyVersionOnlyStatus(versionResult, commandMetadata.commandSource)
      : {
          status: 'not_installed' as const,
          detectionReason: classifyVersionFailure(versionResult, commandMetadata.commandSource),
        };

    return {
      status,
      detectionReason,
      ...(version ? { version } : {}),
      commandSource: commandMetadata.commandSource,
      commandShape: commandMetadata.commandShape,
      versionProbe: summarizeExecProbe(versionResult),
    };
  }

  getCliArgs(_options: SpawnOptions): string[] {
    return ['acp'];
  }

  async spawn(workDir: string, options: SpawnOptions): Promise<SpawnResult> {
    const agentEnv = await getAgentEnvironment(options.userId);
    const command = await resolveProviderCliCommand(PROVIDER_ID, DEFAULT_COMMAND, agentEnv, options.userId);
    const cliWorkDir = normalizeCwdForCliEnvironment(workDir, agentEnv);
    const args = this.getCliArgs(options);

    const cliProcess = spawnCli(command, args, {
      cwd: cliWorkDir,
      shell: false,
      env: process.env as NodeJS.ProcessEnv,
      detached: getRuntimePlatform() !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }, agentEnv);
    this._attachRawLog(cliProcess, options.rawLog, {
      providerId: PROVIDER_ID,
      command,
      args,
      cwd: cliWorkDir,
      requestedCwd: workDir,
      agentEnv,
    });

    const spawnResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
      const onError = (err: Error) => {
        cliProcess.removeListener('spawn', onSpawn);
        resolve({ ok: false, error: err });
      };
      const onSpawn = () => {
        cliProcess.removeListener('error', onError);
        resolve({ ok: true });
      };
      cliProcess.once('error', onError);
      cliProcess.once('spawn', onSpawn);
    });

    if (!spawnResult.ok) {
      return { process: cliProcess, ok: false, error: spawnResult.error };
    }

    const tesseraSessionId = options.sessionId ?? '__provider__';
    this._processRuntimeConfig.set(cliProcess, {
      sessionId: tesseraSessionId,
      cwd: cliWorkDir,
      kimiSessionId: null,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      sessionMode: options.sessionMode,
      accessMode: options.accessMode,
    });

    try {
      const kimiSessionId = await this._performHandshake(cliProcess, cliWorkDir, options);
      const current = this._processRuntimeConfig.get(cliProcess);
      if (current) {
        this._processRuntimeConfig.set(cliProcess, {
          ...current,
          kimiSessionId,
        });
      }
      if (tesseraSessionId !== '__provider__') {
        updateProviderStateWithRetry(tesseraSessionId, { kimiSessionId });
      }
    } catch (err) {
      logger.error('KimiAdapter: handshake failed', {
        error: (err as Error).message,
        sessionId: tesseraSessionId,
      });
      cliProcess.kill('SIGTERM');
      return {
        process: cliProcess,
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    return { process: cliProcess, ok: true };
  }

  consumeStartupMessages(proc: ChildProcess, _sessionId: string): ParsedMessage[] {
    const startupReader = this._startupReaders.get(proc);
    if (!startupReader) {
      return [];
    }

    this._startupReaders.delete(proc);
    return startupReader.drain();
  }

  onSessionReady(proc: ChildProcess, sessionId: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig || this._initialConfigSent.has(proc)) {
      return false;
    }

    this._initialConfigSent.add(proc);
    let wrote = false;

    if (runtimeConfig.model) {
      wrote = this._sendSetModel(proc, sessionId, runtimeConfig.model) || wrote;
    }

    const thinking = normalizeKimiThinkingEffort(runtimeConfig.reasoningEffort);
    if (thinking) {
      wrote = this._sendSetThinking(proc, sessionId, thinking) || wrote;
    }

    if (runtimeConfig.sessionMode || runtimeConfig.accessMode) {
      wrote = this._sendSetMode(
        proc,
        sessionId,
        resolveKimiModeId(runtimeConfig.sessionMode, runtimeConfig.accessMode),
      ) || wrote;
    }

    return wrote;
  }

  sendMessage(proc: ChildProcess, content: string | ContentBlock[]): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    const kimiSessionId = runtimeConfig?.kimiSessionId;
    if (!runtimeConfig || !kimiSessionId) {
      logger.error('KimiAdapter: cannot send session/prompt without Kimi session id');
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/prompt',
      params: {
        sessionId: kimiSessionId,
        prompt: buildPromptParts(content),
      },
    };

    kimiProtocolParser.trackPendingRequest(runtimeConfig.sessionId, requestId, 'session/prompt');
    const ok = this._writeStdin(proc, 'send_message', `${JSON.stringify(request)}\n`);
    logger.debug('KimiAdapter: sent session/prompt', {
      sessionId: runtimeConfig.sessionId,
      kimiSessionId,
      requestId,
    });
    return ok;
  }

  parseStdout(line: string): ParsedMessage | null {
    const messages = this.parseSessionStdout('__provider__', line);
    return messages.length > 0 ? messages[0] : null;
  }

  parseSessionStdout(sessionId: string, line: string): ParsedMessage[] {
    return kimiProtocolParser.parseStdout(sessionId, line);
  }

  handleSessionExit(sessionId: string, exitCode: number): ParsedMessage[] {
    return kimiProtocolParser.handleProcessExit(sessionId, exitCode);
  }

  updateSessionConfig(
    proc: ChildProcess,
    patch: ProviderRuntimeControls & {
      permissionMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    },
  ): boolean {
    const current = this._processRuntimeConfig.get(proc);
    if (!current) {
      return false;
    }

    let wrote = false;
    if (patch.model) {
      wrote = this._sendSetModel(proc, current.sessionId, patch.model) || wrote;
    }

    if (patch.reasoningEffort !== undefined) {
      const thinking = normalizeKimiThinkingEffort(patch.reasoningEffort);
      if (thinking) {
        wrote = this._sendSetThinking(proc, current.sessionId, thinking) || wrote;
      }
    }

    if (patch.sessionMode || patch.accessMode) {
      const nextModeId = resolveKimiModeId(
        patch.sessionMode ?? current.sessionMode,
        patch.accessMode ?? current.accessMode,
      );
      wrote = this._sendSetMode(proc, current.sessionId, nextModeId) || wrote;
    }

    this._processRuntimeConfig.set(proc, {
      ...current,
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.sessionMode ? { sessionMode: patch.sessionMode } : {}),
      ...(patch.accessMode ? { accessMode: patch.accessMode } : {}),
    });

    return wrote;
  }

  sendApprovalResponse(proc: ChildProcess, requestId: string, decision: 'accept' | 'decline'): void {
    const numericId = Number(requestId);
    const id = Number.isNaN(numericId) ? requestId : numericId;
    // Answer with the exact option ids the CLI offered for this request
    // (approve_once/reject for tools, plan_approve/... for plan prompts).
    const tesseraSessionId = this._processRuntimeConfig.get(proc)?.sessionId ?? '__provider__';
    const optionIds = kimiProtocolParser.consumePermissionOptionIds(tesseraSessionId, requestId);
    const optionId = decision === 'accept'
      ? optionIds?.accept ?? 'approve_once'
      : optionIds?.decline ?? 'reject';
    const response = {
      jsonrpc: '2.0' as const,
      id,
      result: {
        outcome: {
          outcome: 'selected',
          optionId,
        },
      },
    };

    this._writeStdin(proc, 'send_approval_response', `${JSON.stringify(response)}\n`);
    logger.info('KimiAdapter: sent permission response', { requestId, decision, optionId });
  }

  sendInterrupt(proc: ChildProcess, _sessionId: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.kimiSessionId) {
      return false;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: runtimeConfig.kimiSessionId },
    };

    return this._writeStdin(proc, 'send_interrupt', `${JSON.stringify(notification)}\n`);
  }

  async generateTitle(prompt: string, userId?: string): Promise<GeneratedTitle | null> {
    try {
      const text = await this._runOneShot(prompt, userId);
      return text ? parseGeneratedTitleText(text) : null;
    } catch (err) {
      logger.warn('KimiAdapter: generateTitle failed', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  async translateText(
    prompt: string,
    userId?: string,
    model?: string,
  ): Promise<TranslatedText | null> {
    try {
      const text = await this._runOneShot(prompt, userId, model ? ['--model', model] : []);
      const trimmed = text.trim();
      return trimmed ? { text: trimmed } : null;
    } catch (err) {
      logger.warn('KimiAdapter: translateText failed', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  private async _performHandshake(
    proc: ChildProcess,
    cwd: string,
    options: SpawnOptions,
  ): Promise<string> {
    const tesseraSessionId = options.sessionId ?? '__provider__';
    const startupReader = new KimiStartupReader(proc, tesseraSessionId);
    this._startupReaders.set(proc, startupReader);

    let nextId = 1;
    try {
      const initId = nextId++;
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'tessera', version: '1.0.0' },
        },
      };

      const startupTimeoutMs = options.startupTimeoutMs ?? CLI_TIMEOUT_MS;
      const initResponse = startupReader.awaitResponse(initId, 'initialize', startupTimeoutMs);
      this._writeStdin(proc, 'handshake_initialize', `${JSON.stringify(initRequest)}\n`);
      await initResponse;

      const sessionId = options.resume && options.kimiSessionId
        ? options.kimiSessionId
        : undefined;
      const sessionMethod = sessionId ? 'session/resume' : 'session/new';
      const sessionReqId = nextId++;
      const sessionRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: sessionReqId,
        method: sessionMethod,
        params: {
          ...(sessionId ? { sessionId } : {}),
          cwd,
          mcpServers: [],
        },
      };

      const sessionResponsePromise = startupReader.awaitResponse(sessionReqId, sessionMethod, startupTimeoutMs);
      this._writeStdin(proc, `handshake_${sessionMethod}`, `${JSON.stringify(sessionRequest)}\n`);
      const sessionResponse = await sessionResponsePromise;
      // session/resume responses omit sessionId (the requested id stays valid).
      const kimiSessionId = sessionResponse.result?.sessionId ?? sessionId;
      if (typeof kimiSessionId !== 'string' || !kimiSessionId) {
        throw new Error(`KimiAdapter: ${sessionMethod} response missing sessionId`);
      }

      return kimiSessionId;
    } catch (err) {
      this._startupReaders.delete(proc);
      startupReader.dispose();
      throw err;
    }
  }

  private _sendSetModel(proc: ChildProcess, tesseraSessionId: string, model: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.kimiSessionId) {
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_model',
      params: {
        sessionId: runtimeConfig.kimiSessionId,
        modelId: model,
      },
    };

    kimiProtocolParser.trackPendingRequest(tesseraSessionId, requestId, 'session/set_model');
    return this._writeStdin(proc, 'set_model', `${JSON.stringify(request)}\n`);
  }

  private _sendSetMode(proc: ChildProcess, tesseraSessionId: string, modeId: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.kimiSessionId) {
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_mode',
      params: {
        sessionId: runtimeConfig.kimiSessionId,
        modeId,
      },
    };

    kimiProtocolParser.trackPendingRequest(tesseraSessionId, requestId, 'session/set_mode');
    return this._writeStdin(proc, 'set_mode', `${JSON.stringify(request)}\n`);
  }

  private _sendSetThinking(proc: ChildProcess, tesseraSessionId: string, thinking: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.kimiSessionId) {
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_config_option',
      params: {
        sessionId: runtimeConfig.kimiSessionId,
        configId: 'thinking',
        value: thinking,
      },
    };

    kimiProtocolParser.trackPendingRequest(tesseraSessionId, requestId, 'session/set_config_option');
    return this._writeStdin(proc, 'set_thinking', `${JSON.stringify(request)}\n`);
  }

  // Spawns `kimi -p <prompt>` headless (kimi-code prompt mode takes the prompt
  // as an argument, not stdin) and resolves the response text. Shared by title
  // generation and translation (which differ only in how they parse this text).
  private async _runOneShot(
    prompt: string,
    userId?: string,
    extraArgs: string[] = [],
  ): Promise<string> {
    const agentEnv = await getAgentEnvironment(userId);
    const command = await resolveProviderCliCommand(PROVIDER_ID, DEFAULT_COMMAND, agentEnv, userId);

    return new Promise((resolve, reject) => {
      const child = spawnCli(command, [
        '-p', prompt,
        '--output-format', 'text',
        ...extraArgs,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: getRuntimePlatform() === 'win32' ? process.env.TEMP || process.cwd() : '/tmp',
        env: process.env as NodeJS.ProcessEnv,
      }, agentEnv);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        resolve(stdout);
      }, ONE_SHOT_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`KimiAdapter: failed to spawn kimi --print: ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        if (!stdout.trim() && code !== 0) {
          reject(new Error(`kimi -p exited with code ${code}: ${stderr.slice(0, 200)}`));
          return;
        }

        resolve(stdout);
      });

      child.stdin?.end();
    });
  }
}

interface PendingStartupResponse {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (response: JsonRpcResponsePayload) => void;
  reject: (error: Error) => void;
}

class KimiStartupReader {
  private buffer = '';
  private readonly messages: ParsedMessage[] = [];
  private readonly pendingResponses = new Map<number | string, PendingStartupResponse>();
  private isDisposed = false;

  constructor(
    private readonly proc: ChildProcess,
    private readonly sessionId: string,
  ) {
    this.proc.stdout?.on('data', this.onData);
    this.proc.once('error', this.onError);
    this.proc.once('close', this.onClose);
  }

  awaitResponse(
    expectedId: number,
    method: string,
    timeoutMs = CLI_TIMEOUT_MS,
  ): Promise<JsonRpcResponsePayload> {
    if (this.isDisposed) {
      return Promise.reject(new Error(
        `KimiAdapter: startup reader disposed before response id=${expectedId} (${method})`,
      ));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(expectedId);
        reject(new Error(`KimiAdapter: timed out waiting for response id=${expectedId} (${method})`));
      }, timeoutMs);

      this.pendingResponses.set(expectedId, {
        method,
        timeout,
        resolve,
        reject,
      });
    });
  }

  drain(): ParsedMessage[] {
    const messages = [...this.messages];
    this.messages.length = 0;
    this.dispose();
    return messages;
  }

  dispose(error = new Error('KimiAdapter: startup reader disposed')): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.proc.stdout?.removeListener('data', this.onData);
    this.proc.removeListener('error', this.onError);
    this.proc.removeListener('close', this.onClose);

    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      this.handleLine(line);
    }
  };

  private readonly onError = (err: Error): void => {
    this.dispose(new Error(`KimiAdapter: process error during handshake: ${err.message}`));
  };

  private readonly onClose = (code: number | null): void => {
    this.dispose(new Error(`KimiAdapter: process closed (code=${code}) during handshake`));
  };

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (isJsonRpcId(parsed.id) && typeof parsed.method !== 'string') {
      const pending = this.pendingResponses.get(parsed.id);
      if (pending) {
        this.pendingResponses.delete(parsed.id);
        clearTimeout(pending.timeout);

        if (parsed.error) {
          pending.reject(buildJsonRpcResponseError(parsed.id, pending.method, parsed.error));
        } else {
          pending.resolve(parsed);
        }
        return;
      }
    }

    this.messages.push(...kimiProtocolParser.parseStdout(this.sessionId, trimmed));
  }
}

function isJsonRpcId(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string';
}

function buildJsonRpcResponseError(
  id: number | string,
  method: string,
  error: { code?: number | string; message?: string; data?: unknown },
): Error {
  const message = typeof error.message === 'string' ? error.message : 'Unknown error';
  const code = error.code ?? 'unknown';
  const authHint = String(code) === '-32000' || /auth/i.test(message)
    ? ' Run `kimi login` in a terminal and try again.'
    : '';
  return new Error(`KimiAdapter: JSON-RPC error for id=${id} (${method}): ${message} (code ${code})${authHint}`);
}

function buildPromptParts(content: string | ContentBlock[]): KimiPromptPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return content.flatMap((block): KimiPromptPart[] => {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }];
    }
    if (block.type === 'image') {
      return [{
        type: 'image',
        mimeType: block.source.media_type,
        data: block.source.data,
      }];
    }
    if (block.type === 'skill') {
      return [{ type: 'text', text: `/${block.name}` }];
    }
    return [];
  });
}

function parseGeneratedTitleText(text: string): GeneratedTitle | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.title === 'string') {
      return { title: parsed.title.slice(0, 100) };
    }
  } catch {
    // Fall through to regex extraction for slightly noisy responses.
  }

  const match = trimmed.match(/"title"\s*:\s*"([^"]+)"/);
  if (!match) return null;
  return { title: match[1].slice(0, 100) };
}

export const kimiAdapter = new KimiAdapter();
