interface FavoritesPanelProps {
  favorites: string[];
  currentQuery: string;
  onInsert: (prompt: string) => void;
  onRemove: (prompt: string) => void;
  onSaveCurrentQuery: (prompt: string) => void;
  onClose: () => void;
}

export function FavoritesPanel({
  favorites,
  currentQuery,
  onInsert,
  onRemove,
  onSaveCurrentQuery,
  onClose,
}: FavoritesPanelProps) {
  const trimmedQuery = currentQuery.trim();
  const canSaveCurrentQuery =
    trimmedQuery.length > 0 && !favorites.includes(trimmedQuery);

  return (
    <div className="border-t border-surface-border bg-surface-base px-4 py-3 text-sm text-text-secondary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.22em] font-semibold text-text-secondary/80">
            Prompt favorites
          </p>
          <p className="mt-1 text-[11px] text-text-secondary/80">
            Save commonly used prompts with <span className="font-medium">/favorites add</span> or Ctrl+P.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary transition-colors"
        >
          Close
        </button>
      </div>

      {canSaveCurrentQuery && (
        <button
          type="button"
          onClick={() => onSaveCurrentQuery(trimmedQuery)}
          className="mt-3 inline-flex items-center rounded-lg bg-white/5 px-3 py-2 text-[11px] font-semibold text-text-primary hover:bg-white/10 transition-colors"
        >
          Save current prompt
        </button>
      )}

      <div className="mt-4 space-y-2">
        {favorites.length === 0 ? (
          <p className="text-[12px] leading-5 text-text-secondary/80">
            No saved prompts yet. Use <span className="font-semibold">/favorites add</span> followed by your text to pin a prompt.
          </p>
        ) : (
          favorites.map((prompt) => (
            <div
              key={prompt}
              className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[13px] text-text-primary"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="flex-1 whitespace-pre-wrap wrap-break-word">{prompt}</p>
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => onInsert(prompt)}
                    className="rounded-lg px-2 py-1 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(prompt)}
                    className="rounded-lg px-2 py-1 text-[11px] font-medium text-text-secondary hover:text-white transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
