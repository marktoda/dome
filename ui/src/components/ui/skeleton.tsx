import * as React from "react" // Import React
import { cn } from '@/lib/utils'

/**
 * Props for the {@link Skeleton} component.
 * Extends standard HTML div attributes.
 */
export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * `Skeleton` is used to display a placeholder preview of content before the data loads.
 * It renders a simple shape with a pulsing animation.
 *
 * @param props - The props for the component.
 * @param props.className - Additional CSS class names to control size, shape, etc.
 * @example
 * ```tsx
 * <div className="flex items-center space-x-4">
 *   <Skeleton className="h-12 w-12 rounded-full" />
 *   <div className="space-y-2">
 *     <Skeleton className="h-4 w-[250px]" />
 *     <Skeleton className="h-4 w-[200px]" />
 *   </div>
 * </div>
 * ```
 */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="skeleton"
        className={cn("animate-pulse rounded-md bg-muted", className)} // Use bg-muted for better contrast
        {...props}
      />
    )
  }
)
Skeleton.displayName = "Skeleton"

export { Skeleton }
