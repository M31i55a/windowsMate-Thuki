import { motion } from 'framer-motion';
import type { VoiceStatus } from '../hooks/useVoiceInput';

interface VoiceIndicatorProps {
  status: VoiceStatus;
  onToggle?: () => void;
  size?: 'compact' | 'full';
}

const pulseAnimation = {
  scale: [1, 1.15, 1],
  opacity: [0.7, 1, 0.7],
  transition: { duration: 1.5, repeat: Number.POSITIVE_INFINITY },
};

function statusColor(status: VoiceStatus): string {
  switch (status.type) {
    case 'listening':
      return 'bg-emerald-400';
    case 'recording':
      return 'bg-amber-400';
    case 'transcribing':
    case 'ai_processing':
      return 'bg-sky-400';
    case 'speaking':
      return 'bg-violet-400';
    case 'error':
      return 'bg-red-400';
    default:
      return 'bg-neutral-500';
  }
}

function statusLabel(status: VoiceStatus): string {
  switch (status.type) {
    case 'idle':
      return 'Voice off';
    case 'listening':
      return 'Listening…';
    case 'recording':
      return 'Recording…';
    case 'transcribing':
      return 'Transcribing…';
    case 'ai_processing':
      return status.text ? `"${status.text}"` : 'Thinking…';
    case 'speaking':
      return 'Speaking…';
    case 'error':
      return status.message;
  }
}

export function VoiceIndicator({
  status,
  onToggle,
  size = 'full',
}: VoiceIndicatorProps) {
  const isActive = status.type !== 'idle' && status.type !== 'error';
  const color = statusColor(status);
  const shouldPulse =
    status.type === 'listening' ||
    status.type === 'recording' ||
    status.type === 'transcribing';

  if (size === 'compact') {
    return (
      <motion.button
        onClick={onToggle}
        className={`relative flex size-6 items-center justify-center rounded-full ${
          isActive ? color : 'bg-neutral-700/50'
        } cursor-pointer hover:opacity-80`}
        whileTap={{ scale: 0.9 }}
        title={statusLabel(status)}
      >
        {shouldPulse ? (
          <motion.span
            className="size-2 rounded-full bg-white"
            animate={pulseAnimation}
          />
        ) : (
          <span className="size-2 rounded-full bg-white" />
        )}
      </motion.button>
    );
  }

  return (
    <motion.button
      onClick={onToggle}
      className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${
        isActive ? color + ' text-white' : 'bg-neutral-800 text-neutral-400'
      } cursor-pointer transition-colors hover:opacity-80`}
      whileTap={{ scale: 0.95 }}
      layout
    >
      <motion.span
        className="size-2 rounded-full bg-current"
        animate={shouldPulse ? pulseAnimation : undefined}
      />
      <span>{statusLabel(status)}</span>
    </motion.button>
  );
}
