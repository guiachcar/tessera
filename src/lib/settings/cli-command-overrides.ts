import type { AgentEnvironment, CliCommandOverrides } from './types';

const VALID_ENVIRONMENTS = new Set<AgentEnvironment>(['native', 'wsl']);
const DISALLOWED_EXECUTABLE_PATH_CHARS = /[\r\n\0;&|<>`$]/;
const MAX_COMMAND_LENGTH = 512;

export const CONFIGURABLE_CLI_PROVIDERS = [
  {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    commandName: 'claude',
  },
  {
    providerId: 'codex',
    displayName: 'Codex',
    commandName: 'codex',
  },
  {
    providerId: 'opencode',
    displayName: 'OpenCode',
    commandName: 'opencode',
  },
  {
    providerId: 'kimi',
    displayName: 'Kimi Code',
    commandName: 'kimi',
  },
] as const;

export function sanitizeCliCommandOverride(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = stripMatchingQuotes(value.trim());
  if (
    trimmed.length === 0
    || trimmed.length > MAX_COMMAND_LENGTH
    || DISALLOWED_EXECUTABLE_PATH_CHARS.test(trimmed)
  ) {
    return '';
  }

  if (!isAbsoluteExecutablePath(trimmed)) {
    return '';
  }

  return trimmed;
}

export function normalizeCliCommandOverrides(raw: unknown): CliCommandOverrides {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const normalized: CliCommandOverrides = {};
  for (const [providerId, value] of Object.entries(raw)) {
    if (!providerId || !value || typeof value !== 'object') {
      continue;
    }

    for (const [environment, commandValue] of Object.entries(value)) {
      if (!VALID_ENVIRONMENTS.has(environment as AgentEnvironment)) {
        continue;
      }

      const command = sanitizeCliCommandOverride(commandValue);
      if (!command) {
        continue;
      }

      normalized[providerId] ??= {};
      normalized[providerId][environment as AgentEnvironment] = command;
    }
  }

  return normalized;
}

export function setCliCommandOverride(
  overrides: CliCommandOverrides,
  providerId: string,
  environment: AgentEnvironment,
  commandValue: string,
): CliCommandOverrides {
  const next = normalizeCliCommandOverrides(overrides);
  const command = sanitizeCliCommandOverride(commandValue);

  if (command) {
    next[providerId] = {
      ...(next[providerId] ?? {}),
      [environment]: command,
    };
    return next;
  }

  if (!next[providerId]) {
    return next;
  }

  delete next[providerId][environment];
  if (Object.keys(next[providerId]).length === 0) {
    delete next[providerId];
  }

  return next;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function isAbsoluteExecutablePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value);
}
