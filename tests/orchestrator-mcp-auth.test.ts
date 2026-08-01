import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'http';
import { authorizeOrchestratorMcpRequest } from '../src/lib/orchestrator/mcp-server';
import { getOrchestratorMcpToken } from '../src/lib/orchestrator/config';

// The MCP endpoint exposes every session transcript on the box, so it must
// require BOTH the per-boot bearer token AND a loopback peer — a Tessera
// bound to 0.0.0.0 must never serve it to the LAN.

function fakeReq({
  remoteAddress,
  authorization,
}: {
  remoteAddress: string;
  authorization?: string;
}): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as unknown as IncomingMessage;
}

test('accepts loopback peer with the valid per-boot token', () => {
  const req = fakeReq({
    remoteAddress: '127.0.0.1',
    authorization: `Bearer ${getOrchestratorMcpToken()}`,
  });
  assert.equal(authorizeOrchestratorMcpRequest(req), true);
});

test('accepts ipv6 loopback forms', () => {
  for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
    const req = fakeReq({
      remoteAddress,
      authorization: `Bearer ${getOrchestratorMcpToken()}`,
    });
    assert.equal(authorizeOrchestratorMcpRequest(req), true, `${remoteAddress} must be loopback-ok`);
  }
});

test('rejects missing or wrong token', () => {
  assert.equal(authorizeOrchestratorMcpRequest(fakeReq({ remoteAddress: '127.0.0.1' })), false);
  assert.equal(
    authorizeOrchestratorMcpRequest(fakeReq({
      remoteAddress: '127.0.0.1',
      authorization: 'Bearer wrong-token',
    })),
    false,
  );
  assert.equal(
    authorizeOrchestratorMcpRequest(fakeReq({
      remoteAddress: '127.0.0.1',
      authorization: getOrchestratorMcpToken(), // missing the "Bearer " prefix
    })),
    false,
  );
});

test('rejects non-loopback peers even with the valid token', () => {
  const req = fakeReq({
    remoteAddress: '192.168.1.50',
    authorization: `Bearer ${getOrchestratorMcpToken()}`,
  });
  assert.equal(authorizeOrchestratorMcpRequest(req), false);
});
