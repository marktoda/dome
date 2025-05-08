"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from '@/lib/utils'

/**
 * `ScrollArea` provides a styled scrollable container for content that exceeds its bounds.
 * It includes a viewport for the content and {@link ScrollBar} components.
 * Based on `@radix-ui/react-scroll-area`.
 *
 * @param props - The props for the component, extending Radix ScrollArea Root props.
 * @param props.className - Additional CSS class names for the root element.
 * @param props.children - The content to be rendered within the scrollable area.
 * @example
 * ```tsx
 * <ScrollArea className="h-72 w-48 rounded-md border">
 *   <div className="p-4">
 *     Jokester began sneaking into the castle in the middle of the night and leaving
 *     jokes all over the place: under the king's pillow, in his soup, even in the
 *     royal toilet. The king was furious, but he couldn't seem to stop Jokester.
 *     And then, one day, the people of the kingdom discovered that the jokes left by
 *     Jokester were so funny that they couldn't help but laugh. And once they
 *     started laughing, they couldn't stop.
 *   </div>
 * </ScrollArea>
 * ```
 */
const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    data-slot="scroll-area"
    className={cn("relative overflow-hidden", className)} // Added overflow-hidden
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      data-slot="scroll-area-viewport"
      className="size-full rounded-[inherit]" // Removed focus styles, should be on interactive elements inside
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

/**
 * `ScrollBar` is a subcomponent used within {@link ScrollArea} to display the scrollbar.
 * It can be oriented vertically or horizontally.
 * Based on `@radix-ui/react-scroll-area`.
 *
 * @param props - The props for the component, extending Radix ScrollAreaScrollbar props.
 * @param props.className - Additional CSS class names for the scrollbar element.
 * @param props.orientation - The orientation of the scrollbar ('vertical' or 'horizontal'). Defaults to 'vertical'.
 */
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors", // Removed p-px
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]", // Added padding here
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]", // Added padding here
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      data-slot="scroll-area-thumb"
      className="relative flex-1 rounded-full bg-border" // Keep bg-border
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
