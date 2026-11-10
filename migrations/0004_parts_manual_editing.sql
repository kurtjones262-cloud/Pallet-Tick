-- Migration 0004: Manual Parts List Editing, Revision Tracking & OCR Audit History
ALTER TABLE delivery_parts ADD COLUMN revision TEXT;
ALTER TABLE delivery_parts ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_parts ADD COLUMN original_ocr_values TEXT;
ALTER TABLE delivery_parts ADD COLUMN last_edited_by TEXT;
ALTER TABLE delivery_parts ADD COLUMN last_edited_at TEXT;
