/**
 * D1 Database types and relational row interfaces for PalletTrack Phase 1.
 */

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1Response {
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Response>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'employee' | 'operator';

export interface UserRow {
  id: string;
  employee_name: string;
  employee_code: string;
  pin_hash: string | null;
  pin_salt: string | null;
  role: UserRole;
  active: number;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_activity_at: string;
  user_agent: string | null;
  ip_address: string | null;
}


export interface DeliveryRow {
  id: string;
  docket_number: string;
  supplier: string;
  purchase_order_number: string | null;
  delivery_date: string;
  delivery_status: 'receiving' | 'completed';
  carrier: string | null;
  pallet_count: number;
  supplier_profile: string;
  notes: string | null;
  version?: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryPartRow {
  id: string;
  delivery_id: string;
  part_number: string;
  item_number: string;
  docket_line_index: number;
  description: string;
  revision?: string | null;
  required_quantity: number;
  received_quantity: number;
  verification_status: 'unscanned' | 'verified' | 'quantity_mismatch';
  status: 'outstanding' | 'received';
  material: string | null;
  thickness: string | null;
  dimensions: string | null;
  weight: string | null;
  pallet_number: string | null;
  scanned_at: string | null;
  scanned_via: string | null;
  scanned_code: string | null;
  last_scanned_by_id?: string | null;
  last_scanned_by_name?: string | null;
  notes: string | null;
  flagged_for_review: number;
  ocr_confidence: string | null;
  manually_edited?: number | null;
  original_ocr_values?: string | null;
  last_edited_by?: string | null;
  last_edited_at?: string | null;
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface ScanEventRow {
  id: string;
  delivery_id: string;
  part_id: string | null;
  user_id: string | null;
  timestamp: string;
  code: string;
  scan_type: 'qr' | 'barcode' | 'ocr_label' | 'manual';
  scan_status: string;
  quantity_added: number;
  received_quantity_after: number | null;
  scan_result: string | null;
  raw_ocr_text: string | null;
  employee_name?: string | null;
  employee_role?: string | null;
  event_action?: string | null;
  idempotency_key?: string | null;
  sequence_number?: number | null;
  created_at?: string;
}


export interface M1SynchronisationRow {
  id: string;
  delivery_id: string;
  m1_receipt_reference: string | null;
  sync_status: 'pending' | 'submitted' | 'success' | 'failed';
  submission_timestamp: string | null;
  response_info: string | null;
  error_info: string | null;
  created_at: string;
  updated_at: string;
}

export interface RealtimeEventRow {
  seq: number;
  id: string;
  event_type: string;
  delivery_id: string | null;
  part_id: string | null;
  user_id: string | null;
  employee_name: string | null;
  employee_role: string | null;
  delivery_version: number | null;
  payload: string;
  created_at: string;
}

