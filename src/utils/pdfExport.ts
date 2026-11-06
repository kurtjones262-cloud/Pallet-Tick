import { jsPDF } from 'jspdf';
import { Delivery } from '../types/delivery';

export function createDeliveryPdfDoc(delivery: Delivery): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const totalParts = delivery.parts.length;
  const receivedParts = delivery.parts.filter((p) => p.status === 'received').length;
  const outstandingParts = totalParts - receivedParts;
  const unexpectedCount = delivery.unexpectedParts.length;
  const percentage = totalParts > 0 ? Math.round((receivedParts / totalParts) * 100) : 0;

  // Background industrial header banner
  doc.setFillColor(18, 22, 30);
  doc.rect(0, 0, 210, 40, 'F');

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text('PartTrack', 14, 18);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text('PARTS RECEIVING & VERIFICATION REPORT', 14, 25);

  // Status Badge in Header
  const badgeColor = percentage === 100 ? [16, 185, 129] : [245, 158, 11];
  doc.setFillColor(badgeColor[0], badgeColor[1], badgeColor[2]);
  doc.roundedRect(145, 10, 50, 18, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(percentage === 100 ? '100% VERIFIED' : `${percentage}% COMPLETE`, 170, 21, { align: 'center' });

  // Metadata block
  let y = 50;
  doc.setFontSize(9);
  doc.setTextColor(55, 65, 81);
  doc.setFont('helvetica', 'bold');

  doc.text('DOCKET NUMBER:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.docketNumber, 48, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('SUPPLIER:', 110, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.supplier, 135, y);

  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('DATE RECEIVED:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.deliveryDate, 48, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('PALLET COUNT:', 110, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.palletCount ? `${delivery.palletCount} Pallets` : 'N/A', 142, y);

  y += 7;
  if (delivery.carrier || delivery.orderNumber) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(55, 65, 81);
    doc.text('CARRIER / PO:', 14, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(17, 24, 39);
    doc.text(`${delivery.carrier || ''} ${delivery.orderNumber ? `(PO: ${delivery.orderNumber})` : ''}`, 48, y);
    y += 7;
  }

  // Summary Metrics Box
  y += 4;
  doc.setFillColor(243, 244, 246);
  doc.roundedRect(14, y, 182, 22, 2, 2, 'F');

  const colWidth = 182 / 4;
  const metrics = [
    { label: 'TOTAL EXPECTED', value: `${totalParts}`, color: [31, 41, 55] },
    { label: 'RECEIVED', value: `${receivedParts}`, color: [16, 185, 129] },
    { label: 'OUTSTANDING', value: `${outstandingParts}`, color: [245, 158, 11] },
    { label: 'UNEXPECTED', value: `${unexpectedCount}`, color: [239, 68, 68] },
  ];

  metrics.forEach((m, i) => {
    const x = 14 + i * colWidth;
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(107, 114, 128);
    doc.text(m.label, x + colWidth / 2, y + 8, { align: 'center' });

    doc.setFontSize(14);
    doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    doc.text(m.value, x + colWidth / 2, y + 18, { align: 'center' });
  });

  y += 32;

  // SECTION: Outstanding / Missing Parts (High Priority)
  const outstandingList = delivery.parts.filter((p) => p.status === 'outstanding');

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 24, 39);
  doc.text(`OUTSTANDING PARTS (${outstandingList.length})`, 14, y);

  y += 5;

  if (outstandingList.length === 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(16, 185, 129);
    doc.text('All parts on this docket have been received and verified. None missing.', 14, y + 4);
    y += 12;
  } else {
    // Table Header
    doc.setFillColor(229, 231, 235);
    doc.rect(14, y, 182, 7, 'F');
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(55, 65, 81);
    doc.text('#', 16, y + 5);
    doc.text('PART NUMBER (QR)', 24, y + 5);
    doc.text('ITEM NUMBER (BARCODE)', 65, y + 5);
    doc.text('DESCRIPTION / SPEC', 115, y + 5);
    doc.text('PALLET', 172, y + 5);

    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(31, 41, 55);

    for (let i = 0; i < outstandingList.length; i++) {
      if (y > 275) {
        doc.addPage();
        y = 20;
      }
      const item = outstandingList[i];
      if (i % 2 === 1) {
        doc.setFillColor(249, 250, 251);
        doc.rect(14, y - 4, 182, 6, 'F');
      }
      doc.text(String(i + 1), 16, y);
      doc.text(item.partNumber, 24, y);
      doc.text(item.itemNumber, 65, y);
      const desc = item.description.length > 38 ? item.description.slice(0, 38) + '...' : item.description;
      doc.text(desc, 115, y);
      doc.text(String(item.palletNumber || '-'), 172, y);
      y += 6;
    }
    y += 8;
  }

  // Unexpected Parts if any
  if (delivery.unexpectedParts.length > 0) {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(239, 68, 68);
    doc.text(`UNEXPECTED PARTS SCANNED (${delivery.unexpectedParts.length})`, 14, y);
    y += 6;

    delivery.unexpectedParts.forEach((unexp, idx) => {
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(55, 65, 81);
      doc.text(
        `${idx + 1}. Code: ${unexp.code} [${unexp.codeType.toUpperCase()}] - Scanned: ${new Date(unexp.scannedAt).toLocaleTimeString()} - Notes: ${unexp.notes || 'No match on docket'}`,
        16,
        y
      );
      y += 5;
    });
    y += 6;
  }

  // Footer on all pages
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(156, 163, 175);
    doc.text(
      `PartTrack Delivery Report • Docket ${delivery.docketNumber} • Generated ${new Date().toLocaleString()} • Page ${p} of ${pageCount}`,
      105,
      290,
      { align: 'center' }
    );
  }

  return doc;
}

