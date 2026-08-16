/**
 * Avi Adapter
 *
 * Avi (https://github.com/aivaxlabs/avi) is a harness that talks straight to
 * OpenAI-compatible providers instead of wrapping another CLI. Its headless
 * entrypoint (`avi --stdio`) serves ACP — the same JSON-RPC-over-stdio dialect
 * Tessera already speaks to OpenCode and Kimi — so it plugs in as a provider
 * with no shared code between the two projects: the protocol is the contract.
 *
 * What Avi adds that no current provider covers: arbitrary OpenAI-compatible
 * endpoints (local Ollama / vLLM, Groq, DeepSeek, OpenRouter) and a ChatGPT
 * subscription without the Codex CLI.
 *
 * Scope notes:
 *  - Avi has no TUI, so the terminal-tab policies below are inert defaults and
 *    the terminal session-observer hooks are intentionally not implemented.
 *  - Avi's orchestration tools are withheld by its own ACP entrypoint: they
 *    create threads inside Avi's database that Tessera cannot show. Mapping
 *    them onto Tessera sessions is a protocol extension, not part of this.
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
import { classifyVersionOnlyStatus, summarizeExecProbe } from '../../status-detection';
import { updateProviderStateWithRetry } from '../../process-manager-side-effects';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import logger from '@/lib/logger';
import { aviProtocolParser } from './protocol-parser';
import { AviStartupReader } from './startup-reader';

const CLI_TIMEOUT_MS = 120_000;
const STATUS_CHECK_TIMEOUT_MS = 5_000;
const PROVIDER_ID = 'avi';
const DEFAULT_COMMAND = 'avi';

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

interface AviRuntimeConfig {
  sessionId: string;
  cwd: string;
  aviSessionId: string | null;
  model?: string;
  reasoningEffort?: string | null;
  sessionMode?: ProviderRuntimeControls['sessionMode'];
  permissionMode?: string;
}

type AviPermissionMode = 'ask_for_approval' | 'approve_for_me' | 'full_access';

/**
 * Tessera's five permission modes onto Avi's three.
 *
 * Avi has no "block without prompting" state, so `dontAsk` degrades to asking
 * rather than to letting the call through: over-asking is recoverable, silently
 * widening access is not. Only YOLO maps to full access.
 */
function toAviPermissionMode(permissionMode: string | undefined): AviPermissionMode {
  switch (permissionMode) {
    case 'bypassPermissions':
      return 'full_access';
    case 'acceptEdits':
      return 'approve_for_me';
    case 'default':
    case 'dontAsk':
      return 'ask_for_approval';
    default:
      return 'approve_for_me';
  }
}

type AviPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export class AviAdapter implements CliProvider {
  private _nextRequestId = 3;
  private _processRuntimeConfig = new WeakMap<ChildProcess, AviRuntimeConfig>();
  private _initialConfigSent = new WeakSet<ChildProcess>();
  private _startupReaders = new WeakMap<ChildProcess, AviStartupReader>();
  private _processRawLogs = new WeakMap<ChildProcess, CliRawLogSink>();

  getProviderId(): string {
    return PROVIDER_ID;
  }

  getDisplayName(): string {
    return 'Avi';
  }

  // Avi ships no terminal UI: these three only govern the TUI tab, which this
  // provider never opens. The contract requires them, so they take the inert
  // defaults rather than pretending to a behaviour that cannot occur.
  getTerminalAppearanceChangePolicy(): 'live' {
    return 'live';
  }

  getTerminalResizeScrollbackPolicy(): 'native' {
    return 'native';
  }

  getTerminalInterruptInputPolicy(): 'none' {
    return 'none';
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
    // Avi holds provider credentials in its own vault and has no read-only
    // auth-status command, so `--version` is the whole probe: a missing model
    // or expired token surfaces as a session/prompt error, not here.
    const versionResult = await execCli(
      commandMetadata.command,
      ['--version'],
      options.environment,
      STATUS_CHECK_TIMEOUT_MS,
    );
    const { status, detectionReason } = classifyVersionOnlyStatus(
      versionResult,
      commandMetadata.commandSource,
    );
    const version = parseVersion(versionResult.stdout);

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
    return ['--stdio'];
  }

  async spawn(workDir: string, options: SpawnOptions): Promise<SpawnResult> {
    const agentEnv = await getAgentEnvironment(options.userId);
    const command = await resolveProviderCliCommand(PROVIDER_ID, DEFAULT_COMMAND, agentEnv, options.userId);
    const cliWorkDir = normalizeCwdForCliEnvironment(workDir, agentEnv);
    const args = this.getCliArgs(options);

    const cliProcess = spawnCli(command, args, {
      cwd: cliWorkDir,
      shell: false,
      env: { ...process.env } as NodeJS.ProcessEnv,
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
      aviSessionId: null,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      sessionMode: options.sessionMode,
      permissionMode: options.permissionMode,
    });
    aviProtocolParser.setSessionModel(tesseraSessionId, options.model ?? null);

    try {
      const aviSessionId = await this._performHandshake(cliProcess, cliWorkDir, options);
      const current = this._processRuntimeConfig.get(cliProcess);
      if (current) {
        this._processRuntimeConfig.set(cliProcess, { ...current, aviSessionId });
      }
      if (tesseraSessionId !== '__provider__') {
        updateProviderStateWithRetry(tesseraSessionId, { aviSessionId });
      }
    } catch (err) {
      logger.error('AviAdapter: handshake failed', {
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

  sendMessage(proc: ChildProcess, content: string | ContentBlock[]): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    const aviSessionId = runtimeConfig?.aviSessionId;
    if (!runtimeConfig || !aviSessionId) {
      logger.error('AviAdapter: cannot send session/prompt without an Avi session id');
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/prompt',
      params: {
        sessionId: aviSessionId,
        prompt: buildPromptParts(content),
      },
    };

    aviProtocolParser.trackPendingRequest(runtimeConfig.sessionId, requestId, 'session/prompt');
    return this._writeStdin(proc, 'send_message', `${JSON.stringify(request)}\n`);
  }

  parseStdout(line: string): ParsedMessage | null {
    const messages = this.parseSessionStdout('__provider__', line);
    return messages.length > 0 ? messages[0] : null;
  }

  parseSessionStdout(sessionId: string, line: string): ParsedMessage[] {
    return aviProtocolParser.parseStdout(sessionId, line);
  }

  handleSessionExit(sessionId: string, exitCode: number): ParsedMessage[] {
    return aviProtocolParser.handleProcessExit(sessionId, exitCode);
  }

  consumeStartupMessages(proc: ChildProcess, _sessionId: string): ParsedMessage[] {
    const startupReader = this._startupReaders.get(proc);
    if (!startupReader) return [];
    this._startupReaders.delete(proc);
    return startupReader.drain();
  }

  onSessionReady(proc: ChildProcess, sessionId: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig || this._initialConfigSent.has(proc)) return false;

    this._initialConfigSent.add(proc);
    let wrote = false;
    if (runtimeConfig.model) {
      wrote = this._sendSetModel(proc, sessionId, runtimeConfig.model) || wrote;
    }
    // Always sent, even with no sessionMode: Avi defaults to approve_for_me,
    // which would quietly ignore a stricter mode the user selected.
    wrote = this._sendSetMode(proc, runtimeConfig.sessionMode, runtimeConfig.permissionMode) || wrote;
    return wrote;
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
    if (!current) return false;

    let wrote = false;
    if (patch.model) {
      wrote = this._sendSetModel(proc, current.sessionId, patch.model) || wrote;
    }
    if (patch.sessionMode || patch.permissionMode) {
      wrote = this._sendSetMode(
        proc,
        patch.sessionMode ?? current.sessionMode,
        patch.permissionMode ?? current.permissionMode,
      ) || wrote;
    }

    this._processRuntimeConfig.set(proc, {
      ...current,
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.sessionMode ? { sessionMode: patch.sessionMode } : {}),
      ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
    });
    return wrote;
  }

  sendApprovalResponse(proc: ChildProcess, requestId: string, decision: 'accept' | 'decline'): void {
    const numericId = Number(requestId);
    const id = Number.isNaN(numericId) ? requestId : numericId;
    const response = {
      jsonrpc: '2.0' as const,
      id,
      result: {
        outcome: {
          outcome: 'selected',
          optionId: decision === 'accept' ? 'once' : 'reject',
        },
      },
    };
    this._writeStdin(proc, 'send_approval_response', `${JSON.stringify(response)}\n`);
  }

  sendInterrupt(proc: ChildProcess, _sessionId: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.aviSessionId) return false;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: runtimeConfig.aviSessionId },
    };
    return this._writeStdin(proc, 'send_interrupt', `${JSON.stringify(notification)}\n`);
  }

  /**
   * Avi exposes no one-shot completion endpoint — every turn belongs to a
   * persisted conversation — so there is nothing to run a title through here.
   * Returning null lets Tessera fall back to its own title generation instead
   * of spawning a throwaway session just to name a chat.
   */
  async generateTitle(_prompt: string, _userId?: string): Promise<GeneratedTitle | null> {
    return null;
  }

  // -------------------------------------------------------------- internals

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

  private async _performHandshake(
    proc: ChildProcess,
    cwd: string,
    options: SpawnOptions,
  ): Promise<string> {
    const tesseraSessionId = options.sessionId ?? '__provider__';
    const startupReader = new AviStartupReader(proc, tesseraSessionId, aviProtocolParser);
    this._startupReaders.set(proc, startupReader);

    let nextId = 1;
    try {
      const startupTimeoutMs = options.startupTimeoutMs ?? CLI_TIMEOUT_MS;

      const initId = nextId++;
      const initResponse = startupReader.awaitResponse(initId, 'initialize', startupTimeoutMs);
      this._writeStdin(proc, 'handshake_initialize', `${JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'tessera', version: '1.0.0' },
        },
      })}\n`);
      await initResponse;

      const resumeId = options.resume && options.aviSessionId ? options.aviSessionId : undefined;
      const sessionMethod = resumeId ? 'session/resume' : 'session/new';
      const sessionReqId = nextId++;
      const sessionResponsePromise = startupReader.awaitResponse(
        sessionReqId,
        sessionMethod,
        startupTimeoutMs,
      );
      this._writeStdin(proc, `handshake_${sessionMethod}`, `${JSON.stringify({
        jsonrpc: '2.0',
        id: sessionReqId,
        method: sessionMethod,
        params: {
          ...(resumeId ? { sessionId: resumeId } : {}),
          cwd,
          mcpServers: [],
        },
      })}\n`);
      const sessionResponse = await sessionResponsePromise;

      const aviSessionId = sessionResponse.result?.sessionId ?? resumeId;
      if (typeof aviSessionId !== 'string' || !aviSessionId) {
        throw new Error(`AviAdapter: ${sessionMethod} response missing sessionId`);
      }
      return aviSessionId;
    } catch (err) {
      this._startupReaders.delete(proc);
      startupReader.dispose();
      throw err;
    }
  }

  private _sendSetModel(proc: ChildProcess, tesseraSessionId: string, model: string): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.aviSessionId) return false;

    const requestId = this._nextRequestId++;
    aviProtocolParser.setSessionModel(tesseraSessionId, model);
    aviProtocolParser.trackPendingRequest(tesseraSessionId, requestId, 'session/set_model');
    return this._writeStdin(proc, 'set_model', `${JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_model',
      params: { sessionId: runtimeConfig.aviSessionId, modelId: model },
    })}\n`);
  }

  private _sendSetMode(
    proc: ChildProcess,
    sessionMode: ProviderRuntimeControls['sessionMode'],
    permissionMode: string | undefined,
  ): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    if (!runtimeConfig?.aviSessionId) return false;

    const requestId = this._nextRequestId++;
    return this._writeStdin(proc, 'set_mode', `${JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/set_mode',
      params: {
        sessionId: runtimeConfig.aviSessionId,
        ...(sessionMode ? { modeId: sessionMode === 'plan' ? 'plan' : 'work' } : {}),
        permissionMode: toAviPermissionMode(permissionMode),
      },
    })}\n`);
  }
}

function buildPromptParts(content: string | ContentBlock[]): AviPromptPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return content.flatMap((block): AviPromptPart[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }];
    if (block.type === 'image') {
      return [{ type: 'image', mimeType: block.source.media_type, data: block.source.data }];
    }
    // Avi discovers skills itself from .agents/ and the workspace, and invokes
    // them with a leading slash from the prompt text.
    if (block.type === 'skill') return [{ type: 'text', text: `/${block.name}` }];
    return [];
  });
}

export const aviAdapter = new AviAdapter();
