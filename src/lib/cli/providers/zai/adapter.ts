/**
 * Z.ai GLM Adapter
 *
 * Runs GLM models (glm-5.2 / glm-4.7) through the Claude Code CLI pointed at
 * Z.ai's Anthropic-compatible endpoint. The whole session protocol (stream-json
 * stdin/stdout, permission prompts, resume) is inherited from ClaudeCodeAdapter;
 * this subclass only swaps the provider identity, injects the Z.ai endpoint
 * environment, and replaces the auth probe (`claude auth status` is meaningless
 * here — auth is the ZAI_API_KEY environment variable).
 *
 * Configuration follows the Tessera convention of delegating credentials to the
 * environment: export ZAI_API_KEY with a key from https://z.ai before starting
 * the server. No key is ever persisted by Tessera.
 */

import type { CheckStatusOptions, CliStatusResult } from '../types';
import { ClaudeCodeAdapter } from '../claude-code/adapter';
import { execCli, parseVersion } from '../../cli-exec';
import { resolveProviderCliCommandWithMetadata } from '../../provider-command';
import {
  classifyVersionFailure,
  isVersionProbeRunnable,
  summarizeExecProbe,
} from '../../status-detection';

const STATUS_CHECK_TIMEOUT_MS = 5_000;

export const ZAI_PROVIDER_ID = 'zai';
export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';

export function resolveZaiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZAI_API_KEY?.trim() ?? '';
}

const ZAI_WSLENV_VARS = ['ANTHROPIC_BASE_URL/u', 'ANTHROPIC_AUTH_TOKEN/u', 'API_TIMEOUT_MS/u'];

/**
 * When the desktop app runs on Windows with "WSL tools", CLI processes launch
 * through wsl.exe, which only forwards environment variables listed in WSLENV.
 * Appending the Z.ai overrides ("/u" = Windows→WSL only) makes the endpoint
 * redirect survive the boundary. Harmless everywhere else.
 */
export function appendZaiWslEnv(current: string | undefined): string {
  const entries = (current ?? '').split(':').filter(Boolean);
  for (const entry of ZAI_WSLENV_VARS) {
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries.join(':');
}

export class ZaiAdapter extends ClaudeCodeAdapter {
  protected readonly providerId: string = ZAI_PROVIDER_ID;
  protected readonly defaultCommand: string = 'claude';
  protected readonly displayName: string = 'Z.ai GLM';

  /**
   * Points every spawn (session and one-shot title/translate calls) at Z.ai.
   * ANTHROPIC_API_KEY is removed so a session can never silently fall back to
   * the user's Anthropic account; a missing ZAI_API_KEY fails loudly against
   * the Z.ai endpoint instead.
   */
  protected buildSpawnEnvOverrides(): Record<string, string | undefined> {
    return {
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: resolveZaiApiKey(),
      ANTHROPIC_API_KEY: undefined,
      API_TIMEOUT_MS: '3000000',
      WSLENV: appendZaiWslEnv(process.env.WSLENV),
    };
  }

  /**
   * Installed = the claude binary runs. Logged in = ZAI_API_KEY is present in
   * the server environment. The binary-level auth status is irrelevant because
   * every request is redirected to Z.ai with its own token.
   */
  async checkStatus(options: CheckStatusOptions): Promise<CliStatusResult> {
    const commandMetadata = await resolveProviderCliCommandWithMetadata(
      this.providerId,
      this.defaultCommand,
      options.environment,
      options.userId,
    );
    const versionResult = await execCli(
      commandMetadata.command,
      ['--version'],
      options.environment,
      STATUS_CHECK_TIMEOUT_MS,
    );
    const baseTelemetry = {
      commandSource: commandMetadata.commandSource,
      commandShape: commandMetadata.commandShape,
      versionProbe: summarizeExecProbe(versionResult),
    };

    if (!isVersionProbeRunnable(versionResult)) {
      return {
        status: 'not_installed',
        detectionReason: classifyVersionFailure(versionResult, commandMetadata.commandSource),
        ...baseTelemetry,
      };
    }

    const version = parseVersion(versionResult.stdout);
    const hasApiKey = Boolean(resolveZaiApiKey());

    return {
      status: hasApiKey ? 'connected' : 'needs_login',
      detectionReason: hasApiKey ? 'connected' : 'auth_failed',
      ...(version ? { version } : {}),
      ...baseTelemetry,
    };
  }
}

export const zaiAdapter = new ZaiAdapter();
