import { openDB, IDBPDatabase } from 'idb';
import { Delivery, DocketAttachment } from '../types/delivery';

const DB_NAME = 'parttrack_offline_db';
const DB_VERSION = 1;

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
 * Clears all data from IndexedDB (for fresh app reset)
 */
export async function clearAllIndexedDb(): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(['deliveries', 'docket_images'], 'readwrite');
    await tx.objectStore('deliveries').clear();
    await tx.objectStore('docket_images').clear();
    await tx.done;
  } catch (error) {
    console.error('Failed to clear IndexedDB:', error);
  }
}
