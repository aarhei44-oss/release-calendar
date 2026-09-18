"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Loader2 } from "lucide-react";
import type { listNewsItems } from "@/data/news/newsRepo";
import { NEUTRAL_BADGE_CLASS, formatRelativeTime } from "@/app/calendar/eventDisplay";

type InstallOption = { id: string; name: string };
type NewsItem = Awaited<ReturnType<typeof listNewsItems>>[number];

type Props = {
  installOptions: InstallOption[];
  installIds: string[];
  items: NewsItem[];
};

const checkboxBoxClass =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-300 transition-colors data-[state=checked]:border-gray-900 data-[state=checked]:bg-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:border-gray-600 dark:data-[state=checked]:border-gray-100 dark:data-[state=checked]:bg-gray-100 dark:focus-visible:ring-gray-100";

export function NewsShell({ installOptions, installIds, items }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function toggleInstall(id: string, checked: boolean) {
    const next = checked ? [...installIds, id] : installIds.filter((v) => v !== id);
    startTransition(() => {
      router.push(next.length > 0 ? `/news?installIds=${next.join(",")}` : "/news");
    });
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 lg:flex-row lg:p-8">
      <aside className="flex shrink-0 flex-col gap-2 lg:w-48">
        <h2 className="text-xs font-medium text-gray-600 dark:text-gray-400">Game</h2>
        <div className="flex flex-col gap-2">
          {installOptions.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <Checkbox.Root
                checked={installIds.includes(option.id)}
                onCheckedChange={(checked) => toggleInstall(option.id, checked === true)}
                className={checkboxBoxClass}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white dark:text-gray-900" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {option.name}
            </label>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">News</h1>
          {isPending && <Loader2 className="h-4 w-4 animate-spin text-gray-400 dark:text-gray-500" aria-label="Loading" />}
        </div>

        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
            No news items match the current filter.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-gray-200 bg-white p-3.5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-gray-900 hover:underline dark:text-gray-100"
                >
                  {item.title}
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className={NEUTRAL_BADGE_CLASS}>{item.source.tier}</span>
                  <span>{item.source.label}</span>
                  <span aria-hidden>·</span>
                  <span>{formatRelativeTime(item.publishedAt)}</span>
                </div>
                {item.summary && <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">{item.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
