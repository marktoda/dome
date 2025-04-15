-- Create telegram_sessions table
CREATE TABLE telegram_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  encrypted_data BLOB NOT NULL,
  iv TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  device_info TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES telegram_users(id)
);

-- Create indexes for faster lookups
CREATE INDEX idx_telegram_sessions_user_id ON telegram_sessions(user_id);
CREATE INDEX idx_telegram_sessions_is_active ON telegram_sessions(is_active);
CREATE INDEX idx_telegram_sessions_expires_at ON telegram_sessions(expires_at);