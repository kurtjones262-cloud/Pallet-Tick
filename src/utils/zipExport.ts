import JSZip from 'jszip';
import { Delivery } from '../types/delivery';
import {
  createDeliveryPdfDoc,
  generateDeliveryCsvContent,
  generateScanHistoryCsvContent,
  generateUnexpectedPartsCsvContent,
} from './pdfExport';
import { getDocketImagesForDelivery } from './indexedDb';
import { getStoredDeliveries } from './storage';

/**
 * Converts a base64 Data URL to a binary Uint8Array for zip packaging.
 */
function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binaryString = atob(base64.replace(/\s/g, ''));
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Initiates an instant in-browser file download for a generated Blob.
 */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Exports a single delivery as a comprehensive .zip archive containing:
 * 1. PDF Verification Report
 * 2. Parts Checklist CSV
 * 3. Scan Activity History CSV
 * 4. Unexpected Parts CSV (if any)
 * 5. Full-resolution photographed docket pages in /docket_photos/
 * 6. Structured manifest.json
 */
export async function exportDeliveryZip(
  delivery: Delivery,
  onProgress?: (status: string) => void
): Promise<void> {
  onProgress?.('Preparing delivery archive...');
  const zip = new JSZip();
  const sanitizedDocket = delivery.docketNumber.replace(/[^a-zA-Z0-9_-]/g, '_') || 'delivery';
  const dateStr = new Date().toISOString().slice(0, 10);

  // 1. Add verification report PDF
  onProgress?.('Generating PDF report...');
  try {
    const pdfDoc = createDeliveryPdfDoc(delivery);
    const pdfArrayBuffer = pdfDoc.output('arraybuffer');
    zip.file(`PartTrack_Report_${sanitizedDocket}.pdf`, pdfArrayBuffer);
  } catch (err) {
    console.error('Failed to bundle PDF in zip:', err);
  }

  // 2. Add CSV files
  onProgress?.('Generating inventory & scan CSV spreadsheets...');
  const partsCsv = generateDeliveryCsvContent(delivery);
  zip.file(`parts_inventory_${sanitizedDocket}.csv`, partsCsv);

  const scanCsv = generateScanHistoryCsvContent(delivery);
  zip.file(`scan_history_${sanitizedDocket}.csv`, scanCsv);

  if (delivery.unexpectedParts && delivery.unexpectedParts.length > 0) {
    const unexpectedCsv = generateUnexpectedPartsCsvContent(delivery);
    zip.file(`unexpected_parts_${sanitizedDocket}.csv`, unexpectedCsv);
  }

  // 3. Add manifest metadata JSON
  const receivedCount = delivery.parts.filter((p) => p.status === 'received').length;
  const totalCount = delivery.parts.length;
  const manifest = {
    app: 'PartTrack',
    version: '1.0',
    exportTimestamp: new Date().toISOString(),
    delivery: {
      id: delivery.id,
      docketNumber: delivery.docketNumber,
      supplier: delivery.supplier,
      deliveryDate: delivery.deliveryDate,
      carrier: delivery.carrier || null,
      palletCount: delivery.palletCount || null,
      orderNumber: delivery.orderNumber || null,
      status: delivery.status,
      metrics: {
        totalParts: totalCount,
        receivedParts: receivedCount,
        outstandingParts: totalCount - receivedCount,
        unexpectedParts: delivery.unexpectedParts.length,
        completionPercentage: totalCount > 0 ? Math.round((receivedCount / totalCount) * 100) : 0,
      },
    },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // 4. Retrieve and add original photographed docket pages
  onProgress?.('Collecting photographed docket images from IndexedDB...');
  let photos: Array<{ pageNumber: number; dataUrl: string; name?: string }> =
    (await getDocketImagesForDelivery(delivery.id)) || [];

  if (photos.length === 0 && delivery.docketAttachments && delivery.docketAttachments.length > 0) {
    // Fallback to attachments stored on delivery
    photos = delivery.docketAttachments
      .map((att, idx) => ({
        pageNumber: idx + 1,
        dataUrl: att.dataUrl || '',
        name: att.name || `page_${idx + 1}.jpg`,
      }))
      .filter((p) => Boolean(p.dataUrl));
  }

  if (photos && photos.length > 0) {
    const photosFolder = zip.folder('docket_photos');
    photos.forEach((photo, idx) => {
      if (photo.dataUrl) {
        try {
          const binary = dataUrlToUint8Array(photo.dataUrl);
          const extension = photo.dataUrl.includes('image/png') ? 'png' : 'jpg';
          photosFolder?.file(`page_${photo.pageNumber || idx + 1}.${extension}`, binary);
        } catch (err) {
          console.warn(`Could not pack docket image page ${idx + 1}:`, err);
        }
      }
    });
  }

  // 5. Compress and trigger browser download
  onProgress?.('Compressing .zip package...');
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const zipFilename = `PartTrack_Docket_${sanitizedDocket}_${dateStr}.zip`;
  triggerDownload(zipBlob, zipFilename);
  onProgress?.('Download complete!');
}

/**
 * Master backup: Exports ALL deliveries, all scan history, and all original docket photos
 * into one master archive.
 */
export async function exportAllDeliveriesBackupZip(
  onProgress?: (status: string) => void
): Promise<void> {
  onProgress?.('Fetching all deliveries...');
  const deliveries = getStoredDeliveries();
  const zip = new JSZip();
  const dateStr = new Date().toISOString().slice(0, 10);

  // 1. Master JSON
  zip.file('all_deliveries_backup.json', JSON.stringify(deliveries, null, 2));

  // 2. Master summary CSV
  const summaryHeaders = [
    'Docket #',
    'Supplier',
    'Delivery Date',
    'Total Parts',
    'Received',
    'Outstanding',
    'Completion %',
    'Status',
    'Pallets',
    'Order #',
  ];
  const summaryRows = deliveries.map((d) => {
    const total = d.parts.length;
    const rec = d.parts.filter((p) => p.status === 'received').length;
    const pct = total > 0 ? Math.round((rec / total) * 100) : 0;
    return [
      `"${d.docketNumber.replace(/"/g, '""')}"`,
      `"${d.supplier.replace(/"/g, '""')}"`,
      d.deliveryDate,
      total,
      rec,
      total - rec,
      `${pct}%`,
      d.status.toUpperCase(),
      d.palletCount || '',
      `"${(d.orderNumber || '').replace(/"/g, '""')}"`,
    ];
  });
  zip.file(
    'all_deliveries_summary.csv',
    [summaryHeaders.join(','), ...summaryRows.map((r) => r.join(','))].join('\r\n')
  );

  // 3. Subfolders for each delivery
  for (let i = 0; i < deliveries.length; i++) {
    const del = deliveries[i];
    onProgress?.(`Archiving delivery ${i + 1} of ${deliveries.length} (${del.docketNumber})...`);
    const sanitizedDocket = del.docketNumber.replace(/[^a-zA-Z0-9_-]/g, '_') || `delivery_${i + 1}`;
    const folder = zip.folder(`deliveries/${sanitizedDocket}`);

    // Add PDF
    try {
      const pdfDoc = createDeliveryPdfDoc(del);
      folder?.file(`report_${sanitizedDocket}.pdf`, pdfDoc.output('arraybuffer'));
    } catch {
      // Continue if single pdf fails
    }

    // Add Parts CSV
    folder?.file(`parts_${sanitizedDocket}.csv`, generateDeliveryCsvContent(del));

    // Add Docket Photos
    const photos = await getDocketImagesForDelivery(del.id);
    if (photos && photos.length > 0) {
      const pFolder = folder?.folder('photos');
      photos.forEach((ph, pIdx) => {
        if (ph.dataUrl) {
          try {
            const bytes = dataUrlToUint8Array(ph.dataUrl);
            const ext = ph.dataUrl.includes('image/png') ? 'png' : 'jpg';
            pFolder?.file(`page_${ph.pageNumber || pIdx + 1}.${ext}`, bytes);
          } catch {
            // Ignore corrupted images
          }
        }
      });
    }
  }

  onProgress?.('Compressing master backup archive...');
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  triggerDownload(zipBlob, `PartTrack_Master_Backup_${dateStr}.zip`);
  onProgress?.('Master backup downloaded successfully!');
}
