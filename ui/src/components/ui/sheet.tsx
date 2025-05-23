"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority" // Import cva and VariantProps
import { XIcon } from "lucide-react"

import { cn } from '@/lib/utils'

/**
 * `Sheet` is the root component for the sheet (side panel).
 * It wraps all other sheet components and manages the open/closed state.
 * Based on `@radix-ui/react-dialog`.
 */
const Sheet = SheetPrimitive.Root

/**
 * `SheetTrigger` is a button or element that triggers the opening of the sheet.
 * It should be placed outside the `SheetContent`.
 * Based on `@radix-ui/react-dialog`.
 */
const SheetTrigger = SheetPrimitive.Trigger

/**
 * `SheetClose` is a button or element that triggers the closing of the sheet.
 * It can be placed inside the `SheetContent`.
 * Based on `@radix-ui/react-dialog`.
 */
const SheetClose = SheetPrimitive.Close

/**
 * `SheetPortal` portals its children into the body element or a specified container.
 * Used internally by `SheetContent` to ensure proper layering.
 * Based on `@radix-ui/react-dialog`.
 */
const SheetPortal = SheetPrimitive.Portal

/**
 * `SheetOverlay` is a layer that dims the background content when the sheet is open.
 * Based on `@radix-ui/react-dialog`.
 *
 * @param props - The props for the component, extending Radix Dialog Overlay props.
 * @param props.className - Additional CSS class names.
 */
const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    data-slot="sheet-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", // Adjusted background opacity
      className
    )}
    {...props}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

/**
 * Defines the visual variants for the SheetContent component using `class-variance-authority`.
 */
const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

/**
 * Props for the {@link SheetContent} component.
 * Extends Radix Dialog Content props and includes variant props from `sheetVariants`.
 */
interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

/**
 * `SheetContent` contains the main content of the sheet panel.
 * It includes animations for sliding in/out based on the `side` prop and a default close button.
 * Based on `@radix-ui/react-dialog`.
 *
 * @param props - The props for the component.
 * @param props.side - The side from which the sheet appears ('top', 'bottom', 'left', 'right'). Defaults to 'right'.
 * @param props.className - Additional CSS class names.
 * @param props.children - The content to render inside the sheet.
 */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal forceMount>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      data-slot="sheet-content"
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close
        data-slot="sheet-close-button"
        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary"
      >
        <XIcon className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = SheetPrimitive.Content.displayName

/**
 * `SheetHeader` is a container for the top section of the {@link SheetContent},
 * typically containing {@link SheetTitle} and {@link SheetDescription}.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="sheet-header"
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left", // Adjusted spacing and alignment
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

/**
 * `SheetFooter` is a container for the bottom section of the {@link SheetContent},
 * often used for action buttons like save or cancel.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="sheet-footer"
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", // Adjusted flex direction and spacing
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

/**
 * `SheetTitle` displays the title within the {@link SheetHeader}.
 * Based on `@radix-ui/react-dialog`.
 *
 * @param props - The props for the component, extending Radix Dialog Title props.
 * @param props.className - Additional CSS class names.
 */
const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn("text-lg font-semibold text-foreground", className)} // Adjusted text size
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

/**
 * `SheetDescription` displays additional details or context within the {@link SheetHeader}.
 * Based on `@radix-ui/react-dialog`.
 *
 * @param props - The props for the component, extending Radix Dialog Description props.
 * @param props.className - Additional CSS class names.
 */
const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
