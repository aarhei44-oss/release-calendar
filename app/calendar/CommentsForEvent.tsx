"use client";

import { useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import { addComment, deleteComment } from "./actions";

type Comment = {
  id: string;
  content: string;
  createdAt: Date;
  userId: string;
  user: { id: string; name: string | null; image: string | null };
};

type Props = {
  eventId: string;
  initialComments: Comment[];
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function CommentsForEvent({ eventId, initialComments }: Props) {
  const { data: session } = useSession();
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;

    setError(null);
    startTransition(async () => {
      try {
        const comment = await addComment({ eventId, content });
        setComments((prev) => [comment, ...prev]);
        setDraft("");
      } catch {
        setError("Couldn't post your comment. Please try again.");
      }
    });
  }

  function handleDelete(commentId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteComment(commentId);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
      } catch {
        setError("Couldn't delete that comment.");
      }
    });
  }

  const currentUserId = session?.user?.id;
  const isAdmin = session?.user?.role === "ADMIN";

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700">Comments ({comments.length})</h3>

      {session?.user ? (
        <form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Add a comment…"
            className="rounded-md border border-gray-300 p-2 text-sm"
          />
          <button
            type="submit"
            disabled={isPending || draft.trim().length === 0}
            className="self-end rounded-md bg-gray-900 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            Post
          </button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-gray-500">Sign in to leave a comment.</p>
      )}

      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      <ul className="mt-3 flex flex-col gap-3">
        {comments.map((comment) => (
          <li key={comment.id} className="rounded-md border border-gray-200 p-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{comment.user.name ?? "Anonymous"}</span>
              <span className="text-xs text-gray-500">{DATE_FORMATTER.format(comment.createdAt)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-gray-800">{comment.content}</p>
            {(comment.userId === currentUserId || isAdmin) && (
              <button
                type="button"
                onClick={() => handleDelete(comment.id)}
                disabled={isPending}
                className="mt-1 text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
