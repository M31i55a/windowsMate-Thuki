/**
 * Window controls bar for the overlay.
 *
 * macOS-style traffic-light dots (close/minimize-dec/zoom-dec) + model picker
 * chip + action buttons on the left, minimize on the right.
 */

import { memo } from 'react';
import { ModelPicker } from './ModelPicker';
import { Tooltip } from './Tooltip';

const BOOKMARK_ICON_EMPTY = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const BOOKMARK_ICON_FILLED = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const NEW_CONVERSATION_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const HISTORY_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

interface WindowControlsProps {
  onClose: () => void;
  onMinimize?: () => void;
  onSave?: () => void;
  isSaved?: boolean;
  canSave?: boolean;
  onHistoryOpen?: () => void;
  onNewConversation?: () => void;
  activeModel?: string | null;
  onModelPickerToggle?: () => void;
  isModelPickerOpen?: boolean;
}

export const WindowControls = memo(function WindowControls({
  onClose,
  onMinimize,
  onSave,
  isSaved = false,
  canSave = false,
  onHistoryOpen,
  onNewConversation,
  activeModel,
  onModelPickerToggle,
  isModelPickerOpen = false,
}: WindowControlsProps) {
  const saveDisabled = !isSaved && !canSave;

  return (
    <div className="shrink-0">
      <div className="flex items-center h-8 px-2 gap-1">
        {/* macOS traffic-light dots */}
        <div className="flex items-center gap-1.5 mr-1.5">
          <button
            type="button"
            onClick={onClose}
            onFocus={(e) => {
              if (!e.relatedTarget) e.currentTarget.blur();
            }}
            aria-label="Close window"
            className="w-3 h-3 rounded-full bg-[#FF5F57] flex items-center justify-center flex-shrink-0 hover:brightness-110 transition-all cursor-pointer"
          >
            <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden="true">
              <path d="M1 1L5 5M5 1L1 5" stroke="rgba(0,0,0,0.4)" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <div aria-hidden="true" className="w-3 h-3 rounded-full bg-[#FFBD2E] flex-shrink-0" />
          <div aria-hidden="true" className="w-3 h-3 rounded-full bg-[#28C840] flex-shrink-0" />
        </div>

        {onModelPickerToggle !== undefined && (
          <ModelPicker
            onClick={onModelPickerToggle}
            isOpen={isModelPickerOpen}
            label={activeModel || 'Pick a model'}
          />
        )}

        {onSave !== undefined && (
          <Tooltip label={isSaved ? 'Remove from history' : 'Save conversation'}>
            <button
              type="button"
              onClick={onSave}
              disabled={saveDisabled}
              aria-label={isSaved ? 'Remove from history' : 'Save conversation'}
              className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors duration-150 cursor-pointer disabled:cursor-default ${
                isSaved
                  ? 'text-primary hover:text-text-secondary hover:bg-white/5'
                  : canSave
                    ? 'text-text-secondary hover:text-primary hover:bg-primary/8'
                    : 'text-text-secondary opacity-30'
              }`}
            >
              {isSaved ? BOOKMARK_ICON_FILLED : BOOKMARK_ICON_EMPTY}
            </button>
          </Tooltip>
        )}

        {onNewConversation !== undefined && (
          <Tooltip label="New conversation">
            <button
              type="button"
              onClick={onNewConversation}
              aria-label="New conversation"
              data-history-toggle
              className="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors duration-150 cursor-pointer"
            >
              {NEW_CONVERSATION_ICON}
            </button>
          </Tooltip>
        )}

        {onHistoryOpen !== undefined && (
          <Tooltip label="Conversation history">
            <button
              type="button"
              onClick={onHistoryOpen}
              aria-label="Open history"
              data-history-toggle
              className="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors duration-150 cursor-pointer"
            >
              {HISTORY_ICON}
            </button>
          </Tooltip>
        )}

        {onMinimize !== undefined && (
          <div className="ml-auto">
            <button
              type="button"
              onClick={onMinimize}
              className="win-title-btn win-title-btn-minimize"
              aria-label="Minimize"
            >
              <svg width="10" height="1" viewBox="0 0 10 1">
                <path d="M0 0.5h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="h-px bg-surface-border" />
    </div>
  );
});
