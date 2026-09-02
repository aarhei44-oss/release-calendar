"use client";

import type { ComponentProps } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { FilterBar } from "./FilterBar";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ComponentProps<typeof FilterBar>;

export function FilterSidebar({ open, onOpenChange, ...filterBarProps }: Props) {
  return (
    <>
      <div className="hidden lg:flex lg:w-72 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-gray-200 lg:p-4 dark:lg:border-gray-800">
        <FilterBar {...filterBarProps} />
      </div>

      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <AnimatePresence>
          {open && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="fixed inset-0 z-40 bg-black/30 lg:hidden"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount aria-describedby={undefined}>
                <motion.div
                  className="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-white p-4 shadow-xl lg:hidden dark:bg-gray-900"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <Dialog.Title className="text-sm font-semibold">Filters</Dialog.Title>
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        aria-label="Close filters"
                        className="text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:hover:text-gray-200 dark:focus-visible:ring-gray-100"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </Dialog.Close>
                  </div>
                  <FilterBar {...filterBarProps} />
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
    </>
  );
}
