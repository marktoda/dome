/**
 * Telegram User Model
 */

/**
 * Telegram User interface
 */
export interface TelegramUser {
  id: number;
  phoneNumber: string;
  telegramId?: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  accessLevel: number;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Telegram User DTO for database operations
 */
export interface TelegramUserDTO {
  id: number;
  phone_number: string;
  telegram_id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  access_level: number;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Convert database DTO to model
 */
export function fromDTO(dto: TelegramUserDTO): TelegramUser {
  return {
    id: dto.id,
    phoneNumber: dto.phone_number,
    telegramId: dto.telegram_id,
    firstName: dto.first_name,
    lastName: dto.last_name,
    username: dto.username,
    accessLevel: dto.access_level,
    isBlocked: dto.is_blocked,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  };
}

/**
 * Convert model to database DTO
 */
export function toDTO(user: TelegramUser): TelegramUserDTO {
  return {
    id: user.id,
    phone_number: user.phoneNumber,
    telegram_id: user.telegramId,
    first_name: user.firstName,
    last_name: user.lastName,
    username: user.username,
    access_level: user.accessLevel,
    is_blocked: user.isBlocked,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}
