/**
 * Orchestrator MCP configuration.
 *
 * The orchestrator is a special chat session (`kind: 'orchestrator'`) whose
 * provider CLI gets an extra MCP server — the Tessera itself, exposed over
 * HTTP in-process (see mcp-server.ts). This module owns:
 *  - the per-boot bearer token that authenticates the MCP endpoint;
 *  - the fixed workDir for orchestrator sessions (a virtual project — the
 *    session-creation flow auto-registers workDir as project id, so this
 *    keeps every project-scoped query working without schema changes);
 *  - the generated MCP config file consumed by `--mcp-config` at spawn time.
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

/** Per-boot token: never persisted, so a leaked config file dies with the server. */
let authToken: string | null = null;

export function getOrchestratorMcpToken(): string {
  if (!authToken) {
    authToken = randomBytes(32).toString('hex');
  }
  return authToken;
}

export function isValidOrchestratorMcpToken(token: string | undefined): boolean {
  return !!token && token === getOrchestratorMcpToken();
}

export function getOrchestratorWorkDir(): string {
  const dir = getTesseraDataPath('orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getOrchestratorMcpConfigPath(): string {
  return getTesseraDataPath('orchestrator-mcp.json');
}

/**
 * (Re)write the MCP config file with the current port + token and return its
 * path. Called at every orchestrator spawn so port changes across restarts
 * (and a fresh token per boot) are always reflected.
 */
export function ensureOrchestratorMcpConfig(port: number): string {
  const configPath = getOrchestratorMcpConfigPath();
  const config = {
    mcpServers: {
      tessera: {
        type: 'http',
        url: `http://127.0.0.1:${port}/__tessera/mcp`,
        headers: {
          Authorization: `Bearer ${getOrchestratorMcpToken()}`,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}
