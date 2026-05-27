import { motion, AnimatePresence } from 'framer-motion';
import type React from 'react';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';

import { useOllama } from './hooks/useOllama';
import type { Message } from './hooks/useOllama';
import { useTts } from './hooks/useTts';
import { useConversationHistory } from './hooks/useConversationHistory';
import { useAgentMode } from './hooks/useAgentMode';
import { useModelSelection } from './hooks/useModelSelection';
import { useProvider } from './hooks/useProvider';
import { AgentIndicator } from './components/AgentIndicator';
import { TipBar } from './components/TipBar';
import { useTips } from './hooks/useTips';
import { MinibarView } from './components/MinibarView';
import { ProviderPickerPanel } from './components/ProviderPickerPanel';
import { CapabilityMismatchStrip } from './components/CapabilityMismatchStrip';
import { getCapabilityConflicts, hasVisionConflict } from './config/capabilityConflicts';
import { ConversationView } from './view/ConversationView';
import { AskBarView, MAX_IMAGES } from './view/AskBarView';
import { OnboardingView } from './view/onboarding/index';
import type { OnboardingStage } from './view/onboarding/index';
import { HistoryPanel } from './components/HistoryPanel';
import { ImagePreviewModal } from './components/ImagePreviewModal';
import type { AttachedImage } from './types/image';
import { MAX_IMAGE_SIZE_BYTES } from './types/image';
import type { AttachedFile } from './types/file';
import { MAX_TEXT_FILE_SIZE_BYTES, MAX_TEXT_FILES } from './types/file';
import { quote } from './config';
import {
  COMMANDS,
  SCREEN_CAPTURE_PLACEHOLDER,
  buildPrompt,
} from './config/commands';
import { detectComputerUseIntent } from './utils/intentDetection';
import './App.css';

/** Fallback model name used before get_model_config resolves at startup. */
const DEFAULT_MODEL_FALLBACK = 'gemini-3-flash-preview';

const OVERLAY_VISIBILITY_EVENT = 'mate://visibility';
const ONBOARDING_EVENT = 'mate://onboarding';
/** Event emitted by Rust when a tray "Select Region" capture completes. Payload is the saved image file path. */

/**
 * Authoritative deadline from the start of the hide transition to the native
 * window hide call. Accounts for WKWebView `requestAnimationFrame` throttling
 * in non-key windows, which stalls spring animations indefinitely and makes
 * `AnimatePresence.onExitComplete` unreliable when the panel is unfocused.
 */
const HIDE_COMMIT_DELAY_MS = 350;

/** Must match `OVERLAY_LOGICAL_WIDTH` in `src-tauri/src/lib.rs`. */
const OVERLAY_WIDTH = 650;
/** Total transparent padding around the morphing container. Zero — content fills edge-to-edge. */
const CONTAINER_VERTICAL_PADDING = 0;
/** Max morphing-container height in chat mode (matches `max-h-[600px]`) + vertical padding. */
const MAX_CHAT_WINDOW_HEIGHT = 600 + CONTAINER_VERTICAL_PADDING;

/** Must match `OVERLAY_LOGICAL_HEIGHT_COLLAPSED` in `src-tauri/src/lib.rs`. */
const COLLAPSED_WINDOW_HEIGHT = 60;

/**
 * Parses a message to detect all valid slash commands present as whole words.
 * Derives detectable commands from the COMMANDS registry so adding a command
 * to the registry is sufficient (no hardcoded trigger strings here).
 * Also returns the message with command triggers stripped for the LLM.
 */
export function parseCommands(text: string): {
  found: Set<string>;
  strippedMessage: string;
} {
  const words = text.trim().split(/\s+/);
  const triggerSet = new Set(COMMANDS.map((c) => c.trigger));
  const found = new Set<string>();
  const remaining: string[] = [];
  for (const word of words) {
    if (triggerSet.has(word)) {
      found.add(word);
    } else {
      remaining.push(word);
    }
  }
  return { found, strippedMessage: remaining.join(' ') };
}

type OverlayVisibilityPayload =
  | {
      state: 'show';
      selected_text: string | null;
      window_x: number | null;
      window_y: number | null;
      screen_bottom_y: number | null;
      /** When true the backend wants to immediately explain the selected text. */
      auto_explain?: boolean;
      /** When true the backend wants to activate inline-edit mode. */
      inline_edit?: boolean;
    }
  | { state: 'hide-request' };
type OverlayState = 'visible' | 'hidden' | 'hiding' | 'minibar';

/**
 * Main application orchestrator for windowsMate - Thuki.
 *
 * Implements an adaptive morphing UI container. It starts as a minimal spotlight-style
 * input bar (`AskBarView`), then smoothly transforms into a full chat window
 * (`ConversationView`) when the user sends their first message.
 *
 * This wrapper is strictly responsible for layout morphing, global hotkeys,
 * and window visibility state, delegating UI rendering logic to the view components.
 */
