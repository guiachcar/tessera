import type { ChildProcess } from 'child_process';
import type { ParsedMessage } from '../types';

/**
 * Reads the agent's stdout during the ACP handshake, before the process
 * manager owns the stream.
 *
 * Two jobs at once: resolve the `initialize` / `session/new` responses the
 * adapter is awaiting, and BUFFER every other frame that arrives in the
 * meantime. Without the buffer, a notification emitted between spawn and
 * handover would be parsed by nobody and silently lost.
 */

const HANDSHAKE_TIMEOUT_MS = 120_000;

interface JsonRpcResponsePayload {
  id: number | string;
  result?: Record<string, any>;
  error?: { code?: number | string; message?: string };
}

interface PendingResponse {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: JsonRpcResponsePayload) => void;
  reject: (error: Error) => void;
}

interface StdoutParser {
  parseStdout(sessionId: string, line: string): ParsedMessage[];
}

export class AviStartupReader {
  private buffer = '';
  private readonly messages: ParsedMessage[] = [];
  private readonly pendingResponses = new Map<number | string, PendingResponse>();
  private isDisposed = false;

  constructor(
    private readonly proc: ChildProcess,
    private readonly sessionId: string,
    private readonly parser: StdoutParser,
  ) {
    this.proc.stdout?.on('data', this.onData);
    this.proc.once('error', this.onError);
    this.proc.once('close', this.onClose);
  }

  awaitResponse(
    expectedId: number,
    method: string,
    timeoutMs = HANDSHAKE_TIMEOUT_MS,
  ): Promise<JsonRpcResponsePayload> {
    if (this.isDisposed) {
      return Promise.reject(new Error(
        `AviAdapter: startup reader disposed before response id=${expectedId} (${method})`,
      ));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(expectedId);
        reject(new Error(`AviAdapter: timed out waiting for response id=${expectedId} (${method})`));
      }, timeoutMs);

      this.pendingResponses.set(expectedId, { method, timeout, resolve, reject });
    });
  }

  drain(): ParsedMessage[] {
    const messages = [...this.messages];
    this.messages.length = 0;
    this.dispose();
    return messages;
  }

  dispose(error = new Error('AviAdapter: startup reader disposed')): void {
    if (this.isDisposed) return;

    this.isDisposed = true;
    this.proc.stdout?.removeListener('data', this.onData);
    this.proc.removeListener('error', this.onError);
    this.proc.removeListener('close', this.onClose);

    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // A chunk boundary can split a frame; the tail is held until its newline.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  };

  private readonly onError = (err: Error): void => {
    this.dispose(new Error(`AviAdapter: process error during handshake: ${err.message}`));
  };

  private readonly onClose = (code: number | null): void => {
    this.dispose(new Error(`AviAdapter: process closed (code=${code}) during handshake`));
  };

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (typeof parsed.id === 'number' || typeof parsed.id === 'string') {
      const pending = this.pendingResponses.get(parsed.id);
      if (pending) {
        this.pendingResponses.delete(parsed.id);
        clearTimeout(pending.timeout);
        if (parsed.error) {
          const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'Unknown error';
          pending.reject(new Error(
            `AviAdapter: JSON-RPC error for id=${parsed.id} (${pending.method}): ${message} (code ${parsed.error.code ?? 'unknown'})`,
          ));
        } else {
          pending.resolve(parsed);
        }
        return;
      }
    }

    this.messages.push(...this.parser.parseStdout(this.sessionId, trimmed));
  }
}
