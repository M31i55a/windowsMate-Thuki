import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type VoiceStatus =
  | { type: 'idle' }
  | { type: 'listening' }
  | { type: 'recording' }
  | { type: 'transcribing' }
  | { type: 'ai_processing'; text?: string }
  | { type: 'speaking' }
  | { type: 'error'; message: string };

export interface UseVoiceInputReturn {
  status: VoiceStatus;
  isListening: boolean;
  transcribedText: string | null;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  toggleListening: () => Promise<void>;
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [status, setStatus] = useState<VoiceStatus>({ type: 'idle' });
  const [isListening, setIsListening] = useState(false);
  const [transcribedText, setTranscribedText] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<{
        status: string;
        text?: string;
        response?: string;
      }>('mate://voice_state', ({ payload }) => {
        switch (payload.status) {
          case 'idle':
            setStatus({ type: 'idle' });
            break;
          case 'listening':
            setStatus({ type: 'listening' });
            break;
          case 'recording':
            setStatus({ type: 'recording' });
            break;
          case 'transcribing':
            setStatus({ type: 'transcribing' });
            break;
          case 'ai_processing':
            setStatus({
              type: 'ai_processing',
              text: payload.text ?? undefined,
            });
            if (payload.text) {
              setTranscribedText(payload.text);
            }
            break;
          case 'speaking':
            setStatus({ type: 'speaking' });
            break;
          default:
            if (payload.status.startsWith('error:')) {
              setStatus({
                type: 'error',
                message: payload.status.replace('error:', ''),
              });
            }
        }
      });

      const running = await invoke<boolean>('is_voice_listener_running');
      setIsListening(running);
      if (running) {
        setStatus({ type: 'listening' });
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const startListening = useCallback(async () => {
    await invoke('start_voice_listener');
    setIsListening(true);
    setStatus({ type: 'listening' });
  }, []);

  const stopListening = useCallback(async () => {
    await invoke('stop_voice_listener');
    setIsListening(false);
    setStatus({ type: 'idle' });
  }, []);

  const toggleListening = useCallback(async () => {
    if (isListening) {
      await stopListening();
    } else {
      await startListening();
    }
  }, [isListening, startListening, stopListening]);

  return {
    status,
    isListening,
    transcribedText,
    startListening,
    stopListening,
    toggleListening,
  };
}
