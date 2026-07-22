import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TypingIndicator } from '../TypingIndicator';

describe('TypingIndicator', () => {
  it('renders the thinking loader and keeps it left aligned', () => {
    const { container } = render(<TypingIndicator />);
    expect(container.querySelector('.thinking-loader')).not.toBeNull();
    expect(container.firstElementChild?.classList.contains('justify-start')).toBe(true);
  });

  it('has accessible status role and label', () => {
    const { container } = render(<TypingIndicator />);
    const loader = container.querySelector('[role="status"]');
    expect(loader).not.toBeNull();
    expect(loader?.getAttribute('aria-label')).toBe('AI is thinking');
  });
});
