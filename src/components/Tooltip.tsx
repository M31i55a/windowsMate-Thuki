/**
 * Lightweight animated tooltip for icon buttons.
 *
 * Renders via Portal so it escapes any overflow clipping in the app container.
 * `placement="top"` (default) renders above the trigger — safe near the window
 * bottom edge. `placement="bottom"` renders below. Animation is a snappy
 * opacity + scale + y with a custom cubic-bezier.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  /** Short label to display inside the tooltip. */
  label: string;
  /** Allow the tooltip text to wrap across multiple lines. */
  multiline?: boolean;
  /**
   * Which side of the trigger to render the tooltip.
   * @default 'top'
   */
  placement?: 'top' | 'bottom';
  /** Extra class names forwarded to the wrapper div. */
  className?: string;
  /** The trigger element — usually an icon button. */
  children: React.ReactNode;
}

export function Tooltip({ label, multiline, placement = 'top', className, children }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  /** Defer portal mount until after first hover (lazy load). */
  const [hasActivated, setHasActivated] = useState(false);
  /**
   * `left` — clamped horizontal center of the tooltip box (px from viewport left).
   * `top`  — for `placement="bottom"`: distance from viewport top to tooltip top.
   *          for `placement="top"`:    distance from viewport top to tooltip bottom
   *          (the box is shifted -100% upward via transform).
   * `arrowOffset` — how far the arrow shifts from center (px) so it keeps pointing
   *   at the trigger even when the box is clamped away from the window edge.
   */
  const [coords, setCoords] = useState({ left: 0, top: 0, arrowOffset: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    /* v8 ignore start */
    if (!triggerRef.current) return;
    /* v8 ignore stop */
    const rect = triggerRef.current.getBoundingClientRect();
    const rawLeft = rect.left + rect.width / 2;
    // Conservative half-width estimate for the widest label ("Conversation history").
    // Keeps the tooltip box fully inside the viewport near window edges.
    const tooltipHalfWidth = 90;
    const edgePadding = 8;
    const left = Math.max(
      tooltipHalfWidth + edgePadding,
      Math.min(window.innerWidth - tooltipHalfWidth - edgePadding, rawLeft),
    );
    setCoords({
      left,
      top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
      arrowOffset: rawLeft - left,
    });
  };

  const handleMouseEnter = () => {
    if (!hasActivated) setHasActivated(true);
    updatePosition();
    setIsVisible(true);
  };

  const handleMouseLeave = () => {
    setIsVisible(false);
  };

  const handleMouseDown = () => {
    setIsVisible(false);
  };

  useEffect(() => {
    const handleWindowFocus = () => setIsVisible(false);
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);

  const isTop = placement === 'top';

  return (
    <div
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      className={`inline-flex${className ? ` ${className}` : ''}`}
    >
      {children}

      {hasActivated &&
        createPortal(
          <AnimatePresence>
            {isVisible && (
              /*
               * Outer div owns fixed positioning + centering transform.
               * Keeping it separate from the motion.div prevents Framer
               * Motion's transform pipeline from discarding translateX(-50%).
               *
               * For `placement="top"`, translateY(-100%) shifts the box so its
               * bottom edge aligns with `coords.top` (= trigger.top - 8px gap).
               */
              <div
                style={{
                  position: 'fixed',
                  left: coords.left,
                  top: coords.top,
                  transform: isTop ? 'translate(-50%, -100%)' : 'translateX(-50%)',
                  pointerEvents: 'none',
                  zIndex: 9999,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.92, y: isTop ? 4 : -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.92, y: isTop ? 4 : -4 }}
                  transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                >
                  {isTop ? (
                    /* Arrow pointing DOWN toward the trigger (placement="top"). */
                    <div
                      aria-hidden="true"
                      style={{
                        left: `calc(50% + ${coords.arrowOffset}px)`,
                      }}
                      className="absolute -bottom-1.5 h-3 w-3 -translate-x-1/2 rotate-45 border-r border-b border-surface-border bg-surface-base"
                    />
                  ) : (
                    /* Arrow pointing UP toward the trigger (placement="bottom"). */
                    <div
                      aria-hidden="true"
                      style={{
                        left: `calc(50% + ${coords.arrowOffset}px)`,
                      }}
                      className="absolute -top-1.5 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-surface-border bg-surface-base"
                    />
                  )}
                  <div
                    className={`relative rounded-lg border border-surface-border bg-surface-base px-2.5 py-1.5 text-[11px] text-text-primary ${multiline ? 'whitespace-normal' : 'whitespace-nowrap'}`}
                    style={multiline ? { width: '225px' } : undefined}
                  >
                    {label}
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
