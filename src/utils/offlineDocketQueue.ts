import { SupplierRuleId } from '../types/delivery';
import {
  PendingDocketUpload,
  PendingDocketUploadPage,
  PendingDocketUploadStatus,
  deletePendingDocketUpload,
  getAllPendingDocketUploads,
  getPendingDocketUpload,
  savePendingDocketUpload,
} from './indexedDb';
import {
  OfflineDocketExtractionOutput,
  OcrProgressUpdate,
  SmartDocketExtractionOptions,
  executeGeminiDocketExtraction,
} from './offlineOcr';

export type {
  PendingDocketUpload,
  PendingDocketUploadPage,
  PendingDocketUploadStatus,
};

export const PENDING_DOCKET_QUEUE_UPDATED_EVENT = 'parttrack_pending_docket_queue_updated';

export interface PendingQueueStoreAdapter {
  save: (record: PendingDocketUpload) => Promise<void>;
  get: (id: string) => Promise<PendingDocketUpload | undefined>;
  getAll: () => Promise<PendingDocketUpload[]>;
  remove: (id: string) => Promise<void>;
}

const defaultIndexedDbStore: PendingQueueStoreAdapter = {
  save: savePendingDocketUpload,
  get: getPendingDocketUpload,
  getAll: getAllPendingDocketUploads,
  remove: deletePendingDocketUpload,
};

let activeQueuePromise: Promise<PendingDocketQueueRunSummary> | null = null;

export interface PendingDocketQueueRunSummary {
  processedCount: number;
  readyForReviewCount: number;
  failedCount: number;
  skippedOffline: boolean;
}

function emitQueueUpdatedEvent(detail?: Record<string, unknown>): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(PENDING_DOCKET_QUEUE_UPDATED_EVENT, {
        detail: detail || {},
      })
    );
  }
}

export function computePendingUploadDedupeKey(
  pages: Array<{ name: string; dataUrl: string; fileSize?: number }>,
  supplierHint: SupplierRuleId
): string {
  const pageTokens = (pages || []).map((p) => {
    const raw = p.dataUrl || '';
    const head = raw.slice(0, 64);
    const tail = raw.length > 64 ? raw.slice(-48) : '';
    return `${p.name || 'page'}::${p.fileSize || raw.length}::${raw.length}::${head}::${tail}`;
  });
  return `${supplierHint}::${pageTokens.join('|')}`;
}

