/**
 * Fixed-port opt-in for the embedded Electron server.
 *
 * TESSERA_PORT pins the server to one port so external links stay stable
 * across restarts (e.g. `tailscale serve`, remote-access bookmarks alongside
 * TESSERA_HOST). Unset keeps the default port-scan behavior.
 */
export function parseFixedPort(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TESSERA_PORT value: "${value}" (expected an integer from 1 to 65535)`);
  }
  return port;
}
