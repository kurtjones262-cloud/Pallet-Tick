-- PalletTrack Phase 5: Real-Time Multi-User Synchronisation & Concurrent Scanning
-- Adds optimistic concurrency version counters, last scanner attribution,
-- idempotency keys on scan_events, and ordered realtime_events event log.

ALTER TABLE deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE delivery_parts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_id TEXT;
ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_name TEXT;

ALTER TABLE scan_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE scan_events ADD COLUMN sequence_number INTEGER;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency
  ON scan_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_realtime_events_seq
  ON realtime_events(seq ASC);

CREATE INDEX IF NOT EXISTS idx_realtime_events_delivery_seq
  ON realtime_events(delivery_id, seq ASC);
