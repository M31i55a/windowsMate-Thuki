/**
 * Represents a text file attached to the current (unsent) message.
 *
 * The `content` is populated asynchronously once the browser's FileReader
 * finishes reading the file. While `content` is null the chip shows a spinner.
 */
export interface AttachedFile {
  /** Unique identifier for stable React list keys. */
  id: string;
  /** Original file name (e.g. "readme.txt"). Shown in chips and message bubbles. */
  name: string;
  /** File text content, set once FileReader completes. Null while loading. */
  content: string | null;
}

/** Maximum size in bytes accepted for a text file attachment (1 MB). */
export const MAX_TEXT_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/** Maximum number of text files that can be attached per message. */
export const MAX_TEXT_FILES = 5;
