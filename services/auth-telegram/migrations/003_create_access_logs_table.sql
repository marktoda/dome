-- Create telegram_session_access_logs table
CREATE TABLE telegram_session_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  success BOOLEAN,
  error_message TEXT,
  FOREIGN KEY (session_id) REFERENCES telegram_sessions(id)
);

-- Create indexes for faster lookups
CREATE INDEX idx_telegram_session_access_logs_session_id ON telegram_session_access_logs(session_id);
CREATE INDEX idx_telegram_session_access_logs_timestamp ON telegram_session_access_logs(timestamp);
CREATE INDEX idx_telegram_session_access_logs_service_name ON telegram_session_access_logs(service_name);