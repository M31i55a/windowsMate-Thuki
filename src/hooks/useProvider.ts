/**
 * useProvider — manages the active LLM provider (Local Ollama or OpenRouter).
 *
 * Persists the user's choice to SQLite so it survives restarts.
 * On every mount, re-syncs the Rust in-memory AgentState/SharedChatProvider
 * from the stored values so the backend always matches what the user chose.
 */
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type ProviderMode = 'local' | 'openrouter';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

export const OPENROUTER_MODELS = [
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/o3-mini',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3-5-haiku',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'meta-llama/llama-4-scout',
  'meta-llama/llama-4-maverick',
  'mistralai/mistral-large',
  'deepseek/deepseek-r1',
  'x-ai/grok-3',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];

export interface ProviderState {
  mode: ProviderMode;
  /** OpenRouter connection info — null when not yet connected. */
  openRouter: {
    label: string;
    model: string;
    apiKey: string;
  } | null;
  /** True while an async operation (connect/disconnect) is in flight. */
  loading: boolean;
  /** Last connection error, if any. */
  error: string | null;
  connect: (apiKey: string, model: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setOpenRouterModel: (model: string) => Promise<void>;
}

async function syncBackend(provider: string, model: string, baseUrl: string, apiKey: string) {
  await invoke('set_agent_provider', {
    provider,
    model,
    baseUrl,
    apiKey,
  });
}

export function useProvider(): ProviderState {
  const [mode, setMode] = useState<ProviderMode>('local');
  const [openRouter, setOpenRouter] = useState<{
    label: string;
    model: string;
    apiKey: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, restore from SQLite and re-sync the backend.
  useEffect(() => {
    async function restore() {
      try {
        const settings = await invoke<Record<string, string>>('get_settings');
        const storedKey = settings['api_key_openrouter'] ?? '';
        const storedLabel = settings['openrouter_label'] ?? 'OpenRouter';
        const storedModel = settings['openrouter_model'] ?? DEFAULT_OPENROUTER_MODEL;
        const storedMode = (settings['provider_mode'] ?? 'local') as ProviderMode;

        if (storedMode === 'openrouter' && storedKey) {
          setMode('openrouter');
          setOpenRouter({ label: storedLabel, model: storedModel, apiKey: storedKey });
          // Re-sync backend (resets on every restart).
          await syncBackend('openrouter', storedModel, OPENROUTER_BASE_URL, storedKey);
        } else {
          // Ensure backend is set to ollama (clear any stale cloud config).
          await syncBackend('ollama', 'gemini-3-flash-preview', 'http://127.0.0.1:11434', '');
        }
      } catch {
        // Best-effort — fall back to local silently.
      }
    }
    void restore();
  }, []);

  const connect = useCallback(async (apiKey: string, model: string) => {
    setLoading(true);
    setError(null);
    try {
      // Validate key against OpenRouter API.
      const label = await invoke<string>('validate_openrouter_key', { apiKey });

      // Persist to SQLite.
      await invoke('set_setting', { key: 'api_key_openrouter', value: apiKey });
      await invoke('set_setting', { key: 'openrouter_label', value: label });
      await invoke('set_setting', { key: 'openrouter_model', value: model });
      await invoke('set_setting', { key: 'provider_mode', value: 'openrouter' });

      // Persist to TOML config.
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'openrouter' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: model });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: OPENROUTER_BASE_URL });

      // Sync in-memory backend.
      await syncBackend('openrouter', model, OPENROUTER_BASE_URL, apiKey);

      setOpenRouter({ label, model, apiKey });
      setMode('openrouter');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setLoading(true);
    try {
      await invoke('set_setting', { key: 'provider_mode', value: 'local' });
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'ollama' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: 'gemini-3-flash-preview' });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: 'http://127.0.0.1:11434' });
      await syncBackend('ollama', 'gemini-3-flash-preview', 'http://127.0.0.1:11434', '');
      setMode('local');
    } finally {
      setLoading(false);
    }
  }, []);

  const setOpenRouterModel = useCallback(async (model: string) => {
    if (!openRouter) return;
    const updated = { ...openRouter, model };
    await invoke('set_setting', { key: 'openrouter_model', value: model });
    await invoke('set_config_field', { section: 'agent', key: 'model', value: model });
    await syncBackend('openrouter', model, OPENROUTER_BASE_URL, openRouter.apiKey);
    setOpenRouter(updated);
  }, [openRouter]);

  return { mode, openRouter, loading, error, connect, disconnect, setOpenRouterModel };
}
