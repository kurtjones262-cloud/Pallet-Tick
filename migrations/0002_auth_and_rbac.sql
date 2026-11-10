-- PalletTrack Centralised Database Schema Migration 0002: Multi-User Authentication & RBAC

-- 1. Extend Users table with employee code, pin salt, and lockout security
ALTER TABLE users ADD COLUMN employee_code TEXT;
ALTER TABLE users ADD COLUMN pin_salt TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- 2. Extend Scan Events table for employee accountability audit trail
ALTER TABLE scan_events ADD COLUMN employee_name TEXT;
ALTER TABLE scan_events ADD COLUMN employee_role TEXT;
ALTER TABLE scan_events ADD COLUMN event_action TEXT DEFAULT 'part_scan';

-- 3. Sessions Table for secure hashed token sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT
);

-- 4. Unique & performance indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id);
