/**
 * PalletTick - Domain Data Models
 * Laser-cut steel parts receiving, docket extraction, continuous barcode/QR scanning
 */

export type ScanMethod = 'qr' | 'barcode' | 'ocr_label' | 'manual';

export type SupplierRuleId = 'laser_central' | 'gci' | 'ocr_label';

export interface SupplierRuleDefinition {
  id: SupplierRuleId;
  name: string;
  codeType: 'barcode' | 'qr' | 'ocr_label';
  ruleBadge: string;
  ruleSummary: string;
  scanPrompt: string;
}

export type PartStatus = 'outstanding' | 'received';

export type ScanStatusType =
  | 'match_success'
  | 'quantity_mismatch'
  | 'duplicate_warning'
  | 'unexpected_warning'
  | 'manual_ticked'
  | 'undo_performed'
  | 'part_added'
  | 'part_edited'
  | 'part_deleted';

export interface OriginalOcrPartSnapshot {
  partNumber: string;
  itemNumber?: string;
  description: string;
  revision?: string;
  quantity: number;
  material?: string;
  thickness?: string;
  capturedAt?: string;
}

export interface PartEditAuditEntry {
  id?: string;
  action: 'added' | 'edited' | 'deleted';
  partId?: string;
  partNumber?: string;
  editedBy: string;
  editedByRole?: string;
  timestamp: string;
  summary: string;
  previousValues?: Record<string, any>;
  newValues?: Record<string, any>;
}

export interface DeliveryPart {
  id: string; // Unique per physical piece / trackable unit
  docketLineIndex: number;
  partNumber: string; // Matched by QR Code (GCI) or OCR Label Scanner
  itemNumber: string; // Matched by Barcode ######-No (Laser Central)
  description: string;
  revision?: string; // Drawing / engineering revision (e.g. Rev A, 01)
  material?: string;
  thickness?: string;
  dimensions?: string;
  weight?: string;
  quantity?: number; // Required quantity from docket
  receivedQuantity?: number; // Actual cumulative quantity received/confirmed during scan
  verificationStatus?: 'verified' | 'quantity_mismatch' | 'unscanned';
  palletNumber?: string | number; // e.g. "Pallet 1 of 6"
  status: PartStatus;
  scannedAt?: string; // ISO string
  scannedVia?: ScanMethod;
  scannedCode?: string;
  notes?: string;
  flaggedForReview?: boolean;
  ocrConfidence?: 'high' | 'medium' | 'low';
  manuallyEdited?: boolean;
  lastEditedBy?: string;
  lastEditedAt?: string;
  originalOcrValues?: OriginalOcrPartSnapshot;
  editHistory?: PartEditAuditEntry[];
}

export interface PendingQuantityConfirmation {
  part: DeliveryPart;
  code: string;
  detectedType: ScanMethod;
  matchedMode: 'exact-part' | 'docket-no' | 'exact-item';
}

export interface UnexpectedPart {
  id: string;
  code: string;
  codeType: ScanMethod;
  scannedAt: string;
  notes?: string;
  resolved?: boolean;
  recognizedDescription?: string;
  recognizedQuantity?: number;
  rawOcrText?: string;
}

export interface ScanEvent {
  id: string;
  timestamp: string;
  code: string;
  codeType: ScanMethod;
  status: ScanStatusType;
  partId?: string;
  partNumber?: string;
  itemNumber?: string;
  recognizedDescription?: string;
  requiredQuantity?: number;
  receivedQuantity?: number; // Total cumulative received quantity after this scan
  addedQuantity?: number; // Quantity added by this specific pallet label scan
  previousReceivedQuantity?: number; // Quantity before this scan (for accurate undo)
  previousStatus?: PartStatus; // Part status before this scan (for accurate undo)
  rawOcrText?: string; // Raw OCR text captured from the pallet label for troubleshooting
  employeeName?: string;
  employeeRole?: string;
  eventAction?: string;
  message: string;
}

export interface DocketAttachment {
  id: string;
  name: string;
  uploadedAt: string;
  dataUrl?: string; // Base64 thumbnail/image
  size?: number;
}

export interface Delivery {
  id: string;
  docketNumber: string;
  supplier: string;
  supplierProfile?: SupplierRuleId;
  deliveryDate: string; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  carrier?: string;
  orderNumber?: string;
  palletCount?: number;
  notes?: string;
  status: 'receiving' | 'completed';
  docketAttachments: DocketAttachment[];
  parts: DeliveryPart[];
  unexpectedParts: UnexpectedPart[];
  scanHistory: ScanEvent[];
}

export interface ScanFeedback {
  type: 'success' | 'quantity_mismatch' | 'duplicate' | 'unexpected' | 'undo';
  code: string;
  matchedPart?: DeliveryPart;
  message: string;
  timestamp: number;
}

export interface ChecklistFilterOptions {
  searchQuery: string;
  status: 'all' | 'outstanding' | 'received' | 'flagged';
  pallet: string | 'all';
  sortBy: 'line' | 'partNumber' | 'itemNumber' | 'pallet' | 'scannedAt';
  sortOrder: 'asc' | 'desc';
}

export interface AppSettings {
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  speechEnabled: boolean;
  autoTorch: boolean;
  preferredCamera: 'environment' | 'user';
  autoExpandQuantities: boolean;
  darkHighContrast: boolean;
}

export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'employee' | 'operator';

export interface UserAccount {
  id: string;
  employeeName: string;
  employeeCode: string;
  role: UserRole;
  active: boolean;
  failedLoginAttempts?: number;
  lockedUntil?: string | null;
  lastLoginAt?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  totalScans?: number;
  lastScanAt?: string | null;
}

