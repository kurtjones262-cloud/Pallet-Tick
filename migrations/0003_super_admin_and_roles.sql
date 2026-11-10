-- PalletTrack Centralised Database Schema Migration 0003: Super Admin, Multi-Admin & Employee RBAC
-- Non-destructive migration ensuring all 4 roles ('super_admin', 'admin', 'supervisor', 'employee') and audit fields exist.

-- 1. Add created_by audit column to users table
ALTER TABLE users ADD COLUMN created_by TEXT;

-- 2. Normalize any legacy default receiver/operator roles to 'employee' while preserving existing admins and supervisors
UPDATE users SET role = 'employee' WHERE role IN ('receiver', 'operator');
