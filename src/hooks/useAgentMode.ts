import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type AgentStatus =
  | 'idle'
  | 'capturing'
  | 'analyzing'
  | 'executing'
  | 'waiting_confirmation'
  | 'done'
  | 'error';

export interface AgentActionEvent {
  type: string;
  action: string;
  result: string;
}

export interface AgentConfirmationEvent {
  action_id: string;
  action: string;
  description: string;
}

export interface AgentDoneEvent {
  summary: string;
}

interface UseAgentModeReturn {
  isActive: boolean;
  status: AgentStatus;
  lastAction: string | null;
  lastResult: string | null;
  reasoning: string | null;
  screenshotUrl: string | null;
  pendingConfirmation: AgentConfirmationEvent | null;
  start: (task: string) => Promise<void>;
  stop: () => Promise<void>;
  confirmAction: (actionId: string) => Promise<void>;
  rejectAction: (actionId: string) => Promise<void>;
}

export type AgentCompletePayload = { summary: string; isError: boolean };

export function useAgentMode(
  modelConfig: { active: string } | null,
  onComplete?: (payload: AgentCompletePayload) => void,
): UseAgentModeReturn {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<AgentConfirmationEvent | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const start = useCallback(
    async (task: string) => {
      setIsActive(true);
      setStatus('capturing');
      setLastAction(null);
      setLastResult(null);
      setReasoning(null);
      setScreenshotUrl(null);
      setPendingConfirmation(null);

      // Listen for agent events.
      const unlisten = await listen<{
        type: string;
        data?: unknown;
      }>('mate://agent', (event) => {
        const { type, data } = event.payload as { type: string; data?: unknown };

        switch (type) {
          case 'status_changed': {
            const newStatus = (data as AgentStatus) ?? 'idle';
            setStatus(newStatus);
            if (newStatus === 'done' || newStatus === 'error') {
              setIsActive(false);
            }
            break;
          }
          case 'action_executed': {
            const d = data as { action: string; result: string };
            setLastAction(d.action);
            setLastResult(d.result);
            break;
          }
          case 'reasoning': {
            setReasoning(data as string);
            break;
          }
          case 'screenshot_taken': {
            setScreenshotUrl(data as string);
            break;
          }
          case 'confirmation_required': {
            const d = data as AgentConfirmationEvent;
            setPendingConfirmation(d);
            break;
          }
          case 'error': {
            const errMsg = data as string;
            setLastResult(errMsg);
            setStatus('error');
            setIsActive(false);
            onCompleteRef.current?.({ summary: errMsg, isError: true });
            break;
          }
          case 'done': {
            const d = data as { summary: string };
            setReasoning(d.summary);
            setStatus('done');
            setIsActive(false);
            onCompleteRef.current?.({ summary: d.summary, isError: false });
            break;
          }
        }
      });

      unlistenRef.current = unlisten;

      const model = modelConfig?.active ?? 'llama3.2-vision';
      let ollamaUrl: string;
      try {
        ollamaUrl = await invoke<string>('get_ollama_url');
      } catch {
        ollamaUrl = 'http://127.0.0.1:11434';
      }

      // Re-sync the in-memory AgentState from persisted config before every run.
      // This is required because AgentState is reset on app restart, so we must
      // re-initialize it from the authoritative sources (TOML config + SQLite key)
      // rather than reading the stale in-memory value from get_agent_provider.
      try {
        const [savedConfig, settings] = await Promise.all([
          invoke<{ agent: { provider: string; model: string; base_url: string } }>('get_config'),
          invoke<Record<string, string>>('get_settings'),
        ]);
        const savedProvider = savedConfig.agent.provider;
        if (savedProvider && savedProvider !== 'ollama') {
          const apiKey = settings[`api_key_${savedProvider}`] ?? '';
          await invoke('set_agent_provider', {
            provider: savedProvider,
            model: savedConfig.agent.model,
            baseUrl: savedConfig.agent.base_url,
            apiKey,
          });
        }
      } catch {
        // Fall back to Ollama if config load fails.
      }

      try {
        await invoke('start_agent_mode', {
          task,
          model,
          ollamaUrl,
        });
      } catch (e) {
        console.error('Failed to start agent mode:', e);
        setStatus('error');
        setIsActive(false);
        setLastResult(String(e));
        unlisten();
      }
    },
    [modelConfig],
  );

  const stop = useCallback(async () => {
    try {
      await invoke('stop_agent_mode');
    } catch (e) {
      console.error('Failed to stop agent mode:', e);
    }
    setIsActive(false);
    setStatus('idle');
    setPendingConfirmation(null);
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  const confirmAction = useCallback(async (actionId: string) => {
    try {
      await invoke('confirm_agent_action', { actionId });
      setPendingConfirmation(null);
    } catch (e) {
      console.error('Failed to confirm action:', e);
    }
  }, []);

  const rejectAction = useCallback(async (actionId: string) => {
    try {
      await invoke('reject_agent_action', { actionId });
      setPendingConfirmation(null);
    } catch (e) {
      console.error('Failed to reject action:', e);
    }
  }, []);

  return {
    isActive,
    status,
    lastAction,
    lastResult,
    reasoning,
    screenshotUrl,
    pendingConfirmation,
    start,
    stop,
    confirmAction,
    rejectAction,
  };
}