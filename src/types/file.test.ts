import { describe, it, expect } from 'vitest';
import { MAX_TEXT_FILE_SIZE_BYTES, MAX_TEXT_FILES } from './file';

describe('file type constants', () => {
  it('MAX_TEXT_FILE_SIZE_BYTES is 1 MB', () => {
    expect(MAX_TEXT_FILE_SIZE_BYTES).toBe(1 * 1024 * 1024);
  });

  it('MAX_TEXT_FILES is 5', () => {
    expect(MAX_TEXT_FILES).toBe(5);
  });
});
