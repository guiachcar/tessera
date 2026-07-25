/**
 * Kimi Code (kimi-code) ACP session configuration.
 *
 * The ACP server exposes session config through three requests:
 *  - session/set_model  {sessionId, modelId}   e.g. "kimi-code/k3"
 *  - session/set_mode   {sessionId, modeId}    default | plan | auto | yolo
 *  - session/set_config_option {sessionId, configId: 'thinking', value}
 *    with thinking values low | high | max
 *
 * Tessera's shared session controls map onto them here.
 */

import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';

export type KimiAccessMode = Extract<
  ProviderSessionAccessMode,
  'default' | 'auto' | 'bypassPermissions'
>;

export type KimiSessionModeId = 'default' | 'plan' | 'auto' | 'yolo';

export const KIMI_DEFAULT_ACCESS_MODE: KimiAccessMode = 'default';
export const KIMI_THINKING_EFFORTS = ['low', 'high', 'max'] as const;
export type KimiThinkingEffort = (typeof KIMI_THINKING_EFFORTS)[number];

export function normalizeKimiAccessMode(value: unknown): KimiAccessMode | undefined {
  switch (value) {
    case 'default':
    case 'auto':
    case 'bypassPermissions':
      return value;
    default:
      return undefined;
  }
}

export function normalizeKimiThinkingEffort(value: unknown): KimiThinkingEffort | undefined {
  return KIMI_THINKING_EFFORTS.includes(value as KimiThinkingEffort)
    ? (value as KimiThinkingEffort)
    : undefined;
}

/**
 * Maps Tessera's sessionMode/accessMode pair to a Kimi ACP modeId.
 * Plan wins over any access preset (read-only planning).
 */
export function resolveKimiModeId(
  sessionMode?: ProviderSessionMode,
  accessMode?: ProviderSessionAccessMode,
): KimiSessionModeId {
  if (sessionMode === 'plan') {
    return 'plan';
  }

  switch (normalizeKimiAccessMode(accessMode)) {
    case 'auto':
      return 'auto';
    case 'bypassPermissions':
      return 'yolo';
    default:
      return 'default';
  }
}
