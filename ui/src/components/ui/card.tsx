import * as React from "react"

import { cn } from '@/lib/utils'

/**
 * `Card` is a container component used to group related content.
 * It serves as the main wrapper for other card elements like {@link CardHeader}, {@link CardContent}, etc.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Card Title</CardTitle>
 *     <CardDescription>Card Description</CardDescription>
 *   </CardHeader>
 *   <CardContent>
 *     <p>Card content goes here.</p>
 *   </CardContent>
 *   <CardFooter>
 *     <Button>Action</Button>
 *   </CardFooter>
 * </Card>
 * ```
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    className={cn(
      "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

/**
 * `CardHeader` is a subcomponent for the {@link Card} that typically contains
 * the {@link CardTitle}, {@link CardDescription}, and optionally {@link CardAction}.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-header"
    className={cn(
      "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
      className
    )}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

/**
 * `CardTitle` is a subcomponent for the {@link CardHeader} used to display the main title of the card.
 * It should be semantically a heading element.
 *
 * @param props - The props for the component, extending standard HTML heading attributes.
 * @param props.className - Additional CSS class names.
 */
const CardTitle = React.forwardRef<
  HTMLParagraphElement, // Radix often uses p for titles, but h3/h4 might be more semantic
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3 // Using h3 for better semantics, adjust as needed for heading hierarchy
    ref={ref}
    data-slot="card-title"
    className={cn("leading-none font-semibold", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

/**
 * `CardDescription` is a subcomponent for the {@link CardHeader} used to display
 * additional details or a subtitle for the card.
 *
 * @param props - The props for the component, extending standard HTML paragraph attributes.
 * @param props.className - Additional CSS class names.
 */
const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="card-description"
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

/**
 * `CardAction` is an optional subcomponent for the {@link CardHeader}
 * typically used to place action elements (e.g., a button or dropdown)
 * in the top-right corner of the header.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const CardAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-action"
    className={cn(
      "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
      className
    )}
    {...props}
  />
))
CardAction.displayName = "CardAction"

/**
 * `CardContent` is a subcomponent for the {@link Card} that holds the main content area.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-content"
    className={cn("px-6", className)}
    {...props}
  />
))
CardContent.displayName = "CardContent"

/**
 * `CardFooter` is a subcomponent for the {@link Card} that typically contains
 * action buttons or supplementary information at the bottom of the card.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-footer"
    className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