export function exportDeliveryPdf(delivery: Delivery): void {
  const doc = createDeliveryPdfDoc(delivery);
  doc.save(`PartTrack_Report_${delivery.docketNumber}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function generateDeliveryCsvContent(delivery: Delivery): string {
  const headers = [
    'Line #',
    'Part Number (QR)',
    'Item Number (Barcode)',
    'Description',
    'Material',
    'Thickness',
    'Pallet Location',
    'Status',
    'Scanned At',
    'Scanned Via',
    'Docket Number',
    'Supplier',
  ];

  const rows = delivery.parts.map((p, idx) => [
    idx + 1,
    `"${p.partNumber.replace(/"/g, '""')}"`,
    `"${p.itemNumber.replace(/"/g, '""')}"`,
    `"${p.description.replace(/"/g, '""')}"`,
    `"${(p.material || '').replace(/"/g, '""')}"`,
    `"${(p.thickness || '').replace(/"/g, '""')}"`,
    `"${String(p.palletNumber || '').replace(/"/g, '""')}"`,
    p.status.toUpperCase(),
    p.scannedAt ? new Date(p.scannedAt).toISOString() : '',
    p.scannedVia ? p.scannedVia.toUpperCase() : '',
    `"${delivery.docketNumber.replace(/"/g, '""')}"`,
    `"${delivery.supplier.replace(/"/g, '""')}"`,
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function generateScanHistoryCsvContent(delivery: Delivery): string {
  const headers = ['Event #', 'Timestamp', 'Code Scanned', 'Code Type', 'Result Status', 'Matched Part #', 'Matched Item #', 'Message'];
  const rows = delivery.scanHistory.map((s, idx) => [
    idx + 1,
    new Date(s.timestamp).toISOString(),
    `"${s.code.replace(/"/g, '""')}"`,
    s.codeType.toUpperCase(),
    s.status.toUpperCase(),
    `"${(s.partNumber || '').replace(/"/g, '""')}"`,
    `"${(s.itemNumber || '').replace(/"/g, '""')}"`,
    `"${(s.message || '').replace(/"/g, '""')}"`,
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function generateUnexpectedPartsCsvContent(delivery: Delivery): string {
  const headers = ['#', 'Scanned At', 'Code', 'Code Type', 'Notes'];
  const rows = delivery.unexpectedParts.map((u, idx) => [
    idx + 1,
    new Date(u.scannedAt).toISOString(),
    `"${u.code.replace(/"/g, '""')}"`,
    u.codeType.toUpperCase(),
    `"${(u.notes || '').replace(/"/g, '""')}"`,
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function exportDeliveryCsv(delivery: Delivery): void {
  const csvContent = generateDeliveryCsvContent(delivery);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute(
    'download',
    `PartTrack_Docket_${delivery.docketNumber}_${new Date().toISOString().slice(0, 10)}.csv`
  );
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
