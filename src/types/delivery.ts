/**
 * PartTrack - Domain Data Models
 * Laser-cut steel parts receiving, docket extraction, continuous barcode/QR scanning
 */

export type ScanMethod = 'qr' | 'barcode' | 'manual';

export type PartStatus = 'outstanding' | 'received';

export type ScanStatusType =
  | 'match_success'
  | 'duplicate_warning'
  | 'unexpected_warning'
  | 'manual_ticked'
  | 'undo_performed';

export interface DeliveryPart {
  id: string; // Unique per physical piece / trackable unit
  docketLineIndex: number;
  partNumber: string; // Matched by QR Code
  itemNumber: string; // Matched by Barcode
  description: string;
  material?: string;
  thickness?: string;
  dimensions?: string;
  weight?: string;
  quantity?: number;
  palletNumber?: string | number; // e.g. "Pallet 1 of 6"
  status: PartStatus;
  scannedAt?: string; // ISO string
  scannedVia?: ScanMethod;
  scannedCode?: string;
  notes?: string;
  flaggedForReview?: boolean;
  ocrConfidence?: 'high' | 'medium' | 'low';
}

export interface UnexpectedPart {
  id: string;
  code: string;
  codeType: ScanMethod;
  scannedAt: string;
  notes?: string;
  resolved?: boolean;
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
  type: 'success' | 'duplicate' | 'unexpected' | 'undo';
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
