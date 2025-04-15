-- Create telegram_users table
CREATE TABLE telegram_users (
  id INTEGER PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  telegram_id BIGINT,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  access_level INTEGER DEFAULT 1,
  is_blocked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on phone_number for faster lookups
CREATE INDEX idx_telegram_users_phone_number ON telegram_users(phone_number);