function App() {
  const [query, setQuery] = useState('');
  const [overlayState, setOverlayState] = useState<OverlayState>('hidden');
  const overlayStateRef = useRef<OverlayState>(overlayState);
  overlayStateRef.current = overlayState;
  /** Non-null when the backend signals onboarding is needed; holds the current stage. */
  const [onboardingStage, setOnboardingStage] =
    useState<OnboardingStage | null>(null);

  /**
   * Whether the ask-bar history panel is currently open.
   * Distinct from the chat-mode history dropdown (controlled by the same toggle
   * but rendered differently based on `isChatMode`).
   */
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  /**
   * True when the user clicked + while an unsaved conversation is active.
   * Causes the history dropdown to show a SwitchConfirmation prompt instead
   * of the conversation list.
   */
  const [pendingNewConversation, setPendingNewConversation] = useState(false);

  /**
   * Direct reference to the morphing container DOM node, stored alongside the
   * ResizeObserver so the dropdown sync effect can mutate `style.minHeight`
   * without going through React state (direct DOM mutation + CSS transition).
   */
  const morphingContainerNodeRef = useRef<HTMLDivElement | null>(null);

  const {
    conversationId,
    isSaved,
    save,
    unsave,
    persistTurn,
    loadConversation,
    deleteConversation,
    listConversations,
    reset: resetHistory,
  } = useConversationHistory();

  /**
   * Persist a completed user/assistant turn to SQLite if the conversation
   * has been saved. Passed as `onTurnComplete` to `useOllama`.
   */
  const handleTurnComplete = useCallback(
    async (
      userMsg: Parameters<typeof persistTurn>[0],
      assistantMsg: Parameters<typeof persistTurn>[1],
    ) => {
      await persistTurn(userMsg, assistantMsg);
      if (inlineEditModeRef.current) {
        inlineEditModeRef.current = false;
        setInlineEditMode(false);
        void invoke<void>('apply_inline_edit', { newText: assistantMsg.content });
      }
    },
    [persistTurn],
  );

  const { messages, ask, askSearch, cancel, isGenerating, reset, loadMessages, injectMessages } =
    useOllama(handleTurnComplete);

  /** True when the AI response will be pasted back into the source app's text field. */
  const [inlineEditMode, setInlineEditMode] = useState(false);
  /**
   * Ref mirror of `inlineEditMode` so closures (handleTurnComplete, handleSubmit)
   * always see the current value without needing it in their dependency arrays.
   */
  const inlineEditModeRef = useRef(false);
  useEffect(() => {
    inlineEditModeRef.current = inlineEditMode;
  }, [inlineEditMode]);

  const {
    speakingMessageId,
    speak: ttsSpeak,
    stop: ttsStop,
    fetchVoices,
    voices: ttsVoices,
    selectedVoice,
    setSelectedVoice,
    privacyAcknowledged,
    acknowledgePrivacy,
  } = useTts();

  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** Images attached to the current (unsent) message. Blob URLs render
   *  immediately; file paths are set asynchronously after Rust processing. */
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  /** Text files attached to the current (unsent) message. Content is populated
   *  asynchronously once the browser's FileReader finishes reading the file. */
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  /** Ref to the hidden file input element used by the /file command picker. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** URL of the image currently open in the preview modal (blob or asset URL). */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  /**
   * Drag state passed to AskBarView for visual ring feedback.
   * "normal" = under capacity (violet ring); "max" = at capacity (red ring + label).
   * null = no active drag.
   */
  const [isDragOver, setIsDragOver] = useState<'normal' | 'max' | null>(null);

  /** When the user submits while images are still processing, the submit
   *  intent is stored here. The effect below watches `attachedImages` and
   *  fires the actual `ask()` once every image has a resolved `filePath`.
   *  Also stores `promptOverride` when the deferred submit originates from
   *  a utility command, and `context` for any quoted selected text. */
  const pendingSubmitRef = useRef<{
    query: string;
    context: string | undefined;
    think: boolean;
    promptOverride?: string;
  } | null>(null);
  /** True while waiting for images to finish processing before a deferred
   *  submit. Drives the "waiting" UI state in the ask bar. */
  const [isSubmitPending, setIsSubmitPending] = useState(false);
  /** Error message from a failed /screen capture. Shown inline above the ask
   *  bar so the user knows capture failed rather than seeing no response. */
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** Capability conflict messages when the active model doesn't support a
   *  required capability (e.g., vision for /screen or image uploads, thinking
   *  for /think). Shown via CapabilityMismatchStrip above the ask bar. */
  const [capabilityConflicts, setCapabilityConflicts] = useState<string[]>([]);
  /**
   * Set to true when a /screen capture is dispatched, false when it resolves
   * or when the user cancels. Lets the async tail in handleScreenSubmit
   * detect a mid-flight cancellation and skip the ask() call.
   */
  const screenCapturePendingRef = useRef(false);
  /**
   * Stores the selected text that should be auto-explained after the overlay
   * becomes visible (set by Ctrl+Space quick-explain activation).
   * Cleared immediately after ask() fires to prevent double-submit.
   */
  const autoExplainPendingRef = useRef<string | null>(null);
  /**
   * Stores the input state (query + context) captured just before a /screen
   * submit clears them. Used by handleCancel to restore the ask bar if the
   * user aborts the in-flight capture.
   */
  const screenCaptureInputSnapshotRef = useRef<{
    query: string;
    context: string | undefined;
  } | null>(null);
  /** User message shown in the chat while waiting for images to finish
   *  processing. Cleared when `ask()` fires and adds the real message. */
  const [pendingUserMessage, setPendingUserMessage] = useState<Message | null>(
    null,
  );

  /**
   * Session counter — incremented on each overlay open. Used in the motion
   * key to force AnimatePresence to fully unmount the stale tree before
   * mounting a fresh one, preventing a flash of the previous conversation.
   */
  const [sessionId, setSessionId] = useState(0);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const modelSelection = useModelSelection();
  const provider = useProvider();

  /** The active model label shown in the chip — reflects provider mode. */
  const displayModel =
    provider.mode === 'openrouter' && provider.openRouter
      ? provider.openRouter.model
      : modelSelection.active;

  const agentMode = useAgentMode(
    modelSelection.active ? { active: modelSelection.active } : null,
    ({ summary, isError }) => {
      injectMessages([
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: summary || (isError ? 'Agent encountered an error.' : 'Task complete.'),
          ...(isError ? { errorKind: 'Other' as const } : {}),
        },
      ]);
    },
  );

  /**
   * True when the window is near the screen bottom and should grow upward.
   * Flips the outer container to `justify-end` so content pins to the bottom.
   */
  const [growsUpward, setGrowsUpward] = useState(false);

  /**
   * True while the user is in a live conversation (messages exist, generating,
   * or a submit is pending). Used by AskBarView to switch its placeholder,
   * logo size, and button visibility to "reply" mode.
   */
  const isReplying = messages.length > 0 || isGenerating || isSubmitPending;

  /**
   * Determines whether the UI has entered "chat mode" — i.e., the morphing
   * chat window state with message bubbles. Transitions from input-bar mode
   * to chat-window mode are animated via Framer Motion `layout` prop.
   * Also true when images are attached (e.g. after taking a screenshot) so the
   * window expands immediately and the user can type their question right away.
   */
  const isChatMode = isReplying || attachedImages.length > 0 || attachedFiles.length > 0;
  const { tip, tipKey, isVisible: tipVisible } = useTips(isChatMode);

  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const modelPickerPanelRef = useRef<HTMLDivElement>(null);

  /**
   * When the user submits while an online provider is active and hasn't yet
   * acknowledged the privacy warning this session, we park the real submit
   * action here and show the warning strip instead.
   */
  const [pendingOnlineSubmit, setPendingOnlineSubmit] = useState<(() => void) | null>(null);

  const handleModelPickerToggle = useCallback(() => {
    setIsModelPickerOpen((prev) => !prev);
  }, []);

  const handleModelPickerClose = useCallback(() => {
    setIsModelPickerOpen(false);
  }, []);
  const previousIsChatModeRef = useRef(isChatMode);
  const isChatModeRef = useRef(isChatMode);
  useEffect(() => { isChatModeRef.current = isChatMode; }, [isChatMode]);

  /**
   * The bookmark save button is active once the AI has produced at least one
   * complete response. We check for an assistant message rather than any message
   * so the button never appears during the very first user-only half-turn.
   */
  const canSave = !isGenerating && messages.some((m) => m.role === 'assistant');
  const shouldRenderOverlay = overlayState === 'visible';

  /**
   * Reference stored for ResizeObserver cleanup.
   */
  const observerRef = useRef<ResizeObserver | null>(null);

  /**
   * Mirror of `growsUpward` as a ref so the ResizeObserver closure can read
   * it without being recreated on each state change.
   */
  const growsUpwardRef = useRef(false);

  /**
   * Stores the window's fixed bottom Y and X for upward-growth sessions.
   * The bottom stays pinned while the top edge moves up as content grows.
   */
  const windowPosRef = useRef({ x: 0, bottomY: 0 });

  /**
   * Mirror of `isGenerating` as a ref so the ResizeObserver closure can
   * check streaming state without being recreated on each render.
   */
  const isGeneratingRef = useRef(false);
  isGeneratingRef.current = isGenerating;

  /**
   * High-water mark for window height during streaming. While the LLM is
   * generating, the window only grows (never shrinks) to prevent jitter
   * from Streamdown's block-element reflows. Reset when generation ends
   * or a new session starts.
   */
  const maxHeightRef = useRef(0);

  /**
   * Callback ref to reliably attach the ResizeObserver when the conditionally
   * rendered Framer Motion container actually mounts in the DOM. This fixes
   * the bug where a standard useEffect would run before the DOM node was ready,
   * leaving the native window stuck at 600x700.
   *
   * When `growsUpwardRef` is true (window near screen bottom), the observer
   * also repositions the window upward to keep its bottom pinned as the
   * conversation grows.
   */
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    morphingContainerNodeRef.current = node;

    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      const observer = new ResizeObserver(
        /* v8 ignore start -- ResizeObserver callback requires a native browser resize event */
        (entries) => {
          requestAnimationFrame(() => {
            if (overlayStateRef.current === 'minibar') return;
            for (const entry of entries) {
              const rect = entry.target.getBoundingClientRect();
              const vPad = CONTAINER_VERTICAL_PADDING;
              let targetHeight =
                Math.ceil(rect.height) + vPad;

              // During streaming, only allow the window to grow (never
              // shrink) to prevent jitter from Streamdown block reflows.
              if (isGeneratingRef.current) {
                if (targetHeight > maxHeightRef.current) {
                  maxHeightRef.current = targetHeight;
                } else {
                  targetHeight = maxHeightRef.current;
                }
              }

              if (growsUpwardRef.current) {
                // Grow upward: pin the window bottom and expand the top edge.
                // Clamp Y so the window never extends above the menu bar.
                const { x, bottomY } = windowPosRef.current;
                const newY = Math.max(0, bottomY - targetHeight);
                void invoke('set_window_frame', {
                  x,
                  y: newY,
                  width: OVERLAY_WIDTH,
                  height: targetHeight,
                });
              } else {
                void getCurrentWindow().setSize(
                  new LogicalSize(OVERLAY_WIDTH, targetHeight),
                );
              }
            }
          });
        },
        /* v8 ignore stop */
      );

      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  /**
   * Reset the high-water mark when streaming finishes so the window can
   * shrink back to its natural content height on the next resize event.
   */
  useEffect(() => {
    if (!isGenerating) {
      maxHeightRef.current = 0;
    }
  }, [isGenerating]);

  /** Close model picker when generation starts. */
  useEffect(() => {
    if (isGenerating) setIsModelPickerOpen(false);
  }, [isGenerating]);

  /** Close model picker on outside click. */
  useEffect(() => {
    if (!isModelPickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest?.('[data-model-picker-toggle]')) return;
      if (modelPickerPanelRef.current?.contains(target)) return;
      setIsModelPickerOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isModelPickerOpen]);

  /** Apply appearance CSS vars from localStorage on mount. */
  useEffect(() => {
    const color = localStorage.getItem('mate-bubble-color') ?? '#ff8d5c';
    const opacity = localStorage.getItem('mate-bg-opacity') ?? '0.92';
    const blurPx = localStorage.getItem('mate-chat-blur-px') ?? '10';
    document.documentElement.style.setProperty('--bubble-color', color);
    document.documentElement.style.setProperty('--app-bg-opacity', opacity);
    document.documentElement.style.setProperty('--chat-bg-blur', `${blurPx}px`);

    // Listen for live appearance changes broadcast from the settings window.
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ bubbleColor: string | null; opacity: string | null; blur: string | null }>(
        'mate://appearance',
        ({ payload }) => {
          if (payload.bubbleColor) {
            document.documentElement.style.setProperty('--bubble-color', payload.bubbleColor);
          }
          if (payload.opacity) {
            document.documentElement.style.setProperty('--app-bg-opacity', payload.opacity);
          }
          if (payload.blur !== null && payload.blur !== undefined) {
            document.documentElement.style.setProperty('--chat-bg-blur', `${payload.blur}px`);
          }
        },
      ).then((fn) => { unlisten = fn; });
    });
    return () => unlisten?.();
  }, []);

  /**
   * Replays the entrance sequence by transitioning the overlay to the visible state.
   * Clears conversation state for a fresh session each time the overlay appears.
   */
  const replayEntranceAnimation = useCallback(
    (
      context: string | null,
      windowX: number | null,
      windowY: number | null,
      screenBottomY: number | null,
      autoExplain: boolean = false,
      inlineEdit: boolean = false,
    ) => {
      const shouldGrowUp =
        windowY !== null &&
        screenBottomY !== null &&
        windowY + MAX_CHAT_WINDOW_HEIGHT > screenBottomY;
      growsUpwardRef.current = shouldGrowUp;
      setGrowsUpward(shouldGrowUp);
      maxHeightRef.current = 0;
      if (shouldGrowUp && windowX !== null && windowY !== null) {
        windowPosRef.current = {
          x: windowX,
          bottomY: windowY + COLLAPSED_WINDOW_HEIGHT,
        };
      }
      setSessionId((id) => id + 1);
      setQuery('');
      setSelectedContext(context);
      setIsHistoryOpen(false);
      setInlineEditMode(inlineEdit);
      setAttachedImages((prev) => {
        for (const img of prev) URL.revokeObjectURL(img.blobUrl);
        return [];
      });
      setAttachedFiles([]);
      pendingSubmitRef.current = null;
      screenCapturePendingRef.current = false;
      screenCaptureInputSnapshotRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      setCaptureError(null);

      if (autoExplain && context) {
        autoExplainPendingRef.current = context;
      }

      reset();
      resetHistory();
      setOverlayState('visible');
    },
    [reset, resetHistory],
  );

  /**
   * Moves the overlay into an exit phase. The actual Tauri window hide call is
   * deferred until Framer Motion finishes the exit transition.
   */
  const requestHideOverlay = useCallback(() => {
    cancel();
    growsUpwardRef.current = false;
    setGrowsUpward(false);
    screenCapturePendingRef.current = false;
    screenCaptureInputSnapshotRef.current = null;
    setSelectedContext(null);
    setInlineEditMode(false);
    setPreviewImageUrl(null);
    setAttachedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.blobUrl);
      return [];
    });
    setAttachedFiles([]);
    setOverlayState((currentState) => {
      if (currentState === 'hidden' || currentState === 'hiding') {
        return currentState;
      }
      return 'hiding';
    });
  }, [cancel]);

  /** Ref attached to the chat-mode history dropdown for click-outside detection. */
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  /** Toggles the history panel open/closed. */
  const handleHistoryToggle = useCallback(() => {
    setIsHistoryOpen((prev) => !prev);
  }, []);

  /**
   * Close the chat-mode history dropdown when the user clicks outside it.
   * Clicks on the toggle button itself are excluded so the button's own
   * onClick handler (handleHistoryToggle) can manage the toggle normally.
   */
  useEffect(() => {
    if (!(isChatMode && isHistoryOpen)) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (
        historyDropdownRef.current?.contains(target) ||
        target.closest?.('[data-history-toggle]')
      ) {
        return;
      }
      setIsHistoryOpen(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isChatMode, isHistoryOpen]);

  // Clear any pending new-conversation confirmation whenever the panel closes.
  // Uses a ref-based approach to avoid the @eslint-react/set-state-in-effect
  // warning from calling setState synchronously inside an effect body.
  const prevHistoryOpenRef = useRef(isHistoryOpen);
  const prevHeightRef = useRef<number>(COLLAPSED_WINDOW_HEIGHT);
  if (prevHistoryOpenRef.current && !isHistoryOpen) {
    setPendingNewConversation(false);
  }
  prevHistoryOpenRef.current = isHistoryOpen;

  /**
   * When a submit flips the UI from ask-bar mode into chat mode while the
   * window is pinned near the bottom edge, animate the container from its
   * current height to the fixed full chat height. This is intentionally scoped
   * to the upward-growth path so the downward path remains unchanged.
   */
  useLayoutEffect(() => {
    /* v8 ignore start -- ResizeObserver + DOM mutations require a real browser */
    const container = morphingContainerNodeRef.current;
    const wasChatMode = previousIsChatModeRef.current;
    previousIsChatModeRef.current = isChatMode;

    if (!container) return;
    if (!growsUpward || isHistoryOpen || !isChatMode || wasChatMode) {
      return;
    }

    const startHeight =
      container.offsetHeight > 0
        ? container.offsetHeight
        : prevHeightRef.current;
    container.style.transition = 'none';
    container.style.minHeight = '';
    container.style.height = `${startHeight}px`;
    void container.offsetHeight;

    const frameId = requestAnimationFrame(() => {
      // 0.45s smooth spring-like ease for upward morph
      container.style.transition = 'height 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
      container.style.height = '600px';
    });

    return () => cancelAnimationFrame(frameId);
    /* v8 ignore stop */
  }, [growsUpward, isChatMode, isHistoryOpen]);

  /**
   * Observes the dropdown's height while it's open and mutates the morphing
   * container's `min-height` style directly (bypassing React state) so the
   * native window grows exactly as tall as the dropdown needs. A CSS transition
   * on the container drives the smooth resize; the existing ResizeObserver fires
   * per-frame and calls `setSize()` as the transition runs.
   *
   * Direct DOM mutation avoids the React state → Framer Motion → ResizeObserver
   * indirect chain that broke timing. ResizeObserver tracks async conversation
   * list load so `min-height` stays accurate as content populates.
   */
  useLayoutEffect(() => {
    /* v8 ignore start -- ResizeObserver + DOM mutations require a real browser */
    const container = morphingContainerNodeRef.current;
    if (!container) return;

    // Track the height when we are NOT in chat mode natively.
    if (!isChatMode) {
      const h = container.offsetHeight;
      // offsetHeight might read 0 if hidden, so default to collapsed
      prevHeightRef.current = h > 0 ? h : COLLAPSED_WINDOW_HEIGHT;
      container.style.transition =
        'min-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
      container.style.height = '';
      container.style.minHeight = '';
      return;
    }

    if (!isHistoryOpen) {
      container.style.transition =
        'min-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
      container.style.minHeight = '';
      return;
    }

    const dropdown = historyDropdownRef.current;
    if (!dropdown) return;

    container.style.transition =
      'min-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
    container.style.height = ''; // Let history panel dictate it via minHeight

    const sync = () => {
      container.style.minHeight = `${dropdown.offsetTop + dropdown.offsetHeight + 8}px`;
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(dropdown);
    return () => ro.disconnect();
    /* v8 ignore stop */
  }, [isChatMode, isHistoryOpen]);

  /**
   * Toggles the save state of the current conversation.
   * - Not saved → saves to SQLite (bookmark fills).
   * - Already saved → deletes from SQLite, marks unsaved (bookmark empties);
   *   messages remain in the UI so the session can be re-saved if desired.
   */
  const handleSave = useCallback(async () => {
    try {
      if (isSaved) {
        await unsave();
      } else {
        await save(messages, modelSelection.active ?? DEFAULT_MODEL_FALLBACK);
      }
    } catch {
      // State stays unchanged on failure; feedback is implicit in the icon.
    }
  }, [isSaved, unsave, save, messages, modelSelection.active]);

  /**
   * Loads a conversation from history, replacing the current session.
   *
   * Closes the history panel regardless of success or failure: on success the
   * loaded messages replace the current session; on failure the current session
   * is preserved and the panel is dismissed so the user is not left in a
   * half-open state.
   */
  const handleLoadConversation = useCallback(
    async (id: string) => {
      try {
        const loaded = await loadConversation(id);
        loadMessages(loaded);
      } catch {
        // Load failed — current session is preserved intact.
      } finally {
        setIsHistoryOpen(false);
      }
    },
    [loadConversation, loadMessages],
  );

  /**
   * Saves the current unsaved session then loads the requested conversation.
   *
   * If save fails the operation is aborted — we do not load the target
   * conversation because the current session has not been persisted yet.
   * If save succeeds but load fails the panel is still dismissed; the
   * current session has been saved so no data is lost.
   */
  const handleSaveAndLoad = useCallback(
    async (id: string) => {
      try {
        await save(messages, modelSelection.active ?? DEFAULT_MODEL_FALLBACK);
      } catch {
        // Save failed — abort to avoid leaving the current session unprotected.
        return;
      }
      try {
        const loaded = await loadConversation(id);
        loadMessages(loaded);
      } catch {
        // Load failed — save already committed; dismiss panel, keep current view.
      } finally {
        setIsHistoryOpen(false);
      }
    },
    [save, messages, loadConversation, loadMessages, modelSelection.active],
  );

  /**
   * Deletes a conversation from the history panel.
   *
   * When the deleted conversation is the currently active one, only the
   * persistence state (`resetHistory`) is cleared — messages remain visible
   * so the user can continue chatting or re-save. The error is intentionally
   * re-thrown so `HistoryPanel` can roll back its optimistic removal.
   */
  const handleDeleteConversation = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      if (id === conversationId) {
        resetHistory();
      }
    },
    [deleteConversation, conversationId, resetHistory],
  );

  /**
   * Shared reset sequence for all "start a new conversation" paths.
   */
  const resetForNewConversation = useCallback(() => {
    reset();
    resetHistory();
    setIsHistoryOpen(false);
    setQuery('');
    setAttachedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.blobUrl);
      return [];
    });
    setAttachedFiles([]);
    pendingSubmitRef.current = null;
    screenCapturePendingRef.current = false;
    screenCaptureInputSnapshotRef.current = null;
    setIsSubmitPending(false);
    setPendingUserMessage(null);
  }, [reset, resetHistory]);

  /**
   * Starts a fresh conversation from within conversation view.
   * If the current conversation has unsaved messages, opens the history
   * dropdown and surfaces a SwitchConfirmation prompt instead of resetting
   * immediately.
   */
  const handleNewConversation = useCallback(() => {
    if (!isSaved && messages.length > 0) {
      setPendingNewConversation(true);
      setIsHistoryOpen(true);
      return;
    }
    resetForNewConversation();
  }, [isSaved, messages.length, resetForNewConversation]);

  /** Saves the current conversation then starts a fresh one. */
  const handleSaveAndNew = useCallback(async () => {
    try {
      await save(messages, modelSelection.active ?? DEFAULT_MODEL_FALLBACK);
    } catch {
      return;
    }
    resetForNewConversation();
  }, [save, messages, resetForNewConversation, modelSelection.active]);

  /** Discards the current conversation and starts a fresh one. */
  const handleJustNew = useCallback(() => {
    resetForNewConversation();
  }, [resetForNewConversation]);

  /**
   * Handles newly attached image files. Creates blob URLs immediately for
   * instant thumbnail rendering, then processes each file in the background
   * via base64-encoded IPC to the Rust backend.
   */
  const handleImagesAttached = useCallback((files: File[]) => {
    const newImages: AttachedImage[] = files.map((file) => ({
      id: crypto.randomUUID(),
      blobUrl: URL.createObjectURL(file),
      filePath: null,
    }));

    setAttachedImages((prev) => [...prev, ...newImages]);

    // Defer backend processing to the next frame so React can render the
    // blob URL thumbnails immediately — keeps the UI responsive while
    // FileReader + IPC serialisation happen in subsequent event-loop ticks.
    requestAnimationFrame(() => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const imageId = newImages[i].id;

        const reader = new FileReader();
        reader.onload = () => {
          // Extract pure base64 from the data URL (strip "data:image/png;base64,").
          const base64 = (reader.result as string).split(',')[1];
          invoke<string>('save_image_command', { imageDataBase64: base64 })
            .then((filePath) => {
              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.id === imageId ? { ...img, filePath } : img,
                ),
              );
            })
            .catch(() => {
              setAttachedImages((prev) => {
                for (const img of prev) {
                  if (img.id === imageId) URL.revokeObjectURL(img.blobUrl);
                }
                return prev.filter((img) => img.id !== imageId);
              });
            });
        };
        reader.readAsDataURL(file);
      }
    });
  }, []);

  /**
   * Handles newly attached text files. Reads them with FileReader.readAsText
   * and stores their content in the attachedFiles state for inclusion in the
   * next submitted message.
   */
  const handleTextFilesAttached = useCallback((files: File[]) => {
    const candidates = files
      .filter((f) => !f.type.startsWith('image/') && f.size <= MAX_TEXT_FILE_SIZE_BYTES)
      .slice(0, MAX_TEXT_FILES);
    if (candidates.length === 0) return;

    const newFiles: AttachedFile[] = candidates.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      content: null,
    }));

    setAttachedFiles((prev) => {
      const remaining = MAX_TEXT_FILES - prev.length;
      return [...prev, ...newFiles.slice(0, remaining)];
    });

    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      const fileId = newFiles[i].id;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedFiles((prev) =>
          prev.map((af) =>
            af.id === fileId
              ? { ...af, content: reader.result as string }
              : af,
          ),
        );
      };
      reader.onerror = () => {
        // Remove the file if reading fails.
        setAttachedFiles((prev) => prev.filter((af) => af.id !== fileId));
      };
      reader.readAsText(file);
    }
  }, []);

  /** Removes an attached text file chip from state. */
  const handleFileRemove = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /**
   * Root-level drag handlers. Attached to the `h-screen w-screen` root div so
   * file drops anywhere in the window are intercepted, including the
   * the WebView navigates to display the dropped image full-screen when the user
   * drops a second image after the first conversation turn.
   *
   * `dragover` must always call `e.preventDefault()` to signal the browser that
   * this element accepts drops; without it the `drop` event never fires.
   */
  const handleRootDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (isGenerating || isSubmitPending) return;
      const atImageMax = attachedImages.length >= MAX_IMAGES;
      const atFileMax = attachedFiles.length >= MAX_TEXT_FILES;
      setIsDragOver(atImageMax && atFileMax ? 'max' : 'normal');
    },
    [isGenerating, isSubmitPending, attachedImages.length, attachedFiles.length],
  );

  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the cursor truly exits the window. `dragleave` fires
    // when moving between child elements too; checking `relatedTarget` lets us
    // ignore those internal transitions.
    /* v8 ignore start -- dragleave relatedTarget cannot be set in jsdom; the false branch (cursor on child element) requires a real browser drag sequence */
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      setIsDragOver(null);
    }
    /* v8 ignore stop */
  }, []);

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(null);
      if (isGenerating || isSubmitPending) return;
      const files = e.dataTransfer?.files;
      if (!files) return;

      const imageFiles: File[] = [];
      const textFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type.startsWith('image/') && f.size <= MAX_IMAGE_SIZE_BYTES) {
          imageFiles.push(f);
        } else if (!f.type.startsWith('image/') && f.size <= MAX_TEXT_FILE_SIZE_BYTES) {
          textFiles.push(f);
        }
      }

      const remainingImages = MAX_IMAGES - attachedImages.length;
      if (remainingImages > 0 && imageFiles.length > 0) {
        handleImagesAttached(imageFiles.slice(0, remainingImages));
      }
      if (textFiles.length > 0) {
        handleTextFilesAttached(textFiles);
      }
    },
    [
      isGenerating,
      isSubmitPending,
      attachedImages.length,
      handleImagesAttached,
      handleTextFilesAttached,
    ],
  );

  /**
   * Invokes the Rust `capture_screenshot` command, which hides the window,
   * lets the user drag-select a screen region, then returns the captured image
   * as a base64 PNG string (or null if the user cancelled).
   * On success, converts the base64 to a File and feeds it into the existing
   * handleImagesAttached pipeline — identical to a paste or drag-drop.
   */
  const handleScreenshot = useCallback(async () => {
    /* v8 ignore start -- defensive guard: button is always disabled at max images, so this branch is unreachable through normal UI interaction */
    if (attachedImages.length >= MAX_IMAGES) return;
    /* v8 ignore stop */
    const filePath = await invoke<string>('capture_full_screen_command');
    if (!filePath) return;
    const assetUrl = convertFileSrc(filePath);
    setAttachedImages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        blobUrl: assetUrl,
        filePath,
      },
    ]);
  }, [attachedImages]);

  /**
   * Invokes the interactive region-select command. Hides the overlay,
   * shows a full-screen crosshair selector, crops the chosen rectangle,
   * and attaches the result as an image — identical to handleScreenshot
   * except the user draws the region instead of capturing everything.
   * Returns without action if the user cancels (Escape / right-click).
   */
  const handleRegionCapture = useCallback(async () => {
    /* v8 ignore start -- defensive guard: button is always disabled at max images, so this branch is unreachable through normal UI interaction */
    if (attachedImages.length >= MAX_IMAGES) return;
    /* v8 ignore stop */
    const filePath = await invoke<string | null>('capture_screenshot_command');
    if (!filePath) return;
    const assetUrl = convertFileSrc(filePath);
    setAttachedImages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        blobUrl: assetUrl,
        filePath,
      },
    ]);
  }, [attachedImages]);

  /** Removes an attached image from state, revokes the blob URL, and
   *  deletes the staged file from disk if processing completed. */
  const handleImageRemove = useCallback((id: string) => {
    setAttachedImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) {
        URL.revokeObjectURL(img.blobUrl);
        if (img.filePath) {
          void invoke('remove_image_command', { path: img.filePath });
        }
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  /** Opens the preview modal for an attached image (identified by ID).
   *  The ID always comes from the thumbnail component which only renders
   *  items present in attachedImages, so the find always succeeds. */
  const handleAskBarImagePreview = useCallback(
    (id: string) => {
      setPreviewImageUrl(attachedImages.find((i) => i.id === id)!.blobUrl);
    },
    [attachedImages],
  );

  /** Opens the preview modal for a chat history image (identified by file path). */
  const handleChatImagePreview = useCallback((path: string) => {
    setPreviewImageUrl(path.startsWith('blob:') ? path : convertFileSrc(path));
  }, []);

  /** Fires the actual ask() call and cleans up attached images + input. */
  const executeSubmit = useCallback(
    (submitQuery: string, context: string | undefined, think?: boolean) => {
      const readyPaths = attachedImages
        .filter((img) => img.filePath !== null)
        .map((img) => img.filePath as string);
      const images = readyPaths.length > 0 ? readyPaths : undefined;
      ask(submitQuery, context, images, think);
      setSelectedContext(null);
      setQuery('');
      for (const img of attachedImages) {
        URL.revokeObjectURL(img.blobUrl);
      }
      setAttachedImages([]);
      inputRef.current!.style.height = 'auto';
    },
    [ask, attachedImages, setSelectedContext],
  );

  /**
   * Async handler for the `/screen` command path. Invokes the Rust
   * `capture_full_screen_command`, which silently captures the screen
   * (excluding Mate's own windows) and returns the saved file path.
   * On success, merges the screenshot path with any manually attached
   * images and calls ask(). On error, restores the query so no input is lost.
   */
  const handleScreenSubmit = useCallback(
    async (fullQuery: string, think?: boolean) => {
      // eslint-disable-next-line no-control-regex
      const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
      const sanitized = selectedContext
        ?.replace(CONTROL_CHARS, '')
        .slice(0, quote.maxContextLength);
      const context = sanitized?.trim() ? sanitized : undefined;

      // Snapshot display paths for the pending bubble: use resolved file paths
      // for already-processed images, blob URLs for still-processing ones.
      const existingDisplayPaths = attachedImages.map(
        (img) => img.filePath ?? img.blobUrl,
      );

      // Store the original input so handleCancel can restore it if the user
      // aborts the capture before it resolves.
      screenCaptureInputSnapshotRef.current = {
        query: fullQuery,
        context,
      };

      // Immediately show the user's message in chat with a loading placeholder
      // for the screenshot. This prevents double-submit spam and gives instant
      // feedback that the capture is in progress.
      screenCapturePendingRef.current = true;
      setIsSubmitPending(true);
      setPendingUserMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: fullQuery,
        quotedText: context,
        imagePaths: [...existingDisplayPaths, SCREEN_CAPTURE_PLACEHOLDER],
      });
      setQuery('');
      setSelectedContext(null);
      /* v8 ignore start -- inputRef always set when overlay is visible */
      if (inputRef.current) inputRef.current.style.height = 'auto';
      /* v8 ignore stop */

      let screenshotPath: string;
      try {
        screenshotPath = await invoke<string>('capture_full_screen_command');
      } catch (e) {
        screenCapturePendingRef.current = false;
        screenCaptureInputSnapshotRef.current = null;
        // Capture failed: restore input state so the user can retry or edit.
        setIsSubmitPending(false);
        setPendingUserMessage(null);
        setQuery(fullQuery);
        setSelectedContext(context ?? null);
        // Surface the Rust error directly: the backend already provides
        // descriptive messages (permission prompts, null-image diagnostics, etc.).
        // Tauri v2 rejects with the Err(String) value as a plain string.
        setCaptureError(
          typeof e === 'string'
            ? e
            : e instanceof Error
              ? e.message
              : String(e),
        );
        return;
      }

      // Check for mid-flight cancellation before touching any state.
      // handleCancel sets screenCapturePendingRef.current = false as a signal.
      const wasCancelled = !screenCapturePendingRef.current;
      screenCapturePendingRef.current = false;
      screenCaptureInputSnapshotRef.current = null;
      if (wasCancelled) return;

      // Capture succeeded: finalize the submit.
      setCaptureError(null);
      setIsSubmitPending(false);
      setPendingUserMessage(null);

      const readyPaths = attachedImages
        .filter((img) => img.filePath !== null)
        .map((img) => img.filePath as string);
      readyPaths.push(screenshotPath);

      ask(fullQuery, context, readyPaths, think);
      for (const img of attachedImages) {
        URL.revokeObjectURL(img.blobUrl);
      }
      setAttachedImages([]);
    },
    [selectedContext, attachedImages, ask, setSelectedContext, setCaptureError],
  );

  const handleSubmit = useCallback(() => {
    if (
      (query.trim().length === 0 && attachedImages.length === 0 && attachedFiles.length === 0) ||
      isGenerating
    )
      return;

    // Show a one-time-per-session privacy warning before the first cloud message.
    if (provider.mode === 'openrouter' && !sessionStorage.getItem('onlinePrivacyAcked')) {
      // Park a continuation: ack + re-run submit on confirm.
      // We capture the current submit by storing a callback ref that will be
      // invoked when the user clicks "I understand — Send".
      const proceed = () => {
        sessionStorage.setItem('onlinePrivacyAcked', '1');
        setPendingOnlineSubmit(null);
        // Re-trigger the submit now that the ack is in sessionStorage.
        // setTimeout(0) lets the state flush before handleSubmit checks the flag.
        setTimeout(handleSubmit, 0);
      };
      setPendingOnlineSubmit(() => proceed);
      return;
    }

    // Clear any stale capture error and capability conflicts from a previous attempt.
    setCaptureError(null);
    setCapabilityConflicts([]);

    // Parse all valid commands from anywhere in the message.
    const trimmedQuery = query.trim();
    const { found, strippedMessage } = parseCommands(trimmedQuery);
    const hasScreen = found.has('/screen');
    const hasThink = found.has('/think');

    // Check for capability conflicts before dispatching.
    const conflicts: string[] = [];
    for (const cmd of found) {
      const cmdConflicts = getCapabilityConflicts(
        modelSelection.active,
        modelSelection.capabilities,
        cmd,
      );
      conflicts.push(...cmdConflicts.map((c) => c.message));
    }
    if (hasVisionConflict(modelSelection.active, modelSelection.capabilities, attachedImages.length)) {
      conflicts.push(
        `${modelSelection.active} does not support image input. Attach images to a vision-capable model.`,
      );
    }
    if (conflicts.length > 0) {
      setCapabilityConflicts(conflicts);
      return;
    }

    // Check for utility commands with prompt templates.
    const utilityTrigger = Array.from(found).find((t) => {
      const cmd = COMMANDS.find((c) => c.trigger === t);
      return !!cmd?.promptTemplate;
    });

    // Nothing to send if the message is only commands with no content or images.
    // Exception: a utility command or /think with pre-filled selected context is
    // valid even if no additional text was typed after the trigger.
    if (
      !strippedMessage &&
      attachedImages.length === 0 &&
      !hasScreen &&
      !((utilityTrigger || hasThink) && selectedContext?.trim())
    )
      return;

    // Auto-detect computer-use intent. If the user is asking about screen content
    // or requesting a vision analysis (but not explicitly using /screen or /do),
    // automatically capture a screenshot and send it to the vision model.
    if (!hasScreen && !found.has('/do') && !utilityTrigger) {
      const intent = detectComputerUseIntent(strippedMessage);
      if (intent === 'vision') {
        // Treat as a /screen request with the user's message as the query.
        void handleScreenSubmit(trimmedQuery, hasThink);
        return;
      }
      if (intent === 'agent') {
        const task = strippedMessage || selectedContext?.trim() || '';
        if (task) {
          injectMessages([{ id: crypto.randomUUID(), role: 'user', content: task }]);
          setQuery('');
          setSelectedContext(null);
          setAttachedImages([]);
          void agentMode.start(task);
          return;
        }
      }
    }

    if (hasScreen) {
      // Fire-and-forget: the async path handles cleanup and ask() invocation.
      void handleScreenSubmit(trimmedQuery, hasThink);
      return;
    }

    if (found.has('/file') && attachedFiles.length === 0) {
      // No files attached yet — open the native file picker.
      // The input's onChange handler will attach the chosen files as chips.
      // The query is preserved so the user can submit again with their question.
      fileInputRef.current?.click();
      return;
    }

    if (attachedFiles.length > 0) {
      // Build a prompt that embeds every file's content followed by the user's
      // typed message (if any). Strip the /file trigger from the display text.
      const { strippedMessage: strippedForFiles } = parseCommands(trimmedQuery);
      // eslint-disable-next-line no-control-regex
      const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
      const sanitizedCtx = selectedContext
        ?.replace(CONTROL_CHARS, '')
        .slice(0, quote.maxContextLength);
      const context = sanitizedCtx?.trim() ? sanitizedCtx : undefined;

      const readyFiles = attachedFiles.filter((f) => f.content !== null);
      if (readyFiles.length === 0) return; // All files still loading — skip.

      const fileContext = readyFiles
        .map((f) => `**File: ${f.name}**\n\`\`\`\n${f.content}\n\`\`\``)
        .join('\n\n');
      const promptOverride = strippedForFiles
        ? `${fileContext}\n\n${strippedForFiles}`
        : fileContext;
      const fileNames = readyFiles.map((f) => f.name);

      void ask(
        trimmedQuery,
        context,
        undefined,
        hasThink || undefined,
        promptOverride,
        fileNames,
      );
      setSelectedContext(null);
      setQuery('');
      setAttachedFiles([]);
      /* v8 ignore next */
      inputRef.current!.style.height = 'auto';
      return;
    }

    if (found.has('/do')) {
      const task = strippedMessage || selectedContext?.trim() || '';
      if (!task) return;
      injectMessages([{ id: crypto.randomUUID(), role: 'user', content: `/do ${task}` }]);
      setQuery('');
      setSelectedContext(null);
      setAttachedImages([]);
      void agentMode.start(task);
      return;
    }

    if (found.has('/search')) {
      const searchQuery = strippedMessage || selectedContext?.trim() || '';
      if (!searchQuery) return;
      setQuery('');
      setSelectedContext(null);
      for (const img of attachedImages) {
        URL.revokeObjectURL(img.blobUrl);
      }
      setAttachedImages([]);
      void askSearch(searchQuery, trimmedQuery, selectedContext?.trim() || undefined);
      return;
    }

    if (utilityTrigger) {
      // Sanitize selectedContext before passing to buildPrompt so that control
      // characters from a hostile host-app selection cannot reach the model prompt.
      // eslint-disable-next-line no-control-regex
      const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
      const sanitized = selectedContext
        ?.replace(CONTROL_CHARS, '')
        .slice(0, quote.maxContextLength);
      const context = sanitized?.trim() ? sanitized : undefined;

      const composedPrompt = buildPrompt(
        utilityTrigger,
        strippedMessage,
        context,
      );
      if (!composedPrompt) return; // No input text available.

      // Show the full original query (including command trigger) in the chat
      // bubble, matching the behaviour of /screen and the normal submit path.
      const displayText = trimmedQuery;

      const hasPendingImages = attachedImages.some(
        (img) => img.filePath === null,
      );
      if (!hasPendingImages) {
        const readyPaths = attachedImages
          .filter((img) => img.filePath !== null)
          .map((img) => img.filePath as string);
        const images = readyPaths.length > 0 ? readyPaths : undefined;
        ask(
          displayText,
          context,
          images,
          hasThink || undefined,
          composedPrompt,
        );
        setSelectedContext(null);
        setQuery('');
        for (const img of attachedImages) {
          URL.revokeObjectURL(img.blobUrl);
        }
        setAttachedImages([]);
        /* v8 ignore next */
        inputRef.current!.style.height = 'auto';
        return;
      }

      // Images still processing: store intent for deferred submit.
      pendingSubmitRef.current = {
        query: displayText,
        context,
        think: hasThink,
        promptOverride: composedPrompt,
      };
      setIsSubmitPending(true);
      setPendingUserMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: displayText,
        quotedText: context,
        imagePaths: attachedImages.map((img) => img.filePath ?? img.blobUrl),
      });
      setQuery('');
      setSelectedContext(null);
      /* v8 ignore next */
      inputRef.current!.style.height = 'auto';
      return;
    }

    // Sanitize externally-sourced context: strip control characters and enforce
    // a length cap to limit prompt-injection surface from host-app selections.
    // eslint-disable-next-line no-control-regex
    const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
    const sanitized = selectedContext
      ?.replace(CONTROL_CHARS, '')
      .slice(0, quote.maxContextLength);
    const context = sanitized?.trim() ? sanitized : undefined;

    // Inline-edit fast path: the AI response will replace the selected text
    // in the source application. We send a transformation prompt directly,
    // bypassing images and other submit paths.
    if (inlineEditModeRef.current && context) {
      const promptOverride =
        `Transform the text below according to the instruction. ` +
        `Return ONLY the transformed text — no explanation, no preamble.\n\n` +
        `Instruction: ${trimmedQuery}\n\nText:\n${context}`;
      ask(trimmedQuery, undefined, undefined, hasThink || undefined, promptOverride);
      setQuery('');
      setSelectedContext(null);
      /* v8 ignore next */
      inputRef.current!.style.height = 'auto';
      return;
    }

    // If all images are ready (or there are none), submit immediately.
    const hasPendingImages = attachedImages.some(
      (img) => img.filePath === null,
    );
    if (!hasPendingImages) {
      executeSubmit(trimmedQuery, context, hasThink || undefined);
      return;
    }

    // Images are still processing — store the intent and wait. The effect
    // below will fire the actual ask() once every image has resolved.
    pendingSubmitRef.current = {
      query: trimmedQuery,
      context,
      think: hasThink,
    };
    setIsSubmitPending(true);

    // Show the user's message immediately in the chat view. Use file paths
    // for already-processed images (no loading spinner) and blob URLs only
    // for images still being processed (ChatBubble shows a spinner for blob: URLs).
    setPendingUserMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedQuery,
      quotedText: context,
      imagePaths: attachedImages.map((img) => img.filePath ?? img.blobUrl),
    });

    setQuery('');
    setSelectedContext(null);
    inputRef.current!.style.height = 'auto';
  }, [
    query,
    isGenerating,
    ask,
    executeSubmit,
    handleScreenSubmit,
    askSearch,
    selectedContext,
    setSelectedContext,
    attachedImages,
    attachedFiles,
    setCaptureError,
    setCapabilityConflicts,
    modelSelection.active,
    modelSelection.capabilities,
  ]);

  // Fire an automatic "explain this" query when the overlay becomes visible
  // after a Ctrl+Space quick-explain activation. autoExplainPendingRef is set
  // inside replayEntranceAnimation when the backend sends auto_explain=true.
  /* eslint-disable @eslint-react/set-state-in-effect -- intentional: clears
     selectedContext in the same tick as calling ask() to keep state coherent. */
  useEffect(() => {
    if (overlayState !== 'visible') return;
    const text = autoExplainPendingRef.current;
    if (!text) return;
    autoExplainPendingRef.current = null;
    // eslint-disable-next-line no-control-regex
    const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
    const sanitized = text.replace(CONTROL_CHARS, '').slice(0, quote.maxContextLength);
    if (!sanitized.trim()) return;
    ask('What is this, and what is it about?', sanitized);
    setSelectedContext(null);
  }, [overlayState, ask, quote.maxContextLength, setSelectedContext]);
  /* eslint-enable @eslint-react/set-state-in-effect */

  // When a pending submit exists and all images finish processing, fire it.
  // Reads `attachedImages` directly (not via `executeSubmit` closure) to
  // guarantee the effect always sees the freshest file paths.
  /* eslint-disable @eslint-react/set-state-in-effect -- intentional: effect
     reacts to image processing completion and must synchronously transition
     state (pending → submitted) in the same tick to avoid stale renders. */
  useEffect(() => {
    if (!pendingSubmitRef.current) return;
    if (attachedImages.length === 0) {
      // All images failed — restore the user's query so their text isn't lost.
      const { query: savedQuery, context: savedContext } =
        pendingSubmitRef.current;
      pendingSubmitRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      setQuery(savedQuery);
      setSelectedContext(savedContext ?? null);
      return;
    }
    // Wait until every image has finished backend processing.
    const allReady = attachedImages.every((img) => img.filePath !== null);
    if (!allReady) return;

    const {
      query: pendingQuery,
      context,
      think,
      promptOverride,
    } = pendingSubmitRef.current;
    pendingSubmitRef.current = null;
    setIsSubmitPending(false);
    // Clear the preview message — ask() will add the real one with file paths.
    setPendingUserMessage(null);

    const images = attachedImages.map((img) => img.filePath as string);
    void ask(pendingQuery, context, images, think || undefined, promptOverride);
    // Note: the display content in the pending bubble (set in handleSubmit)
    // already includes command triggers for visibility in the chat.
    setSelectedContext(null);
    for (const img of attachedImages) {
      URL.revokeObjectURL(img.blobUrl);
    }
    setAttachedImages([]);
  }, [attachedImages, ask, setSelectedContext]);
  /* eslint-enable @eslint-react/set-state-in-effect */

  /**
   * Unified cancel handler: reverts a pending submit (undo-send), clears an
   * in-flight /screen capture, or cancels an active Ollama generation.
   *
   * Three cases:
   * 1. Image-processing pending (`pendingSubmitRef.current` is set): restore
   *    query and attached images so the user can re-submit or edit.
   * 2. Screen-capture in-flight (`isSubmitPending` true but ref is null):
   *    clear pending state. The async capture may still complete on the Rust
   *    side, but `isSubmitPending` being false when the result arrives will
   *    cause `handleScreenSubmit` to attempt ask() on stale state. To prevent
   *    that, we track the abandonment via a flag so the async tail is a no-op.
   * 3. Ollama generation active: delegate to the streaming cancel.
   */
  const handleCancel = useCallback(() => {
    if (isSubmitPending && pendingSubmitRef.current) {
      // Case 1: image-processing pending. Restore input state.
      setQuery(pendingSubmitRef.current.query);
      setSelectedContext(pendingSubmitRef.current.context ?? null);
      pendingSubmitRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (isSubmitPending) {
      // Case 2: /screen capture in flight. Signal cancellation via ref so the
      // async tail in handleScreenSubmit skips ask() when capture resolves.
      // Restore the ask bar to what it looked like before the capture started.
      screenCapturePendingRef.current = false;
      const snapshot = screenCaptureInputSnapshotRef.current;
      screenCaptureInputSnapshotRef.current = null;
      setIsSubmitPending(false);
      setPendingUserMessage(null);
      /* v8 ignore start -- snapshot is always set when isSubmitPending is true via /screen */
      if (snapshot) {
        setQuery(snapshot.query);
        setSelectedContext(snapshot.context ?? null);
      }
      /* v8 ignore stop */
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    cancel();
  }, [isSubmitPending, cancel, setSelectedContext]);

  /** Model configuration is now managed by useModelSelection hook. */

  /**
   * Synchronizes the React animation state with Tauri-driven overlay visibility
   * requests emitted from the Rust backend.
   */
  useEffect(() => {
    let unlistenVisibility: (() => void) | undefined;
    let unlistenOnboarding: (() => void) | undefined;
    let unlistenMinibar: (() => void) | undefined;
    let unlistenNotification: { unregister: () => Promise<void> } | undefined;

    const attachListeners = async () => {
      unlistenVisibility = await listen<OverlayVisibilityPayload>(
        OVERLAY_VISIBILITY_EVENT,
        ({ payload }) => {
          if (payload.state === 'show') {
            replayEntranceAnimation(
              payload.selected_text ?? null,
              payload.window_x ?? null,
              payload.window_y ?? null,
              payload.screen_bottom_y ?? null,
              payload.auto_explain ?? false,
              payload.inline_edit ?? false,
            );
            return;
          }
          requestHideOverlay();
        },
      );
      unlistenOnboarding = await listen<{ stage: OnboardingStage }>(
        ONBOARDING_EVENT,
        ({ payload }) => {
          setOnboardingStage(payload.stage);
        },
      );
      unlistenMinibar = await listen('mate://minibar', () => {
        setOverlayState((prev) => {
          if (prev === 'visible' || prev === 'hiding') {
            void invoke('enter_minibar_size');
            return 'minibar';
          }
          return prev;
        });
      });
      // Clicking a desktop notification restores the overlay from minibar/hidden.
      try {
        // Use Tauri notification plugin's onAction to detect notification clicks.
        const { onAction } = await import('@tauri-apps/plugin-notification');
        unlistenNotification = await onAction(() => {
          if (overlayStateRef.current === 'minibar') {
            void invoke('exit_minibar_size');
            setOverlayState('visible');
          } else if (overlayStateRef.current === 'hidden') {
            void invoke('notify_overlay_hidden');
          }
        });
      } catch {
        // Notification action listener not supported in test env.
      }
      // Both listeners registered — safe to let Rust decide what to show on launch.
      await invoke('notify_frontend_ready');
    };

    void attachListeners();
    return () => {
      unlistenVisibility?.();
      unlistenOnboarding?.();
      unlistenMinibar?.();
      unlistenNotification?.unregister();
    };
  }, [replayEntranceAnimation, requestHideOverlay]);

  /**
   * Combined close handler shared by the keyboard shortcut (Esc/Ctrl+W)
   * and the window control close button. Notifies the Rust
   * backend and triggers the frontend exit animation sequence.
   */
  const handleCloseOverlay = useCallback(() => {
    void invoke('notify_overlay_hidden');
    requestHideOverlay();
  }, [requestHideOverlay]);

  const handleMinimize = useCallback(() => {
    // Instead of hiding, shrink to minibar mode (floating icon).
    // The user can click the icon to restore the full overlay.
    void invoke('enter_minibar_size');
    setOverlayState('minibar');
  }, []);

  /** Copy the last assistant response to the clipboard. */
  const handleCopyLastResponse = useCallback(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant?.content) {
      void navigator.clipboard.writeText(lastAssistant.content);
    }
  }, [messages]);

  /** Global keyboard shortcuts: Escape/Ctrl+W hides overlay; Ctrl+N/S/H/Ctrl+Shift+C for actions. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (((e.metaKey || e.ctrlKey) && e.key === 'w') || e.key === 'Escape') {
        e.preventDefault();
        handleCloseOverlay();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        handleNewConversation();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'h' && !e.shiftKey) {
        e.preventDefault();
        handleHistoryToggle();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        handleCopyLastResponse();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseOverlay, handleNewConversation, handleSave, handleHistoryToggle, handleCopyLastResponse]);

  /** Programmatic focus when the overlay becomes visible. */
  useEffect(() => {
    if (overlayState === 'visible') {
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [overlayState]);

  /**
   * Commits the native window hide after a fixed deadline from the start of
   * the exit transition.
   */
  useEffect(() => {
    if (overlayState !== 'hiding') return;

    const timer = setTimeout(() => {
      void getCurrentWindow().hide();
      void invoke('notify_overlay_hidden');
      setOverlayState('hidden');
    }, HIDE_COMMIT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [overlayState]);

  /** Prefetch available TTS voices on mount. */
  useEffect(() => {
    void fetchVoices();
  }, [fetchVoices]);

  /**
   * Handles mousedown on any surface of the application window.
   *
   * For non-interactive targets (transparent padding, container chrome, etc.):
   * - Calls `preventDefault()` to suppress the browser's default behaviour of
   *   blurring the active element, keeping textarea focus intact.
   * - Initiates a native platform drag via `startDragging()`.
   *
   * For interactive targets (textarea, buttons, links): returns early so
   * standard DOM behaviour (focus, click, selection) proceeds normally.
   */
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement | null;

    // 1. Allow native text selection in explicitly selectable regions.
    // If the click occurs inside a chat bubble (which has .select-text),
    // we return early so the user can highlight and copy the text.
    if (el?.closest('.select-text')) {
      return;
    }

    // 2. Allow interaction with standard interactive elements.
    const INTERACTIVE_TAGS = new Set([
      'TEXTAREA',
      'INPUT',
      'BUTTON',
      'A',
      'SELECT',
      'PATH',
      'SVG',
    ]);
    let current = el;
    while (current) {
      if (INTERACTIVE_TAGS.has(current.tagName.toUpperCase())) return;
      current = current.parentElement;
    }

    // Suppress the default mousedown side-effect (focus transfer / blur)
    // so the textarea retains keyboard input during window repositioning.
    e.preventDefault();
    void getCurrentWindow().startDragging();

    // After the user repositions the window, drop the upward-grow mode so
    // subsequent conversation growth tracks the new position downward.
    window.addEventListener(
      'mouseup',
      () => {
        growsUpwardRef.current = false;
        setGrowsUpward(false);
      },
      { once: true },
    );
  }, []);

  if (onboardingStage !== null) {
    return (
      <OnboardingView
        stage={onboardingStage}
        onComplete={() => setOnboardingStage(null)}
      />
    );
  }

  return (
    // Minimal padding (pt-2 pb-6) provides just enough physical clearance for the
    // tightened drop shadow to render without clipping at the native window edge.
    <div
      onMouseDown={handleDragStart}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      className={`flex flex-col items-center ${growsUpward ? 'justify-end' : 'justify-start'} h-screen w-screen p-0 bg-transparent overflow-visible`}
    >
      <AnimatePresence mode="wait">
        {shouldRenderOverlay ? (
          <motion.div
            key={`overlay-${sessionId}`}
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26, mass: 0.8 }}
            className={`w-full max-w-2xl p-0 overflow-visible`}
          >
            {/* Relative wrapper — serves as the positioning context for the
                chat-mode history dropdown so it can sit outside the morphing
                container's overflow-hidden boundary without being clipped. */}
            <div className="relative">
              {/* Morphing Container — flex column ensures the input bar
                  always sticks to the bottom without spring animation lag.
                  A CSS `transition: min-height` drives smooth window growth
                  when the chat-mode history dropdown is open; the existing
                  ResizeObserver fires per-frame and calls setSize() so the
                  native window tracks the animation. The dropdown is a sibling
                  (not a child) so overflow-hidden never clips it. */}
              <div
                ref={setContainerRef}
                style={{
                  transition:
                    'height 0.35s cubic-bezier(0.16, 1, 0.3, 1), min-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
                  background: `rgba(32,32,32,var(--app-bg-opacity, 0.92))`,
                  backdropFilter: 'blur(var(--chat-bg-blur, 17px))',
                  WebkitBackdropFilter: 'blur(var(--chat-bg-blur, 17px))',
                }}
                className={`morphing-container relative flex flex-col max-h-150 overflow-hidden rounded-none`}
              >
                {/* Model Picker Panel — floats above conversation when open */}
                {isModelPickerOpen && (
                  <div ref={modelPickerPanelRef}>
                    <ProviderPickerPanel
                      models={modelSelection.all}
                      activeLocalModel={modelSelection.active}
                      onSelectLocal={(model) => {
                        void modelSelection.selectModel(model);
                        handleModelPickerClose();
                      }}
                      onClose={handleModelPickerClose}
                      compact={isChatMode}
                      capabilities={modelSelection.capabilities}
                      provider={provider}
                    />
                  </div>
                )}

                {/* Chat Messages Area — morphs in when in chat mode */}
                <AnimatePresence>
                  {isChatMode ? (
                    <ConversationView
                      messages={
                        pendingUserMessage
                          ? [...messages, pendingUserMessage]
                          : messages
                      }
                      isGenerating={isGenerating || isSubmitPending}
                      onClose={handleCloseOverlay}
                      onMinimize={handleMinimize}
                      onSave={handleSave}
                      isSaved={isSaved}
                      canSave={canSave}
                      onNewConversation={handleNewConversation}
                      onHistoryOpen={handleHistoryToggle}
                      onImagePreview={handleChatImagePreview}
                      activeModel={displayModel}
                      onModelPickerToggle={handleModelPickerToggle}
                      isModelPickerOpen={isModelPickerOpen}
                      speakingMessageId={speakingMessageId}
                      onSpeak={ttsSpeak}
                      onStopSpeaking={ttsStop}
                      privacyAcknowledged={privacyAcknowledged}
                      onAcknowledgePrivacy={acknowledgePrivacy}
                      ttsVoices={ttsVoices}
                      selectedVoice={selectedVoice}
                      onVoiceChange={setSelectedVoice}
                    />
                  ) : null}
                </AnimatePresence>

                {/* Ask-bar mode history panel — inline below the input bar.
                    The !isChatMode gate lives OUTSIDE AnimatePresence so that when
                    a conversation is loaded (isChatMode → true) the panel unmounts
                    instantly — no exit animation runs alongside ConversationView
                    mounting. Without this, AnimatePresence would hold the panel in
                    the DOM during its exit while ConversationView is also present,
                    causing two rapid ResizeObserver → setSize() calls (jitter).
                    AnimatePresence is still used for the manual toggle (isHistoryOpen)
                    so the drawer height-animates smoothly open and closed. */}
                {!isChatMode && (
                  <AnimatePresence>
                    {isHistoryOpen ? (
                      <motion.div
                        key="ask-bar-history"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                          height: {
                            duration: 0.3,
                            ease: [0.33, 1, 0.68, 1],
                          },
                          opacity: { duration: 0.2, delay: 0.08 },
                        }}
                        style={{ overflow: 'hidden' }}
                        className="border-t border-surface-border"
                      >
                        <HistoryPanel
                          listConversations={listConversations}
                          onLoadConversation={handleLoadConversation}
                          onSaveAndLoad={handleSaveAndLoad}
                          onDeleteConversation={handleDeleteConversation}
                          hasCurrentMessages={false}
                          showNewConversation={false}
                          currentConversationId={conversationId}
                        />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                )}

                {/* Capture error banner: shown when /screen capture fails so
                    the user knows why the message was not sent. */}
                {captureError && (
                  <div className="px-4 py-2 border-t border-red-900/30">
                    <p className="text-red-400 text-xs leading-relaxed">
                      {captureError}
                    </p>
                  </div>
                )}

                {/* Online provider privacy warning — shown once per session
                    when the user tries to send while a cloud provider is active. */}
                {pendingOnlineSubmit && (
                  <div className="px-4 py-3 border-t border-amber-500/20 bg-amber-500/5 flex flex-col gap-2.5">
                    <div className="flex items-start gap-2">
                      <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 2L14 13H2L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                        <path d="M8 7v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <p className="text-[11px] text-amber-200/90 leading-relaxed">
                        <span className="font-medium text-amber-300">Your message will leave this device.</span>{' '}
                        Using <span className="font-medium">{provider.openRouter?.model ?? 'an online model'}</span> sends your conversation to OpenRouter's servers. Do not share sensitive or personal data.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { pendingOnlineSubmit(); }}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition-colors duration-120 cursor-pointer outline-none"
                      >
                        I understand — Send
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingOnlineSubmit(null)}
                        className="flex-1 py-1.5 rounded-lg text-[11px] text-text-secondary hover:bg-white/5 transition-colors duration-120 cursor-pointer outline-none"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Capability mismatch warnings — shown when the active model
                    doesn't support a required capability (vision/thinking). */}
                <CapabilityMismatchStrip
                  activeModel={displayModel}
                  capabilities={modelSelection.capabilities}
                  conflicts={capabilityConflicts}
                />

                {/* Agent mode indicator — shown when agent is active */}
                <AgentIndicator
                  isActive={agentMode.isActive}
                  status={agentMode.status}
                  lastAction={agentMode.lastAction}
                  reasoning={agentMode.reasoning}
                  pendingConfirmation={agentMode.pendingConfirmation}
                  onStop={agentMode.stop}
                  onConfirm={agentMode.confirmAction}
                  onReject={agentMode.rejectAction}
                />

                {/* Tip Bar — shown in chat mode */}
                {isChatMode && tipVisible && (
                  <TipBar tip={tip} tipKey={tipKey} />
                )}

                {/* Input Bar — always pinned to the bottom */}
                <AskBarView
                  query={query}
                  setQuery={setQuery}
                  isChatMode={isReplying}
                  isGenerating={isGenerating}
                  isSubmitPending={isSubmitPending}
                  onSubmit={handleSubmit}
                  onCancel={handleCancel}
                  inputRef={inputRef}
                  selectedText={selectedContext ?? undefined}
                  onHistoryOpen={handleHistoryToggle}
                  onSettingsOpen={() => { void invoke('open_settings_window'); }}
                  attachedImages={isSubmitPending ? [] : attachedImages}
                  onImagesAttached={handleImagesAttached}
                  onImageRemove={handleImageRemove}
                  onImagePreview={handleAskBarImagePreview}
                  onScreenshot={handleScreenshot}
                  onRegionCapture={handleRegionCapture}
                  isDragOver={isDragOver ?? undefined}
                  onModelPickerToggle={handleModelPickerToggle}
                  isModelPickerOpen={isModelPickerOpen}
                  inlineEditMode={inlineEditMode}
                  onInlineEditToggle={() => { setInlineEditMode((p) => !p); }}
                  attachedFiles={isSubmitPending ? [] : attachedFiles}
                  onFileRemove={handleFileRemove}
                />
                {/* Hidden file input for /file command picker */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.xml,.yaml,.yml,.toml,.html,.css,.sh,.bat,.ps1,.sql,.rb,.php,.swift,.kt,.cs,.r,.tex"
                  aria-hidden="true"
                  tabIndex={-1}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) handleTextFilesAttached(files);
                    // Reset so the same file can be re-selected next time.
                    e.target.value = '';
                  }}
                />
              </div>

              {/* Chat-mode history dropdown — sibling of the morphing container so
                  it is never clipped by its overflow-hidden. Positioned absolutely
                  within this relative wrapper (same coordinate space as the
                  container). The container's minHeight animation grows the native
                  window tall enough to reveal the full dropdown. */}
              <AnimatePresence>
                {isChatMode && isHistoryOpen ? (
                  <motion.div
                    ref={historyDropdownRef}
                    key="chat-history"
                    initial={{ opacity: 0, y: -8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    className="history-dropdown absolute left-2 top-10 z-50 w-56 rounded-lg border border-surface-border bg-surface-base overflow-hidden flex flex-col"
                  >
                    <HistoryPanel
                      listConversations={listConversations}
                      onLoadConversation={handleLoadConversation}
                      onSaveAndLoad={handleSaveAndLoad}
                      onDeleteConversation={handleDeleteConversation}
                      hasCurrentMessages={messages.length > 0 && !isSaved}
                      currentConversationId={conversationId}
                      showNewConversation={false}
                      pendingNewConversation={pendingNewConversation}
                      onSaveAndNew={handleSaveAndNew}
                      onJustNew={handleJustNew}
                      onCancelNew={() => setIsHistoryOpen(false)}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {overlayState === 'minibar' && (
        <MinibarView
          status={agentMode.isActive ? agentMode.status : null}
          lastMessage={agentMode.reasoning}
          onClick={() => {
            void invoke('exit_minibar_size');
            setOverlayState('visible');
          }}
        />
      )}
      <ImagePreviewModal
        imageUrl={previewImageUrl}
        onClose={() => setPreviewImageUrl(null)}
      />
    </div>
  );
}

export default App;
