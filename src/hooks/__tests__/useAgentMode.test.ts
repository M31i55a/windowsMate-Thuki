import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentMode } from '../useAgentMode';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clearEventHandlers } from '../../testUtils/mocks/tauri';

// These are the project's vitest-alias mocks from testUtils/mocks/tauri.ts
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

describe('useAgentMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: get_ollama_url succeeds, get_config returns ollama, get_settings is empty.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_ollama_url') return Promise.resolve('http://127.0.0.1:11434');
      if (cmd === 'get_config')
        return Promise.resolve({
          agent: { provider: 'ollama', model: 'llama3.2', base_url: 'http://127.0.0.1:11434' },
        });
      if (cmd === 'get_settings') return Promise.resolve({});
      return Promise.resolve(undefined);
    });
    mockListen.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEventHandlers();
  });

  it('should start in idle state', () => {
    const { result } = renderHook(() => useAgentMode(null));
    expect(result.current.isActive).toBe(false);
    expect(result.current.status).toBe('idle');
    expect(result.current.lastAction).toBeNull();
    expect(result.current.lastResult).toBeNull();
    expect(result.current.reasoning).toBeNull();
    expect(result.current.screenshotUrl).toBeNull();
  });

  it('should expose start and stop functions', () => {
    const { result } = renderHook(() => useAgentMode(null));
    expect(typeof result.current.start).toBe('function');
    expect(typeof result.current.stop).toBe('function');
  });

  it('should set error state when start_agent_mode rejects', async () => {
    // get_ollama_url succeeds, but start_agent_mode fails.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_ollama_url') return Promise.resolve('http://127.0.0.1:11434');
      if (cmd === 'get_config')
        return Promise.resolve({
          agent: { provider: 'ollama', model: 'llama3.2', base_url: 'http://127.0.0.1:11434' },
        });
      if (cmd === 'get_settings') return Promise.resolve({});
      if (cmd === 'start_agent_mode') return Promise.reject(new Error('Failed'));
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('Test');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.isActive).toBe(false);
  });

  it('should transition to idle when stopped', async () => {
    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('Test');
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.status).toBe('idle');
  });

  it('should clear previous state on start', async () => {
    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('Test task');
    });

    await act(async () => {
      await result.current.start('New task');
    });

    expect(result.current.lastAction).toBeNull();
    expect(result.current.reasoning).toBeNull();
    expect(result.current.screenshotUrl).toBeNull();
  });

  it('calls set_agent_provider with real api key when cloud provider is configured', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_ollama_url') return Promise.resolve('http://127.0.0.1:11434');
      if (cmd === 'get_config')
        return Promise.resolve({
          agent: {
            provider: 'openrouter',
            model: 'openai/gpt-4o',
            base_url: 'https://openrouter.ai/api/v1',
          },
        });
      if (cmd === 'get_settings')
        return Promise.resolve({ api_key_openrouter: 'sk-or-v1-test' });
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('Test');
    });

    const setProviderCall = mockInvoke.mock.calls.find(
      ([cmd]: [string]) => cmd === 'set_agent_provider',
    );
    expect(setProviderCall).toBeDefined();
    expect(setProviderCall![1]).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-test',
    });
  });

  it('does not call set_agent_provider when provider is ollama', async () => {
    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('Test');
    });

    const setProviderCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === 'set_agent_provider',
    );
    expect(setProviderCalls).toHaveLength(0);
  });

  it('calls onComplete with summary and isError:false when done event fires', async () => {
    // Capture the agent event listener so we can trigger it directly in the test.
    let capturedHandler: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event === 'mate://agent') capturedHandler = handler;
        return vi.fn();
      },
    );

    const onComplete = vi.fn();
    const { result } = renderHook(() => useAgentMode(null, onComplete));

    await act(async () => {
      await result.current.start('open notepad');
    });

    act(() => {
      capturedHandler?.({ payload: { type: 'done', data: { summary: 'Notepad opened.' } } });
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ summary: 'Notepad opened.', isError: false });
    expect(result.current.isActive).toBe(false);
    expect(result.current.status).toBe('done');
  });

  it('calls onComplete with error message and isError:true when error event fires', async () => {
    let capturedHandler: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event === 'mate://agent') capturedHandler = handler;
        return vi.fn();
      },
    );

    const onComplete = vi.fn();
    const { result } = renderHook(() => useAgentMode(null, onComplete));

    await act(async () => {
      await result.current.start('open notepad');
    });

    act(() => {
      capturedHandler?.({ payload: { type: 'error', data: 'Ollama query failed' } });
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ summary: 'Ollama query failed', isError: true });
    expect(result.current.isActive).toBe(false);
    expect(result.current.status).toBe('error');
  });

  it('does not call onComplete when no callback is provided', async () => {
    let capturedHandler: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event === 'mate://agent') capturedHandler = handler;
        return vi.fn();
      },
    );

    const { result } = renderHook(() => useAgentMode(null));

    await act(async () => {
      await result.current.start('open notepad');
    });

    // Should not throw — just verify hook works fine without callback.
    act(() => {
      capturedHandler?.({ payload: { type: 'done', data: { summary: 'Done.' } } });
    });

    expect(result.current.isActive).toBe(false);
  });
});