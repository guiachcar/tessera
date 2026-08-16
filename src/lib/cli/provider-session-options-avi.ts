import { execCli } from './cli-exec';
import type { AgentEnvironment } from '../settings/types';
import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

/**
 * Session options for the Avi provider.
 *
 * Avi's model list is NOT a fixed catalogue: it is whatever providers the user
 * configured inside Avi — a ChatGPT subscription, an OpenAI-compatible endpoint,
 * a local Ollama. So the list is probed from the binary (`avi models --json`)
 * instead of mirrored statically here, and each model carries its own reasoning
 * levels, because sending one a model rejects fails the whole turn.
 */

const AVI_MODEL_PROBE_TIMEOUT_MS = 15_000;

interface AviModelEntry {
  id?: string;
  name?: string;
  providerName?: string;
  reasoning?: string[];
  contextInput?: number | null;
  images?: boolean;
  isDefault?: boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export async function loadAviSessionOptions(
  agentEnvironment: AgentEnvironment,
): Promise<ProviderSessionOptions> {
  const result = await execCli(
    'avi',
    ['models', '--json'],
    agentEnvironment,
    AVI_MODEL_PROBE_TIMEOUT_MS,
  );

  // A probe failure means the binary is missing or signed out. Returning an
  // empty list is the honest answer: the picker shows nothing to choose rather
  // than offering models the session would then fail on.
  return buildAviSessionOptions(result.ok ? parseAviModels(result.stdout) : []);
}

export function buildAviSessionOptions(
  modelOptions: ProviderModelOption[],
): ProviderSessionOptions {
  return {
    providerId: 'avi',
    displayName: 'Avi',
    supportsReasoningEffort: modelOptions.some(
      (option) => option.supportedReasoningEfforts.length > 0,
    ),
    // Both ride session/set_mode, which Avi applies to the NEXT turn — no
    // restart needed.
    runtimeEffortChange: true,
    runtimeAccessChange: true,
    modelOptions,
    permissionMappings: [],
    modeOptions: [
      {
        value: 'work',
        label: 'Work',
        description: 'Implement, edit, and run tasks using the selected access level',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Avi plan mode: read-only investigation, ends in an execution plan',
      },
    ],
    // Avi has three permission modes; these map onto them in the adapter
    // (toAviPermissionMode). "Don't Ask" is deliberately absent — Avi cannot
    // block a call without prompting, and offering a mode it silently downgrades
    // would be worse than not offering it.
    accessOptions: [
      {
        value: 'default',
        label: 'Ask',
        description: 'Approve every tool call before it runs',
      },
      {
        value: 'acceptEdits',
        label: 'Auto',
        description: 'Avi asks only for calls it judges risky',
      },
      {
        value: 'bypassPermissions',
        label: 'YOLO',
        description: 'Auto-approve every tool call — isolated environments only',
      },
    ],
    planLocksAccess: true,
    planAccessLabel: 'Read-only planning',
  };
}

export function parseAviModels(stdout: string): ProviderModelOption[] {
  let entries: AviModelEntry[];
  try {
    const parsed = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return [];
    entries = parsed as AviModelEntry[];
  } catch {
    return [];
  }

  return entries.flatMap((entry, index) => {
    const value = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!value) return [];

    const efforts = buildReasoningEffortOptions(entry.reasoning);
    return [{
      value,
      label: buildLabel(entry, value),
      isDefault: entry.isDefault === true || index === 0,
      // "high" is Avi's own default tier when a model exposes it; otherwise the
      // middle of whatever it does expose, so the picker never preselects an
      // effort the model rejects.
      defaultReasoningEffort: efforts.length > 0
        ? (efforts.find((effort) => effort.value === 'high') ?? efforts[Math.floor(efforts.length / 2)]).value
        : null,
      supportedReasoningEfforts: efforts,
    }];
  });
}

function buildLabel(entry: AviModelEntry, value: string): string {
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : value;
  // Avi ids are already `<provider>:<model>`; repeating the provider name in
  // the label just makes the picker wider without adding information.
  return name;
}

function buildReasoningEffortOptions(
  reasoning: string[] | undefined,
): ProviderReasoningEffortOption[] {
  if (!Array.isArray(reasoning) || reasoning.length === 0) return [];

  return reasoning
    .filter((effort): effort is string => typeof effort === 'string' && effort.trim().length > 0)
    .map((effort) => ({
      value: effort,
      label: EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1),
      description: `Use Avi ${effort} reasoning`,
    }));
}
