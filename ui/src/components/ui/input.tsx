import * as React from "react"

import { cn } from '@/lib/utils'

/**
 * Props for the {@link Input} component.
 * Extends standard HTML input attributes.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * `Input` displays a form input field or a component that looks like an input field.
 * It includes styling for focus, disabled, and invalid states.
 *
 * @param props - The props for the component.
 * @param props.className - Additional CSS class names.
 * @param props.type - The type of the input (e.g., "text", "password", "email").
 * @example
 * ```tsx
 * <Input type="email" placeholder="Email" />
 * ```
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        className={cn(
          "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
