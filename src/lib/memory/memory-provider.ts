import type { MemoryProviderKind } from "@/types/memory";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CODEX_PROVIDER_ID = "codex";
export const OPENCODE_PROVIDER_ID = "opencode";
// Z.ai GLM runs on the claude binary, so it reads/writes CLAUDE.md like Claude Code.
export const ZAI_PROVIDER_ID = "zai";

export function isClaudeMemoryProvider(provider: string | null | undefined): boolean {
  const normalized = provider?.trim();
  return normalized === CLAUDE_CODE_PROVIDER_ID || normalized === ZAI_PROVIDER_ID;
}

export function getMemoryProviderKind(provider: string | null | undefined): MemoryProviderKind | null {
  const normalized = provider?.trim();
  if (normalized === CLAUDE_CODE_PROVIDER_ID) return "claude-code";
  if (normalized === ZAI_PROVIDER_ID) return "claude-code";
  if (normalized === CODEX_PROVIDER_ID) return "codex";
  if (normalized === OPENCODE_PROVIDER_ID) return "opencode";
  return null;
}

export function supportsMemoryPanel(provider: string | null | undefined): boolean {
  return getMemoryProviderKind(provider) !== null;
}
