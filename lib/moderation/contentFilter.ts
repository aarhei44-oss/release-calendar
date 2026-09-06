import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

export class ContentRejectedError extends Error {
  constructor(message = "Your comment contains language that isn't allowed here.") {
    super(message);
    this.name = "ContentRejectedError";
  }
}

// Built once per process -- englishDataset.build() compiles the whole
// phrase list into a matching automaton, not something to redo per call.
// englishRecommendedTransformers normalizes common obfuscation (leetspeak,
// repeated/spaced-out letters, unicode look-alikes) before matching, so
// "f u c k" or "fuuuuck" are caught the same as the bare word.
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * PG-13-style upper limit for public, everyone-visible text (event
 * comments): rejects profanity and known slurs (racial, homophobic/
 * transphobic, etc.) via `obscenity`'s maintained English word list.
 *
 * Known limitation, not solvable by any word-list filter: hateful
 * sentiment expressed without a matched slur or profanity (e.g. "go back
 * to your own country") will not be caught -- this is a blocklist, not a
 * sentiment/hate-speech classifier. Treat it as a floor, not a complete
 * moderation solution; genuinely harmful reports still need a human
 * (admin can already delete any comment, see deleteComment).
 */
export function assertCommentContentAllowed(content: string): void {
  if (matcher.hasMatch(content)) {
    throw new ContentRejectedError();
  }
}
