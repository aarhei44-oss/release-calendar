"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { setUserRole, setUserActive, setUserPremium } from "./actions";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: "USER" | "ADMIN";
  active: boolean;
  isPremium: boolean;
  premiumOverride: boolean;
  stripeSubscriptionStatus: string | null;
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
