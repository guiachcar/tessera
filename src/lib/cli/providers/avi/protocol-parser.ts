import { OpenCodeProtocolParser } from '../opencode/protocol-parser';
import type { ParsedMessage } from '../types';

/**
 * Avi speaks the same ACP dialect Tessera already parses for OpenCode, so the
 * wire-level handling is shared rather than duplicated: a second INSTANCE keeps
 * Avi's per-session state separate while reusing one tested implementation.
 *
 * Known rough edge: the shared parser labels its internal warnings "OpenCode".
 * Those are logger lines plus a handful of `system` warnings for malformed
 * frames, which the Avi ACP server does not emit; the one user-facing string
 * that does fire on every session end is overridden below. Renaming the rest
 * means parameterising the OpenCode parser, which is a change to a working
 * provider and is deliberately not bundled into adding a new one.
 */
export class AviProtocolParser extends OpenCodeProtocolParser {
  handleProcessExit(sessionId: string, exitCode: number): ParsedMessage[] {
    const messages = super.handleProcessExit(sessionId, exitCode);
    return messages.map((message) => (
      message.serverMessage?.type === 'cli_down'
        ? {
            ...message,
            serverMessage: {
              ...message.serverMessage,
              message: `Avi Down (exit code: ${exitCode})`,
            },
          }
        : message
    ));
  }
}

export const aviProtocolParser = new AviProtocolParser();
