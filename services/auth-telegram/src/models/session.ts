/**
 * Telegram Session Model
 */

/**
 * Telegram Session interface
 */
export interface TelegramSession {
  id: string;
  userId: number;
  encryptedData: Uint8Array;
  iv: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  isActive: boolean;
  deviceInfo?: string;
  ipAddress?: string;
}

/**
 * Telegram Session DTO for database operations
 */
export interface TelegramSessionDTO {
  id: string;
  user_id: number;
  encrypted_data: Uint8Array;
  iv: string;
  version: number;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  expires_at?: string;
  is_active: boolean;
  device_info?: string;
  ip_address?: string;
}

/**
 * Convert database DTO to model
 */
export function fromDTO(dto: TelegramSessionDTO): TelegramSession {
  return {
    id: dto.id,
    userId: dto.user_id,
    encryptedData: dto.encrypted_data,
    iv: dto.iv,
    version: dto.version,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
    lastUsedAt: dto.last_used_at ? new Date(dto.last_used_at) : undefined,
    expiresAt: dto.expires_at ? new Date(dto.expires_at) : undefined,
    isActive: dto.is_active,
    deviceInfo: dto.device_info,
    ipAddress: dto.ip_address,
  };
}

/**
 * Convert model to database DTO
 */
export function toDTO(session: TelegramSession): TelegramSessionDTO {
  return {
    id: session.id,
    user_id: session.userId,
    encrypted_data: session.encryptedData,
    iv: session.iv,
    version: session.version,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    last_used_at: session.lastUsedAt?.toISOString(),
    expires_at: session.expiresAt?.toISOString(),
    is_active: session.isActive,
    device_info: session.deviceInfo,
    ip_address: session.ipAddress,
  };
}

/**
 * Session access log interface
 */
export interface SessionAccessLog {
  id?: number;
  sessionId: string;
  serviceName: string;
  action: string;
  timestamp: Date;
  ipAddress?: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * Session access log DTO for database operations
 */
export interface SessionAccessLogDTO {
  id?: number;
  session_id: string;
  service_name: string;
  action: string;
  timestamp: string;
  ip_address?: string;
  success: boolean;
  error_message?: string;
}

/**
 * Convert access log database DTO to model
 */
export function accessLogFromDTO(dto: SessionAccessLogDTO): SessionAccessLog {
  return {
    id: dto.id,
    sessionId: dto.session_id,
    serviceName: dto.service_name,
    action: dto.action,
    timestamp: new Date(dto.timestamp),
    ipAddress: dto.ip_address,
    success: dto.success,
    errorMessage: dto.error_message,
  };
}

/**
 * Convert access log model to database DTO
 */
export function accessLogToDTO(log: SessionAccessLog): SessionAccessLogDTO {
  return {
    id: log.id,
    session_id: log.sessionId,
    service_name: log.serviceName,
    action: log.action,
    timestamp: log.timestamp.toISOString(),
    ip_address: log.ipAddress,
    success: log.success,
    error_message: log.errorMessage,
  };
}
