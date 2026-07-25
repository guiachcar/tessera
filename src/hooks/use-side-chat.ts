/**
 * Side Chat Hook
 *
 * Opens a companion session next to the source session: same provider,
 * project, and work_dir. The source conversation is exported and injected as
 * the first message so the side chat can discuss the main session's work
 * without interrupting it.
 */

import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import {
  exportSessionReference,
  formatSideChatPrompt,
} from '@/lib/session/session-reference';
import {
  applyProviderSessionRuntimeOverrides,
  getProviderSessionRuntimeConfig,
} from '@/lib/settings/provider-defaults';
import { wsClient } from '@/lib/ws/client';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import type { UnifiedSession } from '@/types/chat';

interface SideChatCreateResponse {
  sessionId: string;
  title: string;
  status: UnifiedSession['status'];
  createdAt: string;
  provider: string;
  model?: string;
  parentSessionId: string;
}

export function useSideChat(sessionId: string, panelId: string) {
  const { t } = useI18n();
  const [isOpeningSideChat, setIsOpeningSideChat] = useState(false);

  const openSideChat = useCallback(async () => {
    const sessionStore = useSessionStore.getState();
    const source = sessionStore.getSession(sessionId);
    if (!source) return;

    setIsOpeningSideChat(true);
    try {
      const exportPath = await exportSessionReference(sessionId);

      const response = await fetchWithClientId(
        `/api/sessions/${encodeURIComponent(sessionId)}/side-chat`,
        { method: 'POST' },
      );
      if (!response.ok) {
        if (response.status === 429) {
          toast.error(t('errors.sessionLimitReached', { current: 20, max: 20 }));
          return;
        }
        throw new Error('side chat create failed');
      }
      const result = (await response.json()) as SideChatCreateResponse;

      const sideChatSession: UnifiedSession = {
        id: result.sessionId,
        title: result.title,
        projectDir: source.projectDir,
        workDir: source.workDir,
        isRunning: false,
        hasStarted: false,
        status: result.status,
        createdAt: result.createdAt,
        lastModified: result.createdAt,
        tesseraSessionId: result.sessionId,
        archived: false,
        sortOrder: 0,
        provider: result.provider,
        model: result.model,
        collectionId: source.collectionId,
        parentSessionId: sessionId,
        hasCustomTitle: true,
      };
      sessionStore.addSession(sideChatSession);
      useChatStore.getState().loadHistory(result.sessionId, []);
      usePanelStore.getState().splitPanel(panelId, 'horizontal', result.sessionId);

      const { settings } = useSettingsStore.getState();
      const providerId = result.provider?.trim();
      const spawnConfig = providerId
        ? applyProviderSessionRuntimeOverrides(
            getProviderSessionRuntimeConfig(settings, providerId),
            sideChatSession,
            providerId,
          )
        : undefined;
      const prompt = formatSideChatPrompt(exportPath);
      wsClient.sendMessage(result.sessionId, prompt, undefined, prompt, spawnConfig);
    } catch {
      toast.error(t('errors.sideChatFailed'));
    } finally {
      setIsOpeningSideChat(false);
    }
  }, [panelId, sessionId, t]);

  return { openSideChat, isOpeningSideChat };
}
