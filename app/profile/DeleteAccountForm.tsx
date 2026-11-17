"use client";

import { useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { deleteMyAccount } from "./actions";

const CONFIRM_WORD = "DELETE";

export function DeleteAccountForm({ hasSubscription, supportEmail }: { hasSubscription: boolean; supportEmail: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function cancel() {
    setOpen(false);
    setTyped("");
    setError(null);
  }

  function confirmDelete() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteMyAccount(typed);
      } catch {
        setError(
          `We couldn't delete your account${hasSubscription ? " (your subscription was not changed)" : ""}. Please try again, or email ${supportEmail} and we'll do it for you.`,
        );
        return;
      }
      // The account (and its session row) is already gone server-side; this
      // clears the browser's session cookie and lands on the home page.
      await signOut({ callbackUrl: "/?accountDeleted=1" });
    });
  }

  return (
    <section className="rounded-lg border border-red-300 p-4 dark:border-red-900">
      <h2 className="mb-1 text-lg font-semibold text-red-700 dark:text-red-400">Delete account</h2>
      <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
        Delete your Release Watcher account and everything attached to it: your game subscriptions, followed events,
        notes, comments, dismissed events, reactions, dashboard layout, alert settings (including any Discord webhook
        URL), calendar feed link, and the link to your Google sign-in.
      </p>
      <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
        <strong className="text-gray-800 dark:text-gray-200">Right away:</strong> you&rsquo;re signed out everywhere,
        all alerts stop, and your comments are hidden.{" "}
        <strong className="text-gray-800 dark:text-gray-200">Within 30 days:</strong> everything is permanently erased.
        If you sign back in before then, the deletion is cancelled &mdash; but your alert settings will have been reset
        and your Premium subscription stays cancelled. If you need your data erased sooner, email{" "}
        <a href={`mailto:${supportEmail}`} className="underline">
          {supportEmail}
        </a>
        .
      </p>
      {hasSubscription && (
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          <strong className="text-gray-800 dark:text-gray-200">Your Premium subscription</strong> will be cancelled
          immediately so you won&rsquo;t be billed again. We don&rsquo;t refund the unused part of the current billing
          period.
        </p>
      )}
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
        <strong className="text-gray-800 dark:text-gray-200">Payment records</strong> (receipts, invoices) are held by
        Stripe, not by us, and stay with Stripe after your account is deleted. To manage or request deletion of those,
        contact{" "}
        <a href="https://stripe.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
          Stripe
        </a>{" "}
        directly. Deleting your account here doesn&rsquo;t affect your Google account; you can revoke Release Watcher&rsquo;s
        access at{" "}
        <a href="https://myaccount.google.com/permissions" className="underline" target="_blank" rel="noopener noreferrer">
          myaccount.google.com/permissions
        </a>
        .
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-red-600 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-500 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          Delete my account&hellip;
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-md bg-red-50 p-3 dark:bg-red-950/30" role="alertdialog" aria-label="Confirm account deletion">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-800 dark:text-gray-200">
              Type <span className="font-mono">{CONFIRM_WORD}</span> to delete your account:
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              autoCapitalize="characters"
              className="w-full max-w-xs rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmDelete}
              disabled={typed !== CONFIRM_WORD || isPending}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Deleting…" : "Delete account"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={isPending}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
