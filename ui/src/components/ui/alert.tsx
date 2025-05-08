import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from '@/lib/utils'

/**
 * Defines the visual variants for the Alert component using `class-variance-authority`.
 * Includes `default` and `destructive` variants.
 */
const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "text-destructive bg-card [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * Props for the {@link Alert} component.
 * Extends standard HTML div attributes and includes variant props from `alertVariants`.
 */
type AlertProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>

/**
 * Displays a callout for user attention.
 * It can be used to show messages with different levels of importance, such as "default" or "destructive".
 *
 * @param props - The props for the component.
 * @param props.className - Additional CSS class names.
 * @param props.variant - The visual style of the alert (e.g., "default", "destructive").
 * @example
 * ```tsx
 * <Alert variant="destructive">
 *   <AlertTriangle className="h-4 w-4" /> // Example icon
 *   <AlertTitle>Error</AlertTitle>
 *   <AlertDescription>
 *     Your session has expired. Please log in again.
 *   </AlertDescription>
 * </Alert>
 * ```
 */
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
)
Alert.displayName = "Alert"

/**
 * `AlertTitle` is a subcomponent used within {@link Alert} to display its title.
 * It should be used to provide a concise heading for the alert message.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5 // Changed from div to h5 for semantic correctness of a title
    ref={ref}
    data-slot="alert-title"
    className={cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className)}
    {...props}
  />
))
AlertTitle.displayName = "AlertTitle"

/**
 * `AlertDescription` is a subcomponent used within {@link Alert} to display the main content or description.
 * It provides more detailed information related to the alert's title.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div // Keeping div as it might contain more than just text (e.g. links, other elements)
    ref={ref}
    data-slot="alert-description"
    className={cn(
      "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
      className
    )}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

export { Alert, AlertTitle, AlertDescription }
