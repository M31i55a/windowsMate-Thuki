import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProvider, CLAUDE_MODELS } from '../useProvider';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('useProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('initializes to test mode with Claude', () => {
      vi.mocked(invoke).mockResolvedValue({});
      const { result } = renderHook(() => useProvider());
      expect(result.current.mode).toBe('test');
      expect(result.current.openRouter).toBeNull();
      expect(result.current.claude).not.toBeNull();
      expect(result.current.claude?.label).toBe('Claude');
    });

    it('restores openrouter mode from settings', async () => {
      vi.mocked(invoke).mockImplementation((cmd) => {
        if (cmd === 'get_settings') {
          return Promise.resolve({
            provider_mode: 'openrouter',
            api_key_openrouter: 'sk-or-test',
            openrouter_label: 'OpenRouter',
            openrouter_model: 'openai/gpt-4o',
          });
        }
        return Promise.resolve({});
      });

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('openrouter');
      });

      expect(result.current.openRouter).toEqual({
        label: 'OpenRouter',
        model: 'openai/gpt-4o',
        apiKey: 'sk-or-test',
      });
    });

     it('restores test mode (claude) from settings', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'get_settings') {
           return Promise.resolve({
             provider_mode: 'test',
             api_key_claude: 'test-key-123',
             claude_label: 'Claude',
             claude_model: 'claude-3-5-sonnet-20241022',
           });
         }
         return Promise.resolve({});
       });

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      expect(result.current.claude).not.toBeNull();
      expect(result.current.claude?.label).toBe('Claude');
      expect(result.current.claude?.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('falls back to test mode on error', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('test error'));
      const { result } = renderHook(() => useProvider());
      await waitFor(() => {
        expect(result.current.mode).toBe('test');
        expect(result.current.claude).not.toBeNull();
      });
    });
  });

  describe('Claude connection', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockResolvedValue({});
    });

     it('connects with valid Claude API key', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'validate_claude_key') {
           return Promise.resolve('Claude User');
         }
         return Promise.resolve({});
       });

       const { result } = renderHook(() => useProvider());

       await act(async () => {
         await result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

       expect(result.current.mode).toBe('test');
       expect(result.current.claude).toEqual({
         label: 'Claude User',
         model: 'claude-3-5-sonnet-20241022',
         apiKey: 'test-key-123',
       });
       expect(result.current.loading).toBe(false);
       expect(result.current.error).toBeNull();
     });

    it('persists Claude model changes', async () => {
      vi.mocked(invoke).mockResolvedValue({});

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      await act(async () => {
        await result.current.setClaudeModel('claude-3-5-haiku-20241022');
      });

      expect(result.current.claude?.model).toBe('claude-3-5-haiku-20241022');
    });

     it('persists Claude settings to SQLite and config', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'validate_claude_key') {
           return Promise.resolve('Claude User');
         }
         return Promise.resolve({});
       });

       const { result } = renderHook(() => useProvider());

       await act(async () => {
         await result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

       expect(invoke).toHaveBeenCalledWith('set_setting', {
         key: 'api_key_claude',
         value: 'test-key-123',
       });
      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'claude_label',
        value: 'Claude User',
      });
      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'claude_model',
        value: 'claude-3-5-sonnet-20241022',
      });
      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'provider_mode',
        value: 'test',
      });
      expect(invoke).toHaveBeenCalledWith('set_config_field', {
        section: 'agent',
        key: 'provider',
        value: 'claude',
      });
    });

     it('sets screenshot consent when connecting to Claude', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'validate_claude_key') {
           return Promise.resolve('Claude User');
         }
         return Promise.resolve({});
       });

       const { result } = renderHook(() => useProvider());

       await act(async () => {
         await result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'agent_screenshot_consent',
        value: 'true',
      });
    });

     it('sets loading state during connection', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'validate_claude_key') {
           return new Promise((resolve) => setTimeout(() => resolve('Claude User'), 100));
         }
         return Promise.resolve({});
       });

       const { result } = renderHook(() => useProvider());

       act(() => {
         void result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  describe('Claude disconnection', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockResolvedValue({});
    });

     it('disconnects from Claude and reverts to local', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'get_settings') {
           return Promise.resolve({
             provider_mode: 'test',
             api_key_claude: 'test-key-123',
             claude_label: 'Claude',
             claude_model: 'claude-3-5-sonnet-20241022',
           });
         }
         return Promise.resolve({});
       });

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      await act(async () => {
        await result.current.disconnectClaude();
      });

      expect(result.current.mode).toBe('local');
      expect(result.current.claude).toBeNull();
    });

    it('persists disconnection to SQLite and config', async () => {
      vi.mocked(invoke).mockResolvedValue({});

      const { result } = renderHook(() => useProvider());

      await act(async () => {
        await result.current.disconnectClaude();
      });

      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'provider_mode',
        value: 'local',
      });
      expect(invoke).toHaveBeenCalledWith('set_config_field', {
        section: 'agent',
        key: 'provider',
        value: 'ollama',
      });
    });
  });

  describe('Claude model selection', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockImplementation((cmd) => {
        if (cmd === 'validate_claude_key') {
          return Promise.resolve('Claude User');
        }
        return Promise.resolve({});
      });
    });

     it('updates Claude model when connected', async () => {
       const { result } = renderHook(() => useProvider());

       await act(async () => {
         await result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

      await act(async () => {
        await result.current.setClaudeModel('claude-3-5-haiku-20241022');
      });

      expect(result.current.claude?.model).toBe('claude-3-5-haiku-20241022');
      expect(invoke).toHaveBeenCalledWith('set_setting', {
        key: 'claude_model',
        value: 'claude-3-5-haiku-20241022',
      });
    });

    it('claude is always connected in test mode', async () => {
      vi.mocked(invoke).mockResolvedValue({});
      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      expect(result.current.claude).not.toBeNull();
    });

    it('syncs model change to backend', async () => {
      vi.mocked(invoke).mockResolvedValue({});
      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      vi.clearAllMocks();
      vi.mocked(invoke).mockResolvedValue({});

      await act(async () => {
        await result.current.setClaudeModel('claude-opus-4-1-20250805');
      });

      expect(invoke).toHaveBeenCalledWith('set_agent_provider', {
        provider: 'claude',
        model: 'claude-opus-4-1-20250805',
        baseUrl: 'https://api.anthropic.com',
        apiKey: expect.any(String),
      });
    });
  });

  describe('OpenRouter operations', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockResolvedValue({});
    });

    it('connects with OpenRouter API key', async () => {
      vi.mocked(invoke).mockImplementation((cmd) => {
        if (cmd === 'validate_openrouter_key') {
          return Promise.resolve('OpenRouter User');
        }
        return Promise.resolve({});
      });

      const { result } = renderHook(() => useProvider());

      await act(async () => {
        await result.current.connect('sk-or-test', 'openai/gpt-4o');
      });

      expect(result.current.mode).toBe('openrouter');
      expect(result.current.openRouter?.model).toBe('openai/gpt-4o');
    });

     it('switches from Claude to OpenRouter', async () => {
       vi.mocked(invoke).mockImplementation((cmd) => {
         if (cmd === 'get_settings') {
           return Promise.resolve({
             provider_mode: 'test',
             api_key_claude: 'test-key-123',
             claude_label: 'Claude',
             claude_model: 'claude-3-5-sonnet-20241022',
           });
         }
         if (cmd === 'validate_openrouter_key') {
           return Promise.resolve('OpenRouter User');
         }
         return Promise.resolve({});
       });

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('test');
      });

      await act(async () => {
        await result.current.connect('sk-or-test', 'openai/gpt-4o');
      });

      expect(result.current.mode).toBe('openrouter');
      expect(result.current.openRouter?.model).toBe('openai/gpt-4o');
    });

    it('switches from OpenRouter to Claude', async () => {
      vi.mocked(invoke).mockImplementation((cmd) => {
        if (cmd === 'get_settings') {
          return Promise.resolve({
            provider_mode: 'openrouter',
            api_key_openrouter: 'sk-or-test',
            openrouter_label: 'OpenRouter',
            openrouter_model: 'openai/gpt-4o',
          });
        }
        if (cmd === 'validate_claude_key') {
          return Promise.resolve('Claude User');
        }
        return Promise.resolve({});
      });

      const { result } = renderHook(() => useProvider());

      await waitFor(() => {
        expect(result.current.mode).toBe('openrouter');
      });

       await act(async () => {
         await result.current.connectClaude('test-key-123', 'claude-3-5-sonnet-20241022');
       });

       expect(result.current.mode).toBe('test');
       expect(result.current.claude?.model).toBe('claude-3-5-sonnet-20241022');
     });
   });

   describe('Claude models list', () => {
    it('has Claude models available', () => {
      expect(Array.isArray(CLAUDE_MODELS)).toBe(true);
      expect(CLAUDE_MODELS.length).toBeGreaterThan(0);
    });
  });
});
