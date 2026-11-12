-- PalletTrack Centralised Database Schema
-- Cloudflare D1 (SQLite) Relational Foundation

PRAGMA foreign_keys = ON;

-- 1. Users Table
-- Stores Super Admins, Admins, Supervisors, and Employees
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  employee_name TEXT NOT NULL,
  employee_code TEXT UNIQUE,
  pin_hash TEXT,
  pin_salt TEXT,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('super_admin', 'admin', 'supervisor', 'employee', 'operator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Sessions Table
-- Stores active employee sessions with SHA-256 hashed session tokens
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT
);

-- 3. Deliveries Table
-- Central delivery records, dockets, and receiving status
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  docket_number TEXT NOT NULL,
  supplier TEXT NOT NULL,
  purchase_order_number TEXT,
  delivery_date TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'receiving' CHECK (delivery_status IN ('receiving', 'completed')),
  carrier TEXT,
  pallet_count INTEGER NOT NULL DEFAULT 1 CHECK (pallet_count >= 1),
  supplier_profile TEXT NOT NULL DEFAULT 'laser_central',
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Delivery Parts Table
-- Individual physical pieces / trackable line items on each delivery docket
CREATE TABLE IF NOT EXISTS delivery_parts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  item_number TEXT NOT NULL,
  docket_line_index INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  revision TEXT,
  required_quantity INTEGER NOT NULL DEFAULT 1 CHECK (required_quantity >= 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  verification_status TEXT NOT NULL DEFAULT 'unscanned' CHECK (verification_status IN ('unscanned', 'verified', 'quantity_mismatch')),
  status TEXT NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding', 'received')),
  material TEXT,
  thickness TEXT,
  dimensions TEXT,
  weight TEXT,
  pallet_number TEXT,
  scanned_at TEXT,
  scanned_via TEXT,
  scanned_code TEXT,
  last_scanned_by_id TEXT,
  last_scanned_by_name TEXT,
  notes TEXT,
  flagged_for_review INTEGER NOT NULL DEFAULT 0 CHECK (flagged_for_review IN (0, 1)),
  ocr_confidence TEXT,
  manually_edited INTEGER NOT NULL DEFAULT 0,
  original_ocr_values TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 5. Scan Events Table
-- Complete audit trail for every barcode, QR, OCR, manual tick, or override event
CREATE TABLE IF NOT EXISTS scan_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  part_id TEXT REFERENCES delivery_parts(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  employee_name TEXT,
  employee_role TEXT,
  event_action TEXT NOT NULL DEFAULT 'part_scan',
  timestamp TEXT NOT NULL,
  code TEXT NOT NULL,
  scan_type TEXT NOT NULL CHECK (scan_type IN ('qr', 'barcode', 'ocr_label', 'manual')),
  scan_status TEXT NOT NULL,
  quantity_added INTEGER NOT NULL DEFAULT 0,
  received_quantity_after INTEGER,
  scan_result TEXT,
  raw_ocr_text TEXT,
  idempotency_key TEXT,
  sequence_number INTEGER,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 6. M1 Synchronisation Table
-- Tracks downstream ERP / M1 sync status and receipts for Phase 4
CREATE TABLE IF NOT EXISTS m1_synchronisations (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  m1_receipt_reference TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'submitted', 'success', 'failed')),
  submission_timestamp TEXT,
  response_info TEXT,
  error_info TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 7. Real-Time Events Table
-- Monotonically ordered real-time event log for multi-user synchronisation & catch-up
CREATE TABLE IF NOT EXISTS realtime_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  delivery_id TEXT,
  part_id TEXT,
  user_id TEXT,
  employee_name TEXT,
  employee_role TEXT,
  delivery_version INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Indexes for performance and high-frequency scan queries
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_docket ON deliveries(docket_number);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(delivery_status);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_delivery ON delivery_parts(delivery_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_number ON delivery_parts(part_number);
CREATE INDEX IF NOT EXISTS idx_parts_item_number ON delivery_parts(item_number);
CREATE INDEX IF NOT EXISTS idx_parts_status ON delivery_parts(delivery_id, status);
CREATE INDEX IF NOT EXISTS idx_scans_delivery ON scan_events(delivery_id);
CREATE INDEX IF NOT EXISTS idx_scans_part ON scan_events(part_id);
CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scan_events(timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency ON scan_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_m1_delivery ON m1_synchronisations(delivery_id);
CREATE INDEX IF NOT EXISTS idx_realtime_events_seq ON realtime_events(seq ASC);
CREATE INDEX IF NOT EXISTS idx_realtime_events_delivery_seq ON realtime_events(delivery_id, seq ASC);

