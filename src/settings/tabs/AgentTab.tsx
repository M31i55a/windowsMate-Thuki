/**
 * Agent tab - provider, model, base URL, and API key for agent mode.
 *
 * OpenRouter uses a dedicated "Connect" registration flow:
 * the user enters their key and clicks Connect, which validates it
 * against the OpenRouter API. On success the provider/model/base_url
 * are all switched to OpenRouter automatically. All other providers
 * keep the original form-based UX.
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { Section, TextField, Dropdown } from '../components';
import { SaveField } from '../components/SaveField';
import { configHelp } from '../configHelpers';
import type { RawAppConfig } from '../types';

type AgentProvider = 'ollama' | 'openai' | 'anthropic';

// OpenRouter is intentionally excluded from the generic dropdown —
// it has its own dedicated registration card below.
const PROVIDERS: AgentProvider[] = ['ollama', 'openai', 'anthropic'];
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  ollama: 'Ollama (Local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const PROVIDER_MODEL_SUGGESTIONS: Record<AgentProvider, readonly string[]> = {
  ollama: ['llama3.2-vision', 'llama3.2', 'mistral', 'gemma3', 'qwen2.5-vl'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini', 'o1'],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-haiku-20240307',
  ],
};

const OPENROUTER_DEFAULT_MODEL = 'google/gemini-2.5-flash';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const OPENROUTER_MODELS = [
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
] as const;

interface AgentTabProps {
  config: RawAppConfig;
  resyncToken: number;
  onSaved: (next: RawAppConfig) => void;
}

export function AgentTab({ config, resyncToken, onSaved }: AgentTabProps) {
  const [apiKey, setApiKey] = useState('');

  // OpenRouter registration state
  const [orKey, setOrKey] = useState('');
  const [orConnecting, setOrConnecting] = useState(false);
  const [orError, setOrError] = useState<string | null>(null);
  const [orLabel, setOrLabel] = useState<string | null>(null);
  const [orModel, setOrModel] = useState(OPENROUTER_DEFAULT_MODEL);

  const isOpenRouter = config.agent.provider === 'openrouter';
  const provider = isOpenRouter ? 'openai' : (config.agent.provider as AgentProvider);

  // Load API key and OpenRouter state from SQLite
  useEffect(() => {
    async function loadKeys() {
      try {
        const settings = await invoke<Record<string, string>>('get_settings');
        const prov = config.agent.provider;
        if (prov !== 'ollama' && prov !== 'openrouter' && settings[`api_key_${prov}`]) {
          setApiKey(settings[`api_key_${prov}`]);
        }
        if (settings['api_key_openrouter']) {
          setOrKey(settings['api_key_openrouter']);
          setOrLabel(settings['openrouter_label'] ?? 'OpenRouter');
        }
        if (settings['openrouter_model']) {
          setOrModel(settings['openrouter_model']);
        }
      } catch {
        // not set yet
      }
    }
    void loadKeys();
  }, [config.agent.provider]);

  async function saveApiKey(key: string) {
    try {
      if (provider !== 'ollama') {
        await invoke('set_setting', { key: `api_key_${provider}`, value: key });
        await invoke('set_agent_provider', {
          provider,
          model: config.agent.model,
          baseUrl: config.agent.base_url,
          apiKey: key,
        });
      }
    } catch {
      // ignore
    }
  }

  async function connectOpenRouter() {
    setOrConnecting(true);
    setOrError(null);
    try {
      const label = await invoke<string>('validate_openrouter_key', { apiKey: orKey });
      // Validation passed — persist and activate
      await invoke('set_setting', { key: 'api_key_openrouter', value: orKey });
      await invoke('set_setting', { key: 'openrouter_label', value: label });
      await invoke('set_setting', { key: 'openrouter_model', value: orModel });
      // Switch TOML config to openrouter
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'openrouter' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: orModel });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: OPENROUTER_BASE_URL });
      // Sync in-memory agent state
      await invoke('set_agent_provider', {
        provider: 'openrouter',
        model: orModel,
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: orKey,
      });
      // Refresh parent config
      const next = await invoke<RawAppConfig>('get_config');
      onSaved(next);
      setOrLabel(label);
    } catch (e) {
      setOrError(String(e));
    } finally {
      setOrConnecting(false);
    }
  }

  async function disconnectOpenRouter() {
    try {
      // Switch back to Ollama
      await invoke('set_config_field', { section: 'agent', key: 'provider', value: 'ollama' });
      await invoke('set_config_field', { section: 'agent', key: 'model', value: 'llama3.2' });
      await invoke('set_config_field', { section: 'agent', key: 'base_url', value: 'http://127.0.0.1:11434' });
      await invoke('set_agent_provider', {
        provider: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
      });
      const next = await invoke<RawAppConfig>('get_config');
      onSaved(next);
      setOrLabel(null);
    } catch {
      // ignore
    }
  }

  return (
    <>
      {/* ── OpenRouter registration card ── */}
      <Section heading="OpenRouter">
        {isOpenRouter && orLabel ? (
          // Connected state
          <div className="flex flex-col gap-3">
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              style={{ background: 'rgba(80, 200, 120, 0.08)', border: '1px solid rgba(80, 200, 120, 0.2)' }}
            >
              <span style={{ color: '#50c878', fontSize: 15 }}>✓</span>
              <span className="text-xs font-medium" style={{ color: '#50c878' }}>
                Connected — {orLabel}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                Model
              </label>
              <select
                value={orModel}
                onChange={async (e) => {
                  const m = e.target.value;
                  setOrModel(m);
                  await invoke('set_setting', { key: 'openrouter_model', value: m });
                  await invoke('set_config_field', { section: 'agent', key: 'model', value: m });
                  await invoke('set_agent_provider', {
                    provider: 'openrouter',
                    model: m,
                    baseUrl: OPENROUTER_BASE_URL,
                    apiKey: orKey,
                  });
                  const next = await invoke<RawAppConfig>('get_config');
                  onSaved(next);
                }}
                className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
                style={{ color: 'var(--color-text-primary)', padding: '4px 0' }}
              >
                {OPENROUTER_MODELS.map((m) => (
                  <option key={m} value={m} style={{ background: '#1a1512' }}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => void disconnectOpenRouter()}
              className="text-xs self-start"
              style={{ color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          // Registration form
          <div className="flex flex-col gap-3">
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Connect OpenRouter to use any model (GPT-4o, Gemini, Claude, Llama…) with a single API key.
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                API Key
              </label>
              <input
                type="password"
                value={orKey}
                onChange={(e) => { setOrKey(e.target.value); setOrError(null); }}
                placeholder="sk-or-v1-..."
                className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
                style={{ color: 'var(--color-text-primary)', padding: '4px 0' }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                Model
              </label>
              <select
                value={orModel}
                onChange={(e) => setOrModel(e.target.value)}
                className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
                style={{ color: 'var(--color-text-primary)', padding: '4px 0' }}
              >
                {OPENROUTER_MODELS.map((m) => (
                  <option key={m} value={m} style={{ background: '#1a1512' }}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            {orError ? (
              <p className="text-xs" style={{ color: '#ff8a80' }}>{orError}</p>
            ) : null}
            <button
              type="button"
              onClick={() => void connectOpenRouter()}
              disabled={orConnecting || orKey.trim().length === 0}
              className="self-start text-xs font-medium rounded-lg px-3 py-1.5 transition-opacity"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                border: 'none',
                cursor: orConnecting || orKey.trim().length === 0 ? 'not-allowed' : 'pointer',
                opacity: orConnecting || orKey.trim().length === 0 ? 0.5 : 1,
              }}
            >
              {orConnecting ? 'Connecting…' : 'Connect'}
            </button>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Get a key at{' '}
              <span style={{ color: 'var(--color-text-primary)' }}>openrouter.ai/keys</span>
            </p>
          </div>
        )}
      </Section>

      {/* ── Generic provider (Ollama / OpenAI / Anthropic) — hidden when OpenRouter is active ── */}
      {!isOpenRouter ? (
        <>
          <Section heading="Provider">
            <SaveField
              section="agent"
              fieldKey="provider"
              label="Provider"
              helper={configHelp('agent', 'provider')}
              initialValue={config.agent.provider}
              resyncToken={resyncToken}
              onSaved={onSaved}
              render={(value, setValue) => (
                <Dropdown
                  value={value as AgentProvider}
                  options={PROVIDERS}
                  onChange={(next) => setValue(next)}
                  ariaLabel="Agent provider"
                />
              )}
            />
          </Section>

          <Section heading="Model">
            <SaveField
              section="agent"
              fieldKey="model"
              label="Agent model"
              helper={configHelp('agent', 'model')}
              initialValue={config.agent.model}
              resyncToken={resyncToken}
              onSaved={onSaved}
              render={(value, setValue, errored) => (
                <TextField
                  value={value}
                  onChange={setValue}
                  placeholder="e.g. llama3.2, gpt-4o, claude-sonnet-4-20250514"
                  errored={errored}
                  ariaLabel="Agent model"
                  suggestions={PROVIDER_MODEL_SUGGESTIONS[provider] ?? []}
                />
              )}
            />
          </Section>

          <Section heading="Connection">
            <SaveField
              section="agent"
              fieldKey="base_url"
              label="Base URL"
              helper={configHelp('agent', 'base_url')}
              initialValue={config.agent.base_url}
              resyncToken={resyncToken}
              onSaved={onSaved}
              render={(value, setValue, errored) => (
                <TextField
                  value={value}
                  onChange={setValue}
                  placeholder={
                    provider === 'openai'
                      ? 'https://api.openai.com/v1'
                      : provider === 'anthropic'
                        ? 'https://api.anthropic.com'
                        : 'http://127.0.0.1:11434'
                  }
                  errored={errored}
                  ariaLabel="Agent base URL"
                />
              )}
            />
          </Section>

          {provider !== 'ollama' ? (
            <Section heading="API Key">
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  API Key ({PROVIDER_LABELS[provider]})
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => void saveApiKey(apiKey)}
                  placeholder={provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                  className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
                  style={{ color: 'var(--color-text-primary)', padding: '4px 0' }}
                />
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  Stored securely in local database, not in config.toml.
                </span>
              </div>
            </Section>
          ) : null}
        </>
      ) : null}
    </>
  );
}
