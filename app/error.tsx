"use client";

import { useEffect } from "react";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">{error.message || "An unexpected error occurred."}</p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900"
      >
        Try again
      </button>
    </div>
  );
}
