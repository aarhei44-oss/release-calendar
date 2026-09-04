"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthButton } from "@/components/AuthButton";

const navLinkClass = "text-sm text-gray-700 hover:underline dark:text-gray-300";

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="shrink-0 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold">Release Watcher</span>
          <nav className="hidden items-center gap-3 md:flex">
            <Link href="/calendar" className={navLinkClass}>
              Calendar
            </Link>
            <Link href="/premium" className={navLinkClass}>
              Upgrade
            </Link>
          </nav>
        </div>
        <div className="hidden md:block">
          <AuthButton />
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 md:hidden dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
            )}
          </svg>
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-gray-200 px-4 py-3 md:hidden dark:border-gray-800">
          <nav className="flex flex-col gap-3" onClick={() => setOpen(false)}>
            <Link href="/calendar" className={navLinkClass}>
              Calendar
            </Link>
            <Link href="/premium" className={navLinkClass}>
              Upgrade
            </Link>
          </nav>
          <div onClick={() => setOpen(false)}>
            <AuthButton />
          </div>
        </div>
      )}
    </header>
  );
}
