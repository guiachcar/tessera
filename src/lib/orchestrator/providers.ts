/**
 * Providers whose adapters can inject the embedded Tessera MCP server via
 * CLI flags (--mcp-config + --append-system-prompt). zai extends the Claude
 * Code adapter, so it inherits the capability.
 *
 * Shared by the session-create API (validation) and the UI (provider pick) —
 * keep this file free of node-only imports so the client bundle can use it.
 */
export const ORCHESTRATOR_CAPABLE_PROVIDERS: readonly string[] = ['claude-code', 'zai'];
