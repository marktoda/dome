"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"

import { cn } from '@/lib/utils'

/**
 * `Label` renders an accessible label associated with a form control.
 * It enhances the standard HTML label element with styling and accessibility features.
 * Based on `@radix-ui/react-label`.
 *
 * @param props - The props for the component, extending Radix Label Root props.
 * @param props.className - Additional CSS class names.
 * @example
 * ```tsx
 * <Label htmlFor="email">Your email address</Label>
 * <Input type="email" id="email" placeholder="Email" />
 * ```
 */
const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    data-slot="label"
    className={cn(
      "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
      className
    )}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }

