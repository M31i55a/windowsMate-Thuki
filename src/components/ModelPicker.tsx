/**
 * ModelPicker — chip trigger button for the model selector.
 *
 * Renders a compact chip that opens/closes the ModelPickerPanel when
 * clicked. Does not own any panel state — the parent controls `isOpen`
 * and `onClick`.
 */

import styles from '../styles/model-picker.module.css';

/** CPU/model chip icon — hoisted to avoid re-allocation on every render. */
const CHIP_ICON = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="2" width="20" height="20" rx="3" />
    <path d="M9 2v20M15 2v20M2 9h20M2 15h20" />
  </svg>
);

export interface ModelPickerProps {
  /** Called when the user clicks the chip. */
  onClick: () => void;
  /** When true, the button is non-interactive. */
  disabled?: boolean;
  /** Controls the aria-expanded attribute — set to true when the panel is open. */
  isOpen: boolean;
  /**
   * Optional label shown inside the chip (e.g. active model name).
   * When omitted, only the icon is rendered.
   */
  label?: string;
}

export function ModelPicker({
  onClick,
  disabled = false,
  isOpen,
  label,
}: ModelPickerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Choose model"
      aria-expanded={isOpen}
      data-model-picker-toggle
      className={styles.chip}
    >
      {CHIP_ICON}
      {label !== undefined && label !== '' && (
        <span className={styles.chipLabel}>{label}</span>
      )}
    </button>
  );
}