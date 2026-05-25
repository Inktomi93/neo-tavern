import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// The class-merge helper every shadcn component uses: clsx for conditionals,
// tailwind-merge to dedupe conflicting Tailwind utilities.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
