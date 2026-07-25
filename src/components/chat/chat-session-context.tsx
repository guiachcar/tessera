"use client";

import { createContext, useContext } from "react";

/**
 * Session id of the chat surface currently rendering. Lets deeply nested
 * markdown components (inline code, links) open workspace file tabs without
 * threading the session id through every renderer prop.
 */
export const ChatSessionContext = createContext<string | null>(null);

export function useChatSessionId(): string | null {
  return useContext(ChatSessionContext);
}
