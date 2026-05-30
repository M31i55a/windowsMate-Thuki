import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FavoritesPanel } from '../FavoritesPanel';

describe('FavoritesPanel', () => {
  it('renders empty state when there are no favorites', () => {
    render(
      <FavoritesPanel
        favorites={[]}
        currentQuery=""
        onInsert={vi.fn()}
        onRemove={vi.fn()}
        onSaveCurrentQuery={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/No saved prompts yet\./)).toBeInTheDocument();
  });

  it('renders favorite prompts and handles actions', () => {
    const onInsert = vi.fn();
    const onRemove = vi.fn();
    const onSaveCurrentQuery = vi.fn();
    const onClose = vi.fn();

    render(
      <FavoritesPanel
        favorites={['Summarize my notes', 'Draft a reply']}
        currentQuery="Draft a reply"
        onInsert={onInsert}
        onRemove={onRemove}
        onSaveCurrentQuery={onSaveCurrentQuery}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Summarize my notes')).toBeInTheDocument();
    expect(screen.getByText('Draft a reply')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('Use')[0]);
    expect(onInsert).toHaveBeenCalledWith('Summarize my notes');

    fireEvent.click(screen.getAllByText('Remove')[1]);
    expect(onRemove).toHaveBeenCalledWith('Draft a reply');

    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows save current prompt button when the current query is new', () => {
    const onSaveCurrentQuery = vi.fn();

    render(
      <FavoritesPanel
        favorites={['Summarize my notes']}
        currentQuery="New prompt to save"
        onInsert={vi.fn()}
        onRemove={vi.fn()}
        onSaveCurrentQuery={onSaveCurrentQuery}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Save current prompt'));
    expect(onSaveCurrentQuery).toHaveBeenCalledWith('New prompt to save');
  });
});
