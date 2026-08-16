/**
 * Live end-to-end check: Tessera's Avi adapter driving a REAL `avi --stdio`
 * process — real command resolution, real spawn, real ACP handshake, real
 * frames parsed back into Tessera messages.
 *
 * Not a `.test.ts`: it needs the `avi` binary on PATH and a configured model
 * in Avi's own vault, so it is opt-in rather than part of the default suite.
 * The always-on drift guard is tests/avi-acp-protocol.test.ts.
 *
 *   npx tsx tests/avi-live-session.integration.ts "your prompt"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { aviAdapter } from '../src/lib/cli/providers/avi/adapter';
import type { ParsedMessage } from '../src/lib/cli/providers/types';

const SESSION_ID = 'live-integration-session';
const TURN_TIMEOUT_MS = 180_000;
const prompt = process.argv[2] ?? 'Reply with exactly: TESSERA_AVI_OK';

const workDir = mkdtempSync(join(tmpdir(), 'tessera-avi-live-'));
// Held outside main() so the failure path can still reap the child: an agent
// left running would keep the readline open and hang the script instead of
// reporting the error it just printed.
let agentProcess: { kill: (signal?: NodeJS.Signals) => boolean } | null = null;

function describe(message: ParsedMessage): string {
  const server = message.serverMessage as Record<string, any> | undefined;
  if (!server) return JSON.stringify(message);
  if (server.type === 'message') return `message(${server.role}): ${server.content}`;
  if (server.type === 'thinking') return `thinking: ${String(server.content).slice(0, 80)}`;
  if (server.type === 'tool_call') return `tool_call(${server.status}): ${server.toolName}`;
  return `${server.type}: ${JSON.stringify(server).slice(0, 160)}`;
}

async function main(): Promise<void> {
  console.log(`status: ${JSON.stringify(await aviAdapter.checkStatus({ userId: undefined } as any))}`);

  // 'default' maps to Avi's ask_for_approval, so every tool call must round
  // trip through session/request_permission — the path this script answers.
  const spawned = await aviAdapter.spawn(workDir, {
    sessionId: SESSION_ID,
    permissionMode: 'default',
  } as any);
  assert.ok(spawned.ok, `spawn failed: ${spawned.error?.message}`);
  console.log('handshake: ok');

  const proc = spawned.process;
  agentProcess = proc;
  const collected: ParsedMessage[] = [];
  let assistantText = '';

  for (const startup of aviAdapter.consumeStartupMessages(proc, SESSION_ID)) {
    collected.push(startup);
  }
  // The process manager does this in a real session; without it the agent
  // never learns the model or the permission mode.
  aviAdapter.onSessionReady(proc, SESSION_ID);

  const turnDone = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn timed out')), TURN_TIMEOUT_MS);
    createInterface({ input: proc.stdout!, crlfDelay: Infinity }).on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Answer permission requests so a tool-using turn can finish. A real
      // session routes this to the user; here every request is approved, which
      // is what makes the tool path testable at all.
      try {
        const frame = JSON.parse(trimmed);
        if (frame.method === 'session/request_permission') {
          const toolCallId = frame.params?.toolCall?.toolCallId ?? frame.id;
          console.log(`  -> approving permission for ${frame.params?.toolCall?.title ?? toolCallId}`);
          aviAdapter.sendApprovalResponse(proc, String(frame.id), 'accept');
        }
      } catch {}

      for (const message of aviAdapter.parseSessionStdout(SESSION_ID, trimmed)) {
        collected.push(message);
        const server = message.serverMessage as Record<string, any> | undefined;
        if (server?.type === 'message' && server.role === 'assistant') {
          assistantText += server.content;
        }
        console.log(`  <- ${describe(message)}`);
      }

      // The turn is over when the agent answers our session/prompt request.
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.result?.stopReason) {
          clearTimeout(timer);
          console.log(`turn ended: ${parsed.result.stopReason}`);
          resolve();
        }
        if (parsed.error) {
          clearTimeout(timer);
          reject(new Error(`agent error: ${parsed.error.message}`));
        }
      } catch {}
    });
    proc.stderr?.on('data', (chunk) => process.stderr.write(`  [avi] ${chunk}`));
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`agent exited early (code ${code})`));
    });
  });

  console.log(`-> prompt: ${prompt}`);
  assert.ok(aviAdapter.sendMessage(proc, prompt), 'sendMessage must reach stdin');
  await turnDone;

  assert.ok(assistantText.trim(), 'the turn produced no assistant text');
  console.log(`\nassistant said: ${assistantText.trim()}`);
  console.log(`frames parsed: ${collected.length}`);
  console.log('live session OK');

  proc.kill('SIGTERM');
}

main()
  .catch((error) => {
    console.error(`live session FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    agentProcess?.kill('SIGTERM');
    rmSync(workDir, { recursive: true, force: true });
  });
