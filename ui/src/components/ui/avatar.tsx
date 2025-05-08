"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from '@/lib/utils'

/**
 * `Avatar` is the root component for displaying an avatar.
 * It serves as a container for {@link AvatarImage} and {@link AvatarFallback}.
 * Based on `@radix-ui/react-avatar`.
 *
 * @param props - The props for the component, extending Radix Avatar Root props.
 * @param props.className - Additional CSS class names.
 * @example
 * ```tsx
 * <Avatar>
 *   <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
 *   <AvatarFallback>CN</AvatarFallback>
 * </Avatar>
 * ```
 */
const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    data-slot="avatar"
    className={cn(
      "relative flex size-8 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

/**
 * `AvatarImage` is used within {@link Avatar} to display the actual image.
 * It handles image loading and transitions.
 * Based on `@radix-ui/react-avatar`.
 *
 * @param props - The props for the component, extending Radix Avatar Image props.
 * @param props.className - Additional CSS class names.
 */
const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    data-slot="avatar-image"
    className={cn("aspect-square size-full", className)}
    {...props}
  />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

/**
 * `AvatarFallback` is used within {@link Avatar} to display a fallback
 * (e.g., initials) when the image is loading or fails to load.
 * Based on `@radix-ui/react-avatar`.
 *
 * @param props - The props for the component, extending Radix Avatar Fallback props.
 * @param props.className - Additional CSS class names.
 */
const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    data-slot="avatar-fallback"
    className={cn(
      "bg-muted flex size-full items-center justify-center rounded-full",
      className
    )}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }

