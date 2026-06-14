/**
 * useProvider — manages the active LLM provider (Local Ollama or OpenRouter).
 *
 * Persists the user's choice to SQLite so it survives restarts.
 * On every mount, re-syncs the Rust in-memory AgentState/SharedChatProvider
 * from the stored values so the backend always matches what the user chose.
 */
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type ProviderMode = 'local' | 'openrouter' | 'test';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Claude API key for testing.
 * Loaded from environment variable VITE_CLAUDE_API_KEY
 * Set this in your .env file with your actual Anthropic API key
 * e.g. `VITE_CLAUDE_API_KEY=sk-12345678901234567890123456789012`
 */
const DEFAULT_CLAUDE_API_KEY = import.meta.env.VITE_CLAUDE_API_KEY || '';



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
  'inclusionai/ring-2.6-1t:free',
  'arcee-ai/trinity-large-thinking:free',
  'baidu/cobuddy:free',
  'poolside/laguna-xs.2:free',
  'minimax/minimax-m2.5:free',
  'liquid/lfm-2.5-1.2b-thinking:free',
  'openai/gpt-oss-120b:free',
  'qwen/qwen3-coder:free',
] as const;

export const CLAUDE_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-haiku-4-5',
  'claude-opus-4-1-20250805',
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export interface ProviderState {
  mode: ProviderMode;
  /** OpenRouter connection info — null when not yet connected. */
  openRouter: {
    label: string;
    model: string;
    apiKey: string;
  } | null;
  /** Claude test connection info — null when not yet connected. */
  claude: {
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
  setClaudeModel: (model: string) => Promise<void>;
  connectClaude: (apiKey: string, model: string) => Promise<void>;
  disconnectClaude: () => Promise<void>;
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
  const [mode, setMode] = useState<ProviderMode>('test');
  const [openRouter, setOpenRouter] = useState<{
    label: string;
    model: string;
    apiKey: string;
  } | null>(null);
  const [claude, setClaude] = useState<{
    label: string;
    model: string;
    apiKey: string;
  } | null>({
    label: 'Claude',
    model: DEFAULT_CLAUDE_MODEL,
    apiKey: DEFAULT_CLAUDE_API_KEY,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, restore from SQLite and re-sync the backend.
  useEffect(() => {
    async function restore() {
      try {
        const settings = await invoke<Record<string, string>>('get_settings');
        const storedMode = (settings['provider_mode'] ?? 'test') as ProviderMode;

        if (storedMode === 'openrouter') {
          const storedKey = settings['api_key_openrouter'] ?? '';
          const storedLabel = settings['openrouter_label'] ?? 'OpenRouter';
          const storedModel = settings['openrouter_model'] ?? DEFAULT_OPENROUTER_MODEL;
          if (storedKey) {
            setMode('openrouter');
            setOpenRouter({ label: storedLabel, model: storedModel, apiKey: storedKey });
            // Re-sync backend (resets on every restart).
            await syncBackend('openrouter', storedModel, OPENROUTER_BASE_URL, storedKey);
          }
        } else if (storedMode === 'test') {
          const storedKey = settings['api_key_claude'] ?? DEFAULT_CLAUDE_API_KEY;
          const storedLabel = settings['claude_label'] ?? 'Claude';
          const storedModel = settings['claude_model'] ?? DEFAULT_CLAUDE_MODEL;
          setMode('test');
          setClaude({ label: storedLabel, model: storedModel, apiKey: storedKey });
          // Re-sync backend (resets on every restart).
          await syncBackend('claude', storedModel, CLAUDE_BASE_URL, storedKey);
        } else {
          // Default to test mode
          setMode('test');
          setClaude({
            label: 'Claude',
            model: DEFAULT_CLAUDE_MODEL,
            apiKey: DEFAULT_CLAUDE_API_KEY,
          });
          await syncBackend('claude', DEFAULT_CLAUDE_MODEL, CLAUDE_BASE_URL, DEFAULT_CLAUDE_API_KEY);
        }
      } catch {
        // Best-effort — fall back to test mode silently.
        setMode('test');
        setClaude({
          label: 'Claude',
          model: DEFAULT_CLAUDE_MODEL,
          apiKey: DEFAULT_CLAUDE_API_KEY,
        });
        // Sync to backend on error
        try {
          await syncBackend('claude', DEFAULT_CLAUDE_MODEL, CLAUDE_BASE_URL, DEFAULT_CLAUDE_API_KEY);
        } catch {
          // Silently ignore sync errors
        }
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
      // Grant screenshot consent once \u2014 the user chose an online provider and
      // is aware that task screenshots are sent to the cloud.
      await invoke('set_setting', { key: 'agent_screenshot_consent', value: 'true' });

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

  const connectClaude = useCallback(async (apiKey: string, model: string) => {
    setLoading(true);
    setError(null);
    try {
      // Validate key against Claude API.
      const label = await invoke<string>('validate_claude_key', { apiKey });

      // Persist to SQLite.
      await invoke('set_setting', { key: 'api_key_claude', value: apiKey });
      await invoke('set_setting', { key: 'claude_label', value: label });
      await invoke('set_setting', { key: 'claude_model', value: model });
      await invoke('set_setting', { key: 'provider_mode', value: 'test' });
      // Grant screenshot consent once — the user chose a paid provider and
      // is aware that task screenshots are sent to the cloud.
      await invoke('set_setting', { key: 'agent_screenshot_consent', value: 'true' });

      // Persist to TOML config.
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'claude' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: model });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: CLAUDE_BASE_URL });

      // Sync in-memory backend.
      await syncBackend('claude', model, CLAUDE_BASE_URL, apiKey);

      setClaude({ label, model, apiKey });
      setMode('test');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnectClaude = useCallback(async () => {
    setLoading(true);
    try {
      await invoke('set_setting', { key: 'provider_mode', value: 'local' });
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'ollama' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: 'gemini-3-flash-preview' });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: 'http://127.0.0.1:11434' });
      await syncBackend('ollama', 'gemini-3-flash-preview', 'http://127.0.0.1:11434', '');
      setMode('local');
      setClaude(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const setClaudeModel = useCallback(async (model: string) => {
    if (!claude) return;
    const updated = { ...claude, model };
    await invoke('set_setting', { key: 'claude_model', value: model });
    await invoke('set_config_field', { section: 'agent', key: 'model', value: model });
    await syncBackend('claude', model, CLAUDE_BASE_URL, claude.apiKey);
    setClaude(updated);
  }, [claude]);

  return {
    mode,
    openRouter,
    claude,
    loading,
    error,
    connect,
    disconnect,
    setOpenRouterModel,
    connectClaude,
    disconnectClaude,
    setClaudeModel,
  };
}
