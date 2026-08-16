import {
  buildClaudePermissionMappings,
  CLAUDE_ACCESS_OPTIONS,
  SHARED_MODE_OPTIONS,
} from './provider-session-option-definitions';
import type {
  ProviderModelOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

/**
 * GLM models exposed by Z.ai's Anthropic-compatible endpoint. The list is
 * static (documented at https://docs.z.ai/devpack/tool/claude) — there is no
 * CLI probe because the claude binary itself has no knowledge of the endpoint.
 */
export const ZAI_MODEL_OPTIONS: ProviderModelOption[] = [
  {
    value: 'glm-5.3',
    label: 'GLM-5.3',
    description: 'Latest GLM flagship (recommended)',
    isDefault: true,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  },
  {
    value: 'glm-5.2',
    label: 'GLM-5.2',
    description: 'Previous GLM flagship',
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  },
  {
    value: 'glm-4.7',
    label: 'GLM-4.7',
    description: 'Faster and cheaper GLM model',
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  },
];

/**
 * Session options for the Z.ai GLM provider. Everything except the model list
 * mirrors Claude Code because the session runs on the claude binary: the same
 * permission modes, plan gating, and runtime access changes apply. Reasoning
 * effort is disabled — GLM ignores Claude effort settings.
 */
export function buildZaiSessionOptions(): ProviderSessionOptions {
  return {
    providerId: 'zai',
    displayName: 'Z.ai GLM',
    supportsReasoningEffort: false,
    runtimeEffortChange: false,
    runtimeAccessChange: true,
    modelOptions: ZAI_MODEL_OPTIONS,
    permissionMappings: buildClaudePermissionMappings(),
    modeOptions: [...SHARED_MODE_OPTIONS],
    accessOptions: [...CLAUDE_ACCESS_OPTIONS],
    planLocksAccess: true,
    planAccessLabel: 'Read-only planning',
  };
}
