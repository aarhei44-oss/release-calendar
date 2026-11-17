"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  setUserRole,
  setUserActive,
  setUserPremium,
  deleteUser,
  cancelUserDeletion,
  banUser,
  unbanUser,
} from "./actions";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: "USER" | "ADMIN";
  active: boolean;
  isPremium: boolean;
  premiumOverride: boolean;
  stripeSubscriptionStatus: string | null;
  removalDate: Date | null;
  bannedAt: Date | null;
};

export function UsersTab({ users }: { users: User[] }) {
  const router = useRouter();
  const { data: session } = useSession();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleRole(user: User) {
    setError(null);
    const nextRole = user.role === "ADMIN" ? "USER" : "ADMIN";
    startTransition(async () => {
      try {
        await setUserRole(user.id, nextRole);
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Couldn't update that user's role.",
        );
      }
    });
  }

  function toggleActive(user: User) {
    setError(null);
    startTransition(async () => {
      try {
        await setUserActive(user.id, !user.active);
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Couldn't update that user's active flag.",
        );
      }
    });
  }

  function togglePremium(user: User) {
    setError(null);
    startTransition(async () => {
      try {
        await setUserPremium(user.id, !user.isPremium);
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Couldn't update that user's premium flag.",
        );
      }
    });
  }

  function remove(user: User) {
    const hasSubscription = user.stripeSubscriptionStatus === "active" || user.stripeSubscriptionStatus === "trialing";
    const ok = window.confirm(
      `Delete ${user.email}?\n\nThey're signed out and deactivated immediately${
        hasSubscription ? ", their Premium subscription is cancelled with no refund" : ""
      }, and everything attached to the account is permanently erased in 30 days. They can undo this by signing back in.`,
    );
    if (!ok) return;

    setError(null);
    startTransition(async () => {
      try {
        await deleteUser(user.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't delete that user.");
      }
    });
  }

  function ban(user: User) {
    const hasSubscription = user.stripeSubscriptionStatus === "active" || user.stripeSubscriptionStatus === "trialing";
    const ok = window.confirm(
      `Ban ${user.email}?\n\nThey're signed out everywhere and can't sign in again${
        hasSubscription ? ", and their Premium subscription is cancelled (no refund is issued -- do that in Stripe)" : ""
      }. Their comments are hidden and their alerts stop. The account is kept, not erased, so the ban sticks. You can unban them later.`,
    );
    if (!ok) return;

    setError(null);
    startTransition(async () => {
      try {
        await banUser(user.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't ban that user.");
      }
    });
  }

  function unban(user: User) {
    setError(null);
    startTransition(async () => {
      try {
        await unbanUser(user.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't unban that user.");
      }
    });
  }

  function cancelDeletion(user: User) {
    setError(null);
    startTransition(async () => {
      try {
        await cancelUserDeletion(user.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't cancel that deletion.");
      }
    });
  }

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Active</th>
              <th>Premium</th>
              <th>Ban</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === session?.user?.id;
              return (
                <tr key={user.id} className="border-b border-gray-100">
                  <td className="py-2">{user.email}</td>
                  <td>{user.name ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => toggleRole(user)}
                      title={
                        isSelf
                          ? "You cannot remove your own admin role"
                          : undefined
                      }
                      className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                        user.role === "ADMIN"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {user.role}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => toggleActive(user)}
                      title={
                        isSelf
                          ? "You cannot deactivate your own account"
                          : undefined
                      }
                      className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                        user.active
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {user.active ? "Active" : "Disabled"}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => togglePremium(user)}
                      title="Admin override -- flips isPremium directly, independent of any Stripe subscription. Stays in effect through future webhook syncs (renewals/cancellations) until the user completes a real Stripe checkout or you toggle this again."
                      className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                        user.isPremium
                          ? "bg-purple-100 text-purple-800"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {user.isPremium ? "Premium" : "Free"}
                    </button>
                    {user.premiumOverride && (
                      <span className="ml-1 text-xs text-purple-700" title="isPremium is admin-set and won't be changed by Stripe webhook syncs">
                        (override)
                      </span>
                    )}
                    {user.stripeSubscriptionStatus && (
                      <span className="ml-1 text-xs text-gray-500">({user.stripeSubscriptionStatus})</span>
                    )}
                  </td>
                  <td>
                    {user.bannedAt ? (
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-medium text-red-700">
                          Banned {new Date(user.bannedAt).toLocaleDateString()}
                        </span>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => unban(user)}
                          className="rounded px-2 py-0.5 text-xs font-medium text-blue-700 underline disabled:opacity-50"
                        >
                          Unban
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={isPending || isSelf || user.role === "ADMIN"}
                        onClick={() => ban(user)}
                        title={
                          isSelf
                            ? "You cannot ban your own account"
                            : user.role === "ADMIN"
                              ? "Remove this user's admin role before banning them"
                              : undefined
                        }
                        className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 disabled:opacity-50"
                      >
                        Ban…
                      </button>
                    )}
                  </td>
                  <td>
                    {user.removalDate ? (
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-red-700">
                          Erased {new Date(user.removalDate).toLocaleDateString()}
                        </span>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => cancelDeletion(user)}
                          className="rounded px-2 py-0.5 text-xs font-medium text-blue-700 underline disabled:opacity-50"
                        >
                          Cancel deletion
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={isPending || isSelf}
                        onClick={() => remove(user)}
                        title={isSelf ? "You cannot delete your own account here -- use your Profile page" : undefined}
                        className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 disabled:opacity-50"
                      >
                        Delete…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
