"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner" // Use type import for ToasterProps

/**
 * `Toaster` component wraps the `Sonner` toast provider to integrate with `next-themes`.
 * It automatically sets the theme for the toasts based on the current application theme.
 * It also applies custom CSS variables for styling based on the application's theme variables.
 *
 * Place this component once in your root layout (`app/layout.tsx`) to enable toast notifications.
 *
 * @param props - Props passed down to the underlying `Sonner` component.
 * @returns A React functional component rendering the Sonner toast provider.
 * @example
 * ```tsx
 * // In layout.tsx
 * import { Toaster } from "@/components/ui/sonner"
 *
 * export default function RootLayout({ children }: RootLayoutProps) {
 *   return (
 *     <html lang="en" suppressHydrationWarning>
 *       <body>
 *         <ThemeProvider> // Assuming ThemeProvider is used
 *           {children}
 *           <Toaster />
 *         </ThemeProvider>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      // Cast theme to the specific string literals expected by Sonner's theme prop
      theme={theme as "light" | "dark" | "system"}
      className="toaster group"
      toastOptions={{ // Apply base styling via toastOptions for consistency
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      // The style prop with CSS variables might be redundant if classNames cover styling sufficiently.
      // Keeping it for now as it was in the original code.
      style={
        {
          "--normal-bg": "var(--popover)", // Example: map CSS vars if needed
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

