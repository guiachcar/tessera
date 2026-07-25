import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

/**
 * Thinking tiers exposed by kimi-code's ACP `configOptions` (configId
 * "thinking"). Applied at spawn and changeable at runtime via
 * session/set_config_option.
 */
const KIMI_THINKING_OPTIONS: ProviderReasoningEffortOption[] = [
  { value: 'low', label: 'Low', description: 'Use Kimi low thinking' },
  { value: 'high', label: 'High', description: 'Use Kimi high thinking (default)' },
  { value: 'max', label: 'Max', description: 'Use Kimi max thinking' },
];

/**
 * Models served by the managed kimi-code OAuth provider. The authoritative
 * list arrives in the ACP session/new response (configOptions "model"); this
 * static mirror feeds the picker before a session starts, and the CLI rejects
 * ids it does not know.
 */
const KIMI_MODEL_OPTIONS: ProviderModelOption[] = [
  {
    value: 'kimi-code/k3',
    label: 'K3',
    isDefault: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: KIMI_THINKING_OPTIONS,
  },
  {
    value: 'kimi-code/kimi-for-coding',
    label: 'K2.7 Coding',
    isDefault: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: KIMI_THINKING_OPTIONS,
  },
  {
    value: 'kimi-code/kimi-for-coding-highspeed',
    label: 'K2.7 Coding Highspeed',
    isDefault: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: KIMI_THINKING_OPTIONS,
  },
];

/**
 * Session options for the Kimi Code provider (ACP). Modes map to the ACP
 * session/set_mode ids: Plan → plan; access presets Ask/Auto/YOLO →
 * default/auto/yolo. Permissions in Ask mode are interactive via
 * session/request_permission.
 */
export function buildKimiSessionOptions(): ProviderSessionOptions {
  return {
    providerId: 'kimi',
    displayName: 'Kimi Code',
    supportsReasoningEffort: true,
    runtimeEffortChange: true,
    runtimeAccessChange: true,
    modelOptions: KIMI_MODEL_OPTIONS,
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
        description: 'Kimi plan mode: read-only planning, no tool execution',
      },
    ],
    accessOptions: [
      {
        value: 'default',
        label: 'Ask',
        description: 'Manual approvals; Kimi asks before risky tool calls',
      },
      {
        value: 'bypassPermissions',
        label: 'YOLO',
        description: 'Auto-approve tool actions; the agent may still ask questions',
      },
      {
        value: 'auto',
        label: 'Auto',
        description: 'Fully autonomous — the agent decides everything without asking',
      },
    ],
    planLocksAccess: true,
    planAccessLabel: 'Read-only planning',
  };
}
