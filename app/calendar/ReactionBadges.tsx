import { topReactions, type ReactionCounts } from "./eventDisplay";

/** Read-only summary badge for a card/list row -- the interactive picker lives in EventDrawer's EventReactions. */
export function ReactionBadges({ counts, limit = 2 }: { counts?: ReactionCounts; limit?: number }) {
  const top = topReactions(counts, limit);
  if (top.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
      {top.map(({ emoji, count }) => (
        <span key={emoji} className="flex items-center gap-0.5">
          <span>{emoji}</span>
          <span>{count}</span>
        </span>
      ))}
    </span>
  );
}
