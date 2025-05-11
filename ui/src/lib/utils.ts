import { type ClassValue, clsx } from 'clsx'; // Keep original import order if preferred
import { twMerge } from 'tailwind-merge';

/**
 * Combines multiple class names or class name arrays into a single string,
 * resolving Tailwind CSS utility conflicts using `tailwind-merge`.
 *
 * @param inputs - A list of class names or class name arrays. Can include conditional classes via `clsx` syntax.
 * @returns A merged string of class names suitable for the `className` prop.
 * @example
 * ```tsx
 * <div className={cn("p-4", "bg-red-500", isActive && "font-bold")} />
 * // If isActive is true, output might be: "p-4 bg-red-500 font-bold"
 *
 * <div className={cn("p-4 bg-blue-500", "p-6")} />
 * // Output: "bg-blue-500 p-6" (p-6 overrides p-4 due to twMerge)
 * ```
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
