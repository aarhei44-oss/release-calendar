import { describe, expect, it } from "vitest";
import { assertCommentContentAllowed, ContentRejectedError } from "@/lib/moderation/contentFilter";

describe("assertCommentContentAllowed", () => {
  it("allows ordinary comment text", () => {
    expect(() => assertCommentContentAllowed("Can't wait for this set to drop, the art looks amazing!")).not.toThrow();
  });

  it("rejects a comment containing profanity", () => {
    expect(() => assertCommentContentAllowed("this set is fucking amazing")).toThrow(ContentRejectedError);
  });

  it("rejects common obfuscated/leetspeak variants of profanity", () => {
    // obscenity's transformer pipeline is what's actually under test here --
    // catching intentional obfuscation is the whole reason it's used
    // instead of a bare substring check.
    expect(() => assertCommentContentAllowed("fuuuuuuuck")).toThrow(ContentRejectedError);
    expect(() => assertCommentContentAllowed("wordsbeforefuckandafter")).toThrow(ContentRejectedError);
  });

  it("does not flag an innocuous word that merely contains a blocked substring (the Scunthorpe problem)", () => {
    expect(() => assertCommentContentAllowed("I love bananas so yeah")).not.toThrow();
  });

  it("throws with a user-facing message, not an internal one", () => {
    try {
      assertCommentContentAllowed("fuck");
      throw new Error("expected assertCommentContentAllowed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContentRejectedError);
      expect((err as Error).message).toMatch(/isn't allowed/i);
    }
  });
});
