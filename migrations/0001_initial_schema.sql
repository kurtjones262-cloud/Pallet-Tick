-- PalletTrack Centralised Database Schema Migration 0001
-- Cloudflare D1 (SQLite) Relational Foundation

PRAGMA foreign_keys = ON;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  employee_name TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL DEFAULT 'receiver',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Deliveries Table
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
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Delivery Parts Table
CREATE TABLE IF NOT EXISTS delivery_parts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  item_number TEXT NOT NULL,
  docket_line_index INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
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
  notes TEXT,
  flagged_for_review INTEGER NOT NULL DEFAULT 0 CHECK (flagged_for_review IN (0, 1)),
  ocr_confidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Scan Events Table
CREATE TABLE IF NOT EXISTS scan_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  part_id TEXT REFERENCES delivery_parts(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  timestamp TEXT NOT NULL,
  code TEXT NOT NULL,
  scan_type TEXT NOT NULL CHECK (scan_type IN ('qr', 'barcode', 'ocr_label', 'manual')),
  scan_status TEXT NOT NULL,
  quantity_added INTEGER NOT NULL DEFAULT 0,
  received_quantity_after INTEGER,
  scan_result TEXT,
  raw_ocr_text TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 5. M1 Synchronisation Table
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

-- Indexes for performance and high-frequency scan queries
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_deliveries_docket ON deliveries(docket_number);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(delivery_status);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_delivery ON delivery_parts(delivery_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_number ON delivery_parts(part_number);
CREATE INDEX IF NOT EXISTS idx_parts_item_number ON delivery_parts(item_number);
CREATE INDEX IF NOT EXISTS idx_parts_status ON delivery_parts(delivery_id, status);
CREATE INDEX IF NOT EXISTS idx_scans_delivery ON scan_events(delivery_id);
CREATE INDEX IF NOT EXISTS idx_scans_part ON scan_events(part_id);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scan_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_m1_delivery ON m1_synchronisations(delivery_id);

-- Seed initial default receiver for Phase 1 (before Phase 2 auth)
INSERT OR IGNORE INTO users (id, employee_name, pin_hash, role, active, created_at, updated_at)
VALUES ('usr_receiver_default', 'Warehouse Receiver 1', NULL, 'receiver', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
