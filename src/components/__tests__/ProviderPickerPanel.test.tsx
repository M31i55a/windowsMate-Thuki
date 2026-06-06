import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderPickerPanel } from '../ProviderPickerPanel';
import { CLAUDE_MODELS } from '../../hooks/useProvider';
import type { ProviderState } from '../../hooks/useProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

function createMockProvider(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    mode: 'local',
    openRouter: null,
    claude: null,
    loading: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    setOpenRouterModel: vi.fn(),
    connectClaude: vi.fn(),
    disconnectClaude: vi.fn(),
    setClaudeModel: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ProviderPickerPanel>> = {},
) {
  const props: React.ComponentProps<typeof ProviderPickerPanel> = {
    models: ['llama2', 'mistral'],
    activeLocalModel: 'llama2',
    onSelectLocal: vi.fn(),
    provider: createMockProvider(),
    ...overrides,
  };
  return { props, ...render(<ProviderPickerPanel {...props} />) };
}

describe('ProviderPickerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tab switching', () => {
    it('renders three tabs: Local, Online, Test', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /local/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /online/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /test/i })).toBeInTheDocument();
    });

    it('shows local tab by default', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /local/i })).toHaveClass('bg-primary/15');
    });

    it('switches to online tab when clicked', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      expect(screen.getByRole('button', { name: /online/i })).toHaveClass('bg-primary/15');
    });

    it('switches to test tab when clicked', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      expect(screen.getByRole('button', { name: /test/i })).toHaveClass('bg-primary/15');
    });

    it('shows active tab content after switching', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      expect(screen.getByText(/claude api/i)).toBeInTheDocument();
    });
  });

  describe('local tab', () => {
    it('renders local Ollama models', () => {
      renderPanel();
      expect(screen.getByText('llama2')).toBeInTheDocument();
      expect(screen.getByText('mistral')).toBeInTheDocument();
    });

    it('calls onSelectLocal when a model is clicked', () => {
      const onSelectLocal = vi.fn();
      renderPanel({ onSelectLocal });
      fireEvent.click(screen.getByRole('option', { name: /mistral/i }));
      expect(onSelectLocal).toHaveBeenCalledWith('mistral');
    });

    it('marks active local model as selected', () => {
      renderPanel({ activeLocalModel: 'mistral' });
      const mistralOption = screen.getByRole('option', { name: /mistral/i });
      expect(mistralOption).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('online tab', () => {
    it('shows connection prompt when not connected', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      expect(screen.getByText(/openrouter/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/sk-or-/i)).toBeInTheDocument();
    });

    it('shows green indicator when connected to OpenRouter', () => {
       renderPanel({
         provider: createMockProvider({
           mode: 'openrouter',
           openRouter: {
             label: 'OpenRouter User',
             model: 'openai/gpt-4o',
             apiKey: 'test-or-key',
           },
         }),
       });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      const indicator = screen.getByRole('button', { name: /online/i }).querySelector('.bg-green-400');
      expect(indicator).toBeInTheDocument();
    });

    it('shows model list when connected', () => {
       const setOpenRouterModel = vi.fn();
       renderPanel({
         provider: createMockProvider({
           mode: 'openrouter',
           openRouter: {
             label: 'OpenRouter User',
             model: 'openai/gpt-4o',
             apiKey: 'test-or-key',
           },
           setOpenRouterModel,
         }),
       });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      const options = screen.getAllByRole('option');
      const found = options.some(opt => opt.textContent?.includes('openai/gpt-4o'));
      expect(found).toBe(true);
    });

    it('calls connect when API key is entered and Connect is clicked', async () => {
      const connect = vi.fn();
      renderPanel({
        provider: createMockProvider({ connect }),
      });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));

       const keyInput = screen.getByPlaceholderText(/sk-or-/i);
       fireEvent.change(keyInput, { target: { value: 'test-or-key' } });

      const connectButton = screen.getByRole('button', { name: /connect/i });
      fireEvent.click(connectButton);

      await waitFor(() => {
        expect(connect).toHaveBeenCalled();
      });
    });

    it('disables Connect button when key is empty', () => {
      renderPanel({
        provider: createMockProvider(),
      });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      const connectButton = screen.getByRole('button', { name: /connect/i });
      expect(connectButton).toBeDisabled();
    });

    it('shows error message when connection fails', () => {
      renderPanel({
        provider: createMockProvider({
          error: 'Invalid API key',
        }),
      });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      expect(screen.getByText('Invalid API key')).toBeInTheDocument();
    });

    it('shows Connecting state during connection', () => {
      renderPanel({
        provider: createMockProvider({ loading: true }),
      });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      expect(screen.getByText(/connecting…/i)).toBeInTheDocument();
    });

     it('calls disconnect when disconnect button is clicked', async () => {
       const disconnect = vi.fn();
       renderPanel({
         provider: createMockProvider({
           mode: 'openrouter',
           openRouter: {
             label: 'OpenRouter User',
             model: 'openai/gpt-4o',
             apiKey: 'test-or-key',
           },
           disconnect,
         }),
       });
      fireEvent.click(screen.getByRole('button', { name: /online/i }));
      const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
      fireEvent.click(disconnectButton);

      await waitFor(() => {
        expect(disconnect).toHaveBeenCalled();
      });
    });
  });

  describe('test tab', () => {
    it('shows Claude as always connected in test tab', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      expect(screen.getByText(/connected with claude api/i)).toBeInTheDocument();
    });

     it('shows green indicator when connected to Claude', () => {
       renderPanel({
         provider: createMockProvider({
           mode: 'test',
           claude: {
             label: 'Claude User',
             model: 'claude-3-5-sonnet-20241022',
             apiKey: 'test-key-123',
           },
         }),
       });
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      const indicator = screen.getByRole('button', { name: /test/i }).querySelector('.bg-green-400');
      expect(indicator).toBeInTheDocument();
    });

    it('shows all Claude models as clickable options', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      // All Claude models should be visible and clickable
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThanOrEqual(3); // At least 3 Claude models
    });

    it('always shows Claude model list in test tab', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      // Should see all Claude models in button form (not a dropdown select)
      const buttons = screen.getAllByRole('option');
      expect(buttons.some(b => b.textContent?.includes('claude-3-5-sonnet'))).toBe(true);
    });

    it('test tab renders connected status', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /test/i }));
      expect(screen.getByText(/connected with claude api/i)).toBeInTheDocument();
    });
  });


});
