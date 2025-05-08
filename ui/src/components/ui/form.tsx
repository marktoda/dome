"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { Slot } from "@radix-ui/react-slot"
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"

import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label' // This is Radix Label aliased

/**
 * `Form` is a wrapper around `react-hook-form`'s `FormProvider`.
 * It should be used to wrap your form and provide context to all form components.
 *
 * @example
 * ```tsx
 * const form = useForm();
 * return (
 *   <Form {...form}>
 *     <form onSubmit={form.handleSubmit(onSubmit)}>
 *       <FormField name="username" render={...} />
 *       <Button type="submit">Submit</Button>
 *     </form>
 *   </Form>
 * );
 * ```
 */
const Form = FormProvider

/**
 * Context value for {@link FormFieldContext}.
 */
type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName
}

/**
 * Context to provide field name down to form components like {@link FormLabel}, {@link FormControl}.
 */
const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
)

/**
 * `FormField` is a component that connects `react-hook-form`'s `Controller`
 * with the form field context. It should wrap individual form fields.
 *
 * @param props - Props for the `Controller` component from `react-hook-form`.
 * @returns A `Controller` component wrapped with `FormFieldContext.Provider`.
 */
const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

/**
 * `useFormField` is a custom hook that provides access to field-specific context
 * and state within form components. It must be used within a {@link FormField}.
 *
 * @throws Will throw an error if not used within a `FormField` component.
 * @returns An object containing field id, name, form item ids, and field state.
 */
const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState, formState } = useFormContext() // useFormState is not needed here if formState is from useFormContext
  const fieldState = getFieldState(fieldContext.name, formState)

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>")
  }
  if (!itemContext) {
    throw new Error("useFormField should be used within <FormItem>")
  }

  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}

/**
 * Context value for {@link FormItemContext}.
 */
type FormItemContextValue = {
  id: string
}

/**
 * Context to provide a unique ID for a form item and its sub-components (label, description, message).
 */
const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
)

/**
 * `FormItem` is a wrapper component for a single form field, including its label,
 * input control, description, and error message. It provides an ID context.
 *
 * @param props - The props for the component, extending standard HTML div attributes.
 * @param props.className - Additional CSS class names.
 */
const FormItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const id = React.useId()

  return (
    <FormItemContext.Provider value={{ id }}>
      <div
        ref={ref}
        data-slot="form-item"
        className={cn("grid gap-2", className)} {...props} />
    </FormItemContext.Provider>
  )
})
FormItem.displayName = "FormItem"

/**
 * `FormLabel` displays the label for a form field.
 * It uses `useFormField` to connect to the field's context and automatically
 * sets the `htmlFor` attribute. It also styles itself differently if there's an error.
 *
 * @param props - The props for the component, extending Radix Label props.
 * @param props.className - Additional CSS class names.
 */
const FormLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => {
  const { error, formItemId } = useFormField()

  return (
    <Label
      ref={ref}
      data-slot="form-label"
      data-error={!!error}
      className={cn(error && "text-destructive", className)} // Simplified error class
      htmlFor={formItemId}
      {...props}
    />
  )
})
FormLabel.displayName = "FormLabel"

/**
 * `FormControl` is a wrapper for the actual input element (e.g., `<Input />`, `<Textarea />`).
 * It uses `Slot` to pass props to its immediate child.
 * It uses `useFormField` to set ARIA attributes for accessibility.
 *
 * @param props - The props for the component, extending Radix Slot props.
 */
const FormControl = React.forwardRef<
  React.ElementRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>((props, ref) => { // Removed ...props from parameters as Slot takes children
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()

  return (
    <Slot
      ref={ref}
      data-slot="form-control"
      id={formItemId}
      aria-describedby={
        !error
          ? formDescriptionId // Only description if no error
          : `${formDescriptionId} ${formMessageId}` // Both if error
      }
      aria-invalid={!!error}
      {...props} // Spread props here
    />
  )
})
FormControl.displayName = "FormControl"

/**
 * `FormDescription` displays additional information or help text for a form field.
 * It uses `useFormField` to get the correct ID for ARIA linking.
 *
 * @param props - The props for the component, extending standard HTML paragraph attributes.
 * @param props.className - Additional CSS class names.
 */
const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField()

  return (
    <p
      ref={ref}
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-[0.8rem] text-muted-foreground", className)} // Slightly smaller text
      {...props}
    />
  )
})
FormDescription.displayName = "FormDescription"

/**
 * `FormMessage` displays validation error messages for a form field.
 * It uses `useFormField` to get error information and the correct ID for ARIA linking.
 * It only renders if there is an error message or explicit children.
 *
 * @param props - The props for the component, extending standard HTML paragraph attributes.
 * @param props.className - Additional CSS class names.
 * @param props.children - Optional children to display as the message.
 */
const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField()
  const body = error ? String(error?.message) : children // Simplified error message handling

  if (!body) {
    return null
  }

  return (
    <p
      ref={ref}
      data-slot="form-message"
      id={formMessageId}
      className={cn("text-[0.8rem] font-medium text-destructive", className)} // Slightly smaller text
      {...props}
    >
      {body}
    </p>
  )
})
FormMessage.displayName = "FormMessage"

export {
  useFormField,
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
}
