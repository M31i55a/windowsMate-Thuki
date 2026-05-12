/**
 * ProviderPickerPanel — wraps ModelPickerPanel with a Local / Online tab switcher.
 *
 * Local tab: existing Ollama model list (delegates fully to ModelPickerPanel).
 * Online tab: OpenRouter model list; prompts for API key inline if not connected.
 */
import { useState } from 'react';
import type { ModelCapabilitiesMap } from '../types/model';
import { ModelPickerPanel } from './ModelPickerPanel';
import { OPENROUTER_MODELS } from '../hooks/useProvider';
import type { ProviderState } from '../hooks/useProvider';

export interface ProviderPickerPanelProps {
  /** Local Ollama models available. */
  models: string[];
  /** Currently active local Ollama model. */
  activeLocalModel: string | null;
  /** Called when the user picks a local Ollama model. */
  onSelectLocal: (model: string) => void;
  /** Called when the user requests panel close (Escape). */
  onClose?: () => void;
  /** Per-model capability map for Ollama models. */
  capabilities?: ModelCapabilitiesMap;
  compact?: boolean;
  /** Provider state from useProvider hook. */
  provider: ProviderState;
}

/** Cloud/globe icon for the Online tab. */
const GLOBE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </svg>
);

/** Local/chip icon for the Local tab. */
const CPU_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="3" />
    <path d="M9 2v20M15 2v20M2 9h20M2 15h20" />
  </svg>
);

/** Check icon inline. */
const CHECK_ICON = (
  <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ProviderPickerPanel({
  models,
  activeLocalModel,
  onSelectLocal,
  onClose,
  capabilities,
  compact = false,
  provider,
}: ProviderPickerPanelProps) {
  const [tab, setTab] = useState<'local' | 'online'>(provider.mode === 'openrouter' ? 'online' : 'local');
  const [keyInput, setKeyInput] = useState('');
  const [selectedOrModel, setSelectedOrModel] = useState(
    provider.openRouter?.model ?? OPENROUTER_MODELS[0],
  );

  const isConnected = provider.openRouter !== null && provider.mode === 'openrouter';

  async function handleConnect() {
    if (!keyInput.trim()) return;
    await provider.connect(keyInput.trim(), selectedOrModel);
    setKeyInput('');
  }

  async function handleSelectOnlineModel(model: string) {
    setSelectedOrModel(model);
    if (provider.openRouter) {
      await provider.setOpenRouterModel(model);
    }
    onClose?.();
  }

  async function handleDisconnect() {
    await provider.disconnect();
    setTab('local');
    onClose?.();
  }

  return (
    <div className="flex flex-col w-full">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-2 border-b border-surface-border">
        <button
          type="button"
          onClick={() => setTab('local')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors duration-120 outline-none ${
            tab === 'local'
              ? 'bg-primary/15 text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
          }`}
        >
          {CPU_ICON}
          Local
        </button>
        <button
          type="button"
          onClick={() => setTab('online')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors duration-120 outline-none ${
            tab === 'online'
              ? 'bg-primary/15 text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
          }`}
        >
          {GLOBE_ICON}
          Online
          {isConnected && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
          )}
        </button>
      </div>

      {tab === 'local' ? (
        <ModelPickerPanel
          models={models}
          activeModel={activeLocalModel}
          onSelect={(model) => {
            onSelectLocal(model);
          }}
          onClose={onClose}
          capabilities={capabilities}
          compact={compact}
        />
      ) : (
        <div className="flex flex-col">
          {isConnected ? (
            /* Connected state: show model list */
            <>
              <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2">
                <span className="text-[10.5px] text-text-secondary">
                  <span className="text-green-400 font-medium">●</span>{' '}
                  {provider.openRouter!.label}
                </span>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  className="text-[10.5px] text-text-secondary hover:text-red-400 transition-colors duration-120 outline-none"
                >
                  Disconnect
                </button>
              </div>
              <div className="overflow-y-auto py-1 max-h-[280px]">
                {OPENROUTER_MODELS.map((model) => {
                  const active = model === provider.openRouter?.model;
                  return (
                    <button
                      key={model}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => void handleSelectOnlineModel(model)}
                      className="flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg w-full text-left text-sm text-text-primary cursor-pointer transition-colors duration-120 hover:bg-white/5"
                    >
                      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-tight">
                        {model}
                      </span>
                      <span style={{ opacity: active ? 1 : 0 }}>{CHECK_ICON}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            /* Disconnected state: API key input */
            <div className="px-3 py-3 flex flex-col gap-3">
              <p className="text-xs text-text-secondary leading-relaxed">
                Connect your{' '}
                <span className="text-text-primary font-medium">OpenRouter</span> API key to access
                cloud models like GPT-4o, Claude, and Gemini.
              </p>

              {/* Model selector */}
              <div className="flex flex-col gap-1">
                <label className="text-[10.5px] text-text-secondary">Model</label>
                <select
                  value={selectedOrModel}
                  onChange={(e) => setSelectedOrModel(e.target.value)}
                  className="w-full bg-surface-overlay border border-surface-border rounded-lg px-2 py-1.5 text-xs text-text-primary outline-none appearance-none cursor-pointer"
                  style={{ backgroundImage: 'none' }}
                >
                  {OPENROUTER_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* Key input */}
              <div className="flex flex-col gap-1">
                <label className="text-[10.5px] text-text-secondary">API Key</label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleConnect();
                    if (e.key === 'Escape') onClose?.();
                  }}
                  placeholder="sk-or-..."
                  autoFocus
                  className="w-full bg-surface-overlay border border-surface-border rounded-lg px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary outline-none focus:border-primary/50"
                />
              </div>

              {provider.error && (
                <p className="text-[10.5px] text-red-400 leading-relaxed">{provider.error}</p>
              )}

              <button
                type="button"
                onClick={() => void handleConnect()}
                disabled={provider.loading || !keyInput.trim()}
                className="w-full py-1.5 rounded-lg text-xs font-medium bg-primary text-white disabled:opacity-40 hover:opacity-90 transition-opacity duration-120 outline-none cursor-pointer disabled:cursor-not-allowed"
              >
                {provider.loading ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
