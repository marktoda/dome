import { z } from 'zod';

/**
 * Delivery method enum
 */
export enum DeliveryMethod {
  EMAIL = 'email',
  SLACK = 'slack',
  SMS = 'sms',
  PUSH = 'push',
}

/**
 * Reminder interface
 */
export interface Reminder {
  id: string;
  taskId: string;
  remindAt: number;
  delivered: boolean;
  deliveryMethod: DeliveryMethod;
  createdAt: number;
}

/**
 * Zod schema for validating reminder creation
 */
export const createReminderSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  remindAt: z.number().min(Date.now(), 'Reminder time must be in the future'),
  deliveryMethod: z
    .enum([DeliveryMethod.EMAIL, DeliveryMethod.SLACK, DeliveryMethod.SMS, DeliveryMethod.PUSH])
    .default(DeliveryMethod.EMAIL),
});

/**
 * Type for reminder creation data
 */
export type CreateReminderData = z.infer<typeof createReminderSchema>;

/**
 * Zod schema for validating reminder updates
 */
export const updateReminderSchema = z.object({
  remindAt: z.number().min(Date.now(), 'Reminder time must be in the future').optional(),
  delivered: z.boolean().optional(),
  deliveryMethod: z
    .enum([DeliveryMethod.EMAIL, DeliveryMethod.SLACK, DeliveryMethod.SMS, DeliveryMethod.PUSH])
    .optional(),
});

/**
 * Type for reminder update data
 */
export type UpdateReminderData = z.infer<typeof updateReminderSchema>;

/**
 * Zod schema for validating reminder delivery
 */
export const markReminderDeliveredSchema = z.object({
  delivered: z.literal(true),
});

/**
 * Type for marking reminder as delivered
 */
export type MarkReminderDeliveredData = z.infer<typeof markReminderDeliveredSchema>;
