-- Migration 0006: Docket Separation Review Flags & Docket Groups
-- Adds manual separation review tracking on deliveries and manually created docket groups

PRAGMA foreign_keys = ON;

ALTER TABLE deliveries ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN review_reason TEXT;

CREATE TABLE IF NOT EXISTS docket_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docket_group_items (
  group_id TEXT NOT NULL REFERENCES docket_groups(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_docket_groups_created_at ON docket_groups(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_docket_group_items_delivery ON docket_group_items(delivery_id);
CREATE INDEX IF NOT EXISTS idx_docket_group_items_group ON docket_group_items(group_id);
