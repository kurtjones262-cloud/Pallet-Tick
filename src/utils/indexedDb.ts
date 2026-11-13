import { openDB, IDBPDatabase } from 'idb';
import { Delivery, SupplierRuleId } from '../types/delivery';
import type { ExtractedDocketResult } from '../server/docketOcr';

const DB_NAME = 'parttrack_offline_db';
const DB_VERSION = 2;

export interface StoredDocketImage {
  id: string;
  deliveryId: string;
  pageNumber: number;
  dataUrl: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

export type PendingDocketUploadStatus =
  | 'awaiting_processing'
  | 'processing'
  | 'recovering_rows'
  | 'awaiting_manual_review'
  | 'failed';

export interface PendingDocketUploadPage {
  id: string;
  sourceFileId: string;
  dataUrl: string;
  name: string;
  sourceType: 'photo' | 'pdf';
  fileSize?: number;
  fileFormat?: string;
  textHint?: {
    rawText?: string;
    hasSelectableText?: boolean;
  };
}

export interface PendingDocketUpload {
  id: string;
  dedupeKey: string;
  supplierHint: SupplierRuleId;
  pages: PendingDocketUploadPage[];
  status: PendingDocketUploadStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  errorMessage?: string;
  extractedData?: ExtractedDocketResult;
  processedPages?: Array<{
    pageNumber: number;
    originalDataUrl: string;
    preprocessedDataUrl: string;
    width: number;
    height: number;
  }>;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Deliveries store
        if (!db.objectStoreNames.contains('deliveries')) {
          db.createObjectStore('deliveries', { keyPath: 'id' });
        }

        // Docket high-resolution photos store
        if (!db.objectStoreNames.contains('docket_images')) {
          const imageStore = db.createObjectStore('docket_images', { keyPath: 'id' });
          imageStore.createIndex('by_delivery', 'deliveryId');
          imageStore.createIndex('by_delivery_page', ['deliveryId', 'pageNumber']);
        }

        // Offline pending docket uploads queued for Gemini 4 Hydrogen OCR upon reconnect
        if (!db.objectStoreNames.contains('pending_docket_uploads')) {
          const queueStore = db.createObjectStore('pending_docket_uploads', { keyPath: 'id' });
          queueStore.createIndex('by_status', 'status');
          queueStore.createIndex('by_dedupeKey', 'dedupeKey');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Saves a delivery record to IndexedDB
 */
export async function saveDeliveryToIndexedDb(delivery: Delivery): Promise<void> {
  try {
    const db = await getDb();
    await db.put('deliveries', delivery);
  } catch (error) {
    console.error('Failed to save delivery to IndexedDB:', error);
  }
}

/**
 * Retrieves a single delivery by ID from IndexedDB
 */
export async function getDeliveryFromIndexedDb(id: string): Promise<Delivery | undefined> {
  try {
    const db = await getDb();
    return await db.get('deliveries', id);
  } catch (error) {
    console.error('Failed to get delivery from IndexedDB:', error);
    return undefined;
  }
}

/**
 * Retrieves all stored deliveries from IndexedDB
 */
export async function getAllDeliveriesFromIndexedDb(): Promise<Delivery[]> {
  try {
    const db = await getDb();
    return await db.getAll('deliveries');
  } catch (error) {
    console.error('Failed to load deliveries from IndexedDB:', error);
    return [];
  }
}

/**
 * Deletes a delivery and all its attached docket images from IndexedDB
 */
export async function deleteDeliveryFromIndexedDb(id: string): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(['deliveries', 'docket_images'], 'readwrite');
    await tx.objectStore('deliveries').delete(id);

    // Delete associated images
    const imageIndex = tx.objectStore('docket_images').index('by_delivery');
    let cursor = await imageIndex.openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
  } catch (error) {
    console.error('Failed to delete delivery from IndexedDB:', error);
  }
}

/**
 * Stores a full-resolution docket page photo in IndexedDB
 */
export async function saveDocketImageToIndexedDb(image: StoredDocketImage): Promise<void> {
  try {
    const db = await getDb();
    await db.put('docket_images', image);
  } catch (error) {
    console.error('Failed to save docket image to IndexedDB:', error);
  }
}

/**
 * Retrieves all docket page photos for a specific delivery
 */
export async function getDocketImagesForDelivery(deliveryId: string): Promise<StoredDocketImage[]> {
  try {
    const db = await getDb();
    const index = db.transaction('docket_images').store.index('by_delivery');
    const images = await index.getAll(deliveryId);
    return images.sort((a, b) => a.pageNumber - b.pageNumber);
  } catch (error) {
    console.error('Failed to retrieve docket images from IndexedDB:', error);
    return [];
  }
}

/**
 * Saves or updates a queued offline docket upload record in IndexedDB
 */
export async function savePendingDocketUpload(record: PendingDocketUpload): Promise<void> {
  const db = await getDb();
  await db.put('pending_docket_uploads', record);
}

/**
 * Retrieves a single queued offline docket upload by ID
 */
export async function getPendingDocketUpload(
  id: string
): Promise<PendingDocketUpload | undefined> {
  const db = await getDb();
  return await db.get('pending_docket_uploads', id);
}

/**
 * Retrieves all queued offline docket uploads sorted newest-first
 */
export async function getAllPendingDocketUploads(): Promise<PendingDocketUpload[]> {
  try {
    const db = await getDb();
    const all = (await db.getAll('pending_docket_uploads')) as PendingDocketUpload[];
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    console.error('Failed to load pending docket uploads from IndexedDB:', error);
    return [];
  }
}

/**
 * Deletes a queued offline docket upload from IndexedDB after operator review confirmation or cancellation
 */
export async function deletePendingDocketUpload(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('pending_docket_uploads', id);
}

/**
 * Clears all data from IndexedDB (for fresh app reset)
 */
export async function clearAllIndexedDb(): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(
      ['deliveries', 'docket_images', 'pending_docket_uploads'],
      'readwrite'
    );
    await tx.objectStore('deliveries').clear();
    await tx.objectStore('docket_images').clear();
    if (db.objectStoreNames.contains('pending_docket_uploads')) {
      await tx.objectStore('pending_docket_uploads').clear();
    }
    await tx.done;
  } catch (error) {
    console.error('Failed to clear IndexedDB:', error);
  }
}