export async function enqueuePendingDocketUpload(
  input: {
    supplierHint: SupplierRuleId;
    pages: PendingDocketUploadPage[];
  },
  store: PendingQueueStoreAdapter = defaultIndexedDbStore
): Promise<{ record: PendingDocketUpload; deduplicated: boolean }> {
  const pages = (input.pages || []).filter((p) => Boolean(p && p.dataUrl));
  if (pages.length === 0) {
    throw new Error('Cannot queue an offline docket upload without any docket images.');
  }

  const dedupeKey = computePendingUploadDedupeKey(pages, input.supplierHint);
  const existingAll = await store.getAll();
  const duplicate = existingAll.find((item) => item.dedupeKey === dedupeKey);
  if (duplicate) {
    emitQueueUpdatedEvent({ action: 'deduplicated', id: duplicate.id });
    return { record: duplicate, deduplicated: true };
  }

  const nowIso = new Date().toISOString();
  const record: PendingDocketUpload = {
    id: `pdq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    dedupeKey,
    supplierHint: input.supplierHint,
    pages,
    status: 'awaiting_processing',
    createdAt: nowIso,
    updatedAt: nowIso,
    retryCount: 0,
  };

  await store.save(record);
  emitQueueUpdatedEvent({ action: 'enqueued', id: record.id });
  return { record, deduplicated: false };
}

export async function listPendingDocketUploads(
  store: PendingQueueStoreAdapter = defaultIndexedDbStore
): Promise<PendingDocketUpload[]> {
  return store.getAll();
}

export async function removePendingDocketUpload(
  id: string,
  store: PendingQueueStoreAdapter = defaultIndexedDbStore
): Promise<void> {
  await store.remove(id);
  emitQueueUpdatedEvent({ action: 'removed', id });
}

export async function retryPendingDocketUpload(
  id: string,
  options?: {
    store?: PendingQueueStoreAdapter;
    extractor?: (
      images: Array<string | File>,
      onProgress?: (update: OcrProgressUpdate) => void,
      pageTextHints?: Array<{ rawText?: string; hasSelectableText?: boolean }>,
      fallbackReason?: string,
      extractionOptions?: SmartDocketExtractionOptions
    ) => Promise<OfflineDocketExtractionOutput>;
    extractionOptions?: SmartDocketExtractionOptions;
    onProgress?: (id: string, update: OcrProgressUpdate) => void;
  }
): Promise<PendingDocketQueueRunSummary> {
  const store = options?.store || defaultIndexedDbStore;
  const existing = await store.get(id);
  if (existing) {
    await store.save({
      ...existing,
      status: 'awaiting_processing',
      errorMessage: undefined,
      updatedAt: new Date().toISOString(),
    });
    emitQueueUpdatedEvent({ action: 'requeued', id });
  }
  return processPendingDocketUploads(options);
}

/**
 * Automatically processes queued offline docket uploads with Gemini 4 Hydrogen once connectivity returns.
 * - Single-flight lock prevents duplicate concurrent runs across reconnect handlers.
 * - Keeps `awaiting_manual_review` items in IndexedDB until the operator explicitly confirms & saves them.
 */
export async function processPendingDocketUploads(options?: {
  store?: PendingQueueStoreAdapter;
  extractor?: (
    images: Array<string | File>,
    onProgress?: (update: OcrProgressUpdate) => void,
    pageTextHints?: Array<{ rawText?: string; hasSelectableText?: boolean }>,
    fallbackReason?: string,
    extractionOptions?: SmartDocketExtractionOptions
  ) => Promise<OfflineDocketExtractionOutput>;
  extractionOptions?: SmartDocketExtractionOptions;
  onProgress?: (id: string, update: OcrProgressUpdate) => void;
}): Promise<PendingDocketQueueRunSummary> {
  if (activeQueuePromise) {
    return activeQueuePromise;
  }

  const store = options?.store || defaultIndexedDbStore;
  const extractor = options?.extractor || executeGeminiDocketExtraction;

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!isOnline && !options?.extractionOptions?.fetchImpl && !options?.extractor) {
    return {
      processedCount: 0,
      readyForReviewCount: 0,
      failedCount: 0,
      skippedOffline: true,
    };
  }

  activeQueuePromise = (async (): Promise<PendingDocketQueueRunSummary> => {
    let processedCount = 0;
    let readyForReviewCount = 0;
    let failedCount = 0;

    const allItems = await store.getAll();
    // Recover any record left mid-flight by an interrupted browser session before processing
    for (const item of allItems) {
      if (item.status === 'processing' || item.status === 'recovering_rows') {
        item.status = 'awaiting_processing';
        item.updatedAt = new Date().toISOString();
        await store.save(item);
      }
    }

    const queue = allItems
      .filter((item) => item.status === 'awaiting_processing')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const record of queue) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false && !options?.extractor) {
        break;
      }

      processedCount++;
      let working: PendingDocketUpload = {
        ...record,
        status: 'processing',
        errorMessage: undefined,
        updatedAt: new Date().toISOString(),
      };
      await store.save(working);
      emitQueueUpdatedEvent({ action: 'processing', id: working.id });

      try {
        const result = await extractor(
          working.pages.map((p) => p.dataUrl),
          (prog) => {
            options?.onProgress?.(working.id, prog);
            if (
              prog.stage === 'parsing' &&
              /recovering/i.test(prog.statusText || '') &&
              working.status !== 'recovering_rows'
            ) {
              working = {
                ...working,
                status: 'recovering_rows',
                updatedAt: new Date().toISOString(),
              };
              store.save(working).then(() => {
                emitQueueUpdatedEvent({ action: 'recovering_rows', id: working.id });
              }).catch(() => {});
            }
          },
          working.pages.map((p) => ({
            rawText: p.textHint?.rawText,
            hasSelectableText: p.textHint?.hasSelectableText,
          })),
          undefined,
          {
            ...options?.extractionOptions,
            supplierHint: working.supplierHint,
            sourceFileIds: working.pages.map((p) => p.sourceFileId),
          }
        );

        working = {
          ...working,
          status: 'awaiting_manual_review',
          extractedData: result.extractedData,
          processedPages: result.processedPages.map((p) => ({
            pageNumber: p.pageNumber,
            originalDataUrl: p.originalDataUrl,
            preprocessedDataUrl: p.preprocessedDataUrl,
            width: p.width,
            height: p.height,
          })),
          errorMessage: undefined,
          updatedAt: new Date().toISOString(),
        };
        await store.save(working);
        readyForReviewCount++;
        emitQueueUpdatedEvent({ action: 'ready_for_review', id: working.id });
      } catch (err: any) {
        const msg = err?.message || String(err || 'Gemini extraction failed.');
        working = {
          ...working,
          status: 'failed',
          retryCount: (working.retryCount || 0) + 1,
          errorMessage: msg,
          updatedAt: new Date().toISOString(),
        };
        await store.save(working);
        failedCount++;
        emitQueueUpdatedEvent({ action: 'failed', id: working.id });
      }
    }

    return {
      processedCount,
      readyForReviewCount,
      failedCount,
      skippedOffline: false,
    };
  })().finally(() => {
    activeQueuePromise = null;
  });

  return activeQueuePromise;
}
