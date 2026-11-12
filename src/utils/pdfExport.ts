import { jsPDF } from 'jspdf';
import { Delivery } from '../types/delivery';
import { getPartVerificationState, getDeliverySupplierRule } from './storage';
import { PARTTRACK_LOGO_BASE64 } from './logoBase64';
import { BRANDING } from '../config/branding';

export function createDeliveryPdfDoc(delivery: Delivery): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const totalParts = delivery.parts.length;
  const partStates = delivery.parts.map((p) => ({
    part: p,
    ...getPartVerificationState(p),
  }));

  const verifiedGreenCount = partStates.filter((s) => s.state === 'verified').length;
  const mismatchOrangeCount = partStates.filter((s) => s.state === 'quantity_mismatch').length;
  const unscannedRedCount = partStates.filter((s) => s.state === 'unscanned').length;
  const scannedTotalCount = verifiedGreenCount + mismatchOrangeCount;
  const percentage = totalParts > 0 ? Math.round((verifiedGreenCount / totalParts) * 100) : 0;
  const supplierRule = getDeliverySupplierRule(delivery);

  // Background industrial header banner
  doc.setFillColor(18, 22, 30);
  doc.rect(0, 0, 210, 38, 'F');

  // Official PartTrack Logo
  try {
    doc.addImage(PARTTRACK_LOGO_BASE64, 'PNG', 12, 6, 26, 26);
  } catch (err) {
    console.warn('Could not embed PartTrack logo in PDF:', err);
  }

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(BRANDING.appName, 42, 18);

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text(BRANDING.reportSubtitle, 42, 25);

  // Status Badge in Header
  const badgeColor =
    verifiedGreenCount === totalParts && totalParts > 0
      ? [16, 185, 129]
      : mismatchOrangeCount > 0
      ? [249, 115, 22]
      : [245, 158, 11];
  doc.setFillColor(badgeColor[0], badgeColor[1], badgeColor[2]);
  doc.roundedRect(142, 10, 54, 18, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text(
    verifiedGreenCount === totalParts && totalParts > 0
      ? '100% VERIFIED'
      : `${percentage}% VERIFIED`,
    169,
    21,
    { align: 'center' }
  );

  // Metadata block
  let y = 47;
  doc.setFontSize(8.5);
  doc.setTextColor(55, 65, 81);
  doc.setFont('helvetica', 'bold');

  doc.text('DOCKET NUMBER:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.docketNumber, 46, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('SUPPLIER:', 108, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.supplier || supplierRule.name, 138, y);

  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('DATE RECEIVED:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.deliveryDate, 46, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('PALLET COUNT:', 108, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.palletCount ? `${delivery.palletCount} Pallets` : 'N/A', 138, y);

  if (delivery.carrier || delivery.orderNumber) {
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(55, 65, 81);
    doc.text('CARRIER / PO:', 14, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(17, 24, 39);
    doc.text(
      `${delivery.carrier || ''} ${delivery.orderNumber ? `(PO: ${delivery.orderNumber})` : ''}`,
      46,
      y
    );
  }

  // Summary Metrics Box
  y += 6;
  doc.setFillColor(243, 244, 246);
  doc.roundedRect(14, y, 182, 21, 2, 2, 'F');

  const colWidth = 182 / 4;
  const metrics = [
    { label: 'TOTAL PARTS', value: `${totalParts}`, color: [31, 41, 55] },
    { label: 'VERIFIED (GREEN)', value: `${verifiedGreenCount}`, color: [5, 150, 105] },
    { label: 'QTY MISMATCH (ORANGE)', value: `${mismatchOrangeCount}`, color: [234, 88, 12] },
    { label: 'NOT SCANNED (RED)', value: `${unscannedRedCount}`, color: [220, 38, 38] },
  ];

  metrics.forEach((m, i) => {
    const x = 14 + i * colWidth;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(75, 85, 99);
    doc.text(m.label, x + colWidth / 2, y + 7.5, { align: 'center' });

    doc.setFontSize(13.5);
    doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    doc.text(m.value, x + colWidth / 2, y + 17, { align: 'center' });
  });

  y += 28;

  // Colour-Coding Legend
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 24, 39);
  doc.text(
    `ALL PARTS VERIFICATION CHECKLIST (${scannedTotalCount}/${totalParts} Scanned)`,
    14,
    y
  );

  // Legend pills on the right
  const legendY = y - 3.5;
  // Green key
  doc.setFillColor(220, 252, 231);
  doc.setDrawColor(16, 185, 129);
  doc.rect(108, legendY, 3.5, 3.5, 'FD');
  doc.setFontSize(6.5);
  doc.setTextColor(6, 95, 70);
  doc.text('Green: Correct Qty', 113, legendY + 2.8);

  // Orange key
  doc.setFillColor(255, 237, 213);
  doc.setDrawColor(249, 115, 22);
  doc.rect(139, legendY, 3.5, 3.5, 'FD');
  doc.setTextColor(154, 52, 18);
  doc.text('Orange: Qty Mismatch', 144, legendY + 2.8);

  // Red key
  doc.setFillColor(254, 226, 226);
  doc.setDrawColor(239, 68, 68);
  doc.rect(173, legendY, 3.5, 3.5, 'FD');
  doc.setTextColor(153, 27, 27);
  doc.text('Red: Not Scanned', 178, legendY + 2.8);

  y += 4;

  const drawPartsTableHeader = (topY: number) => {
    doc.setFillColor(31, 41, 55);
    doc.rect(14, topY, 182, 7, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('NO.', 16.5, topY + 4.8);
    doc.text('PART NUMBER', 29, topY + 4.8);
    doc.text('DESCRIPTION & MATERIAL SPEC', 66, topY + 4.8);
    doc.text('REQ QTY', 136, topY + 4.8, { align: 'center' });
    doc.text('SCAN QTY', 153, topY + 4.8, { align: 'center' });
    doc.text('STATUS', 165, topY + 4.8);
    return topY + 7;
  };

  y = drawPartsTableHeader(y);

  for (let i = 0; i < partStates.length; i++) {
    if (y > 274) {
      doc.addPage();
      y = 18;
      y = drawPartsTableHeader(y);
    }

    const { part, state, requiredQty, receivedQty } = partStates[i];
    const rowHeight = 6.8;

    // Consistent colour-coded row highlighting:
    // - Green: Verified with correct quantity
    // - Orange: Scanned, but quantity does not match required quantity
    // - Red: Not scanned
    let rowFill: [number, number, number];
    let leftStripeColor: [number, number, number];
    let statusTextColor: [number, number, number];
    let statusLabel: string;

    if (state === 'verified') {
      rowFill = [220, 252, 231]; // Soft readable emerald green (#DCFCE7)
      leftStripeColor = [16, 185, 129]; // Solid green bar (#10B981)
      statusTextColor = [6, 95, 70]; // Deep green text (#065F46)
      statusLabel = 'VERIFIED';
    } else if (state === 'quantity_mismatch') {
      rowFill = [255, 237, 213]; // Soft readable amber/orange (#FFEDD5)
      leftStripeColor = [249, 115, 22]; // Solid orange bar (#F97316)
      statusTextColor = [154, 52, 18]; // Deep orange text (#9A3412)
      statusLabel = `MISMATCH (${receivedQty}/${requiredQty})`;
    } else {
      rowFill = [254, 226, 226]; // Soft readable rose/red (#FEE2E2)
      leftStripeColor = [239, 68, 68]; // Solid red bar (#EF4444)
      statusTextColor = [153, 27, 27]; // Deep red text (#991B1B)
      statusLabel = 'NOT SCANNED';
    }

    // Row background fill
    doc.setFillColor(rowFill[0], rowFill[1], rowFill[2]);
    doc.rect(14, y, 182, rowHeight, 'F');

    // Left colour accent bar
    doc.setFillColor(leftStripeColor[0], leftStripeColor[1], leftStripeColor[2]);
    doc.rect(14, y, 2, rowHeight, 'F');

    // Subtle row bottom divider line
    doc.setDrawColor(209, 213, 219);
    doc.setLineWidth(0.15);
    doc.line(14, y + rowHeight, 196, y + rowHeight);

    const textY = y + 4.6;
    const docketNo = part.itemNumber || String(part.docketLineIndex || i + 1);

    // 1. Docket No.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(17, 24, 39);
    doc.text(String(docketNo), 17.5, textY);

    // 2. Part Number
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(17, 24, 39);
    const partNumDisplay =
      part.partNumber.length > 20 ? part.partNumber.slice(0, 20) + '..' : part.partNumber;
    doc.text(partNumDisplay, 29, textY);

    // 3. Description & Material Spec
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(31, 41, 55);
    const specSuffix = [part.thickness, part.material].filter(Boolean).join(' ');
    const fullDesc = specSuffix ? `${part.description} [${specSuffix}]` : part.description;
    const descDisplay = fullDesc.length > 44 ? fullDesc.slice(0, 44) + '...' : fullDesc;
    doc.text(descDisplay, 66, textY);

    // 4. Required Quantity
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(17, 24, 39);
    doc.text(String(requiredQty), 136, textY, { align: 'center' });

    // 5. Scanned / Confirmed Quantity
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(statusTextColor[0], statusTextColor[1], statusTextColor[2]);
    doc.text(state === 'unscanned' ? '0' : String(receivedQty), 153, textY, {
      align: 'center',
    });

    // 6. Status Label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(statusTextColor[0], statusTextColor[1], statusTextColor[2]);
    doc.text(statusLabel, 165, textY);

    y += rowHeight;
  }

  y += 7;

  // Unexpected Parts if any
  if (delivery.unexpectedParts.length > 0) {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38);
    doc.text(`UNEXPECTED PARTS SCANNED (${delivery.unexpectedParts.length})`, 14, y);
    y += 5.5;

    delivery.unexpectedParts.forEach((unexp, idx) => {
      if (y > 276) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(55, 65, 81);
      doc.text(
        `${idx + 1}. Code: ${unexp.code} [${unexp.codeType.toUpperCase()}] - Scanned: ${new Date(
          unexp.scannedAt
        ).toLocaleTimeString()} - Notes: ${unexp.notes || 'No match on docket'}`,
        16,
        y
      );
      y += 5;
    });
  }

  // Footer on all pages
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${BRANDING.appName} Verification Report • ${BRANDING.tagline} • Docket ${delivery.docketNumber} (${delivery.supplier}) • Generated ${new Date().toLocaleString()} • Page ${p} of ${pageCount}`,
      105,
      290,
      { align: 'center' }
    );
  }

  return doc;
}

export function exportDeliveryPdf(delivery: Delivery): void {
  const doc = createDeliveryPdfDoc(delivery);
  doc.save(
    `${BRANDING.exportFilePrefix}_Report_${delivery.docketNumber}_${new Date().toISOString().slice(0, 10)}.pdf`
  );
}

export function generateDeliveryCsvContent(delivery: Delivery): string {
  const headers = [
    'Docket No.',
    'Part Number (QR)',
    'Item Number (Barcode)',
    'Description',
    'Material',
    'Thickness',
    'Required Qty',
    'Scanned Qty',
    'Verification Status',
    'Colour Code',
    'Pallet Location',
    'Scanned At',
    'Scanned Via',
    'Docket Number',
    'Supplier',
  ];

  const rows = delivery.parts.map((p, idx) => {
    const vState = getPartVerificationState(p);
    return [
      idx + 1,
      `"${p.partNumber.replace(/"/g, '""')}"`,
      `"${p.itemNumber.replace(/"/g, '""')}"`,
      `"${p.description.replace(/"/g, '""')}"`,
      `"${(p.material || '').replace(/"/g, '""')}"`,
      `"${(p.thickness || '').replace(/"/g, '""')}"`,
      vState.requiredQty,
      vState.receivedQty,
      vState.state.toUpperCase(),
      vState.color.toUpperCase(),
      `"${String(p.palletNumber || '').replace(/"/g, '""')}"`,
      p.scannedAt ? new Date(p.scannedAt).toISOString() : '',
      p.scannedVia ? p.scannedVia.toUpperCase() : '',
      `"${delivery.docketNumber.replace(/"/g, '""')}"`,
      `"${delivery.supplier.replace(/"/g, '""')}"`,
    ];
  });

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function generateScanHistoryCsvContent(delivery: Delivery): string {
  const headers = [
    'Event #',
    'Timestamp',
    'Code Scanned',
    'Code Type',
    'Result Status',
    'Matched Part #',
    'Matched Item #',
    'Required Qty',
    'Scanned Qty',
    'Message',
  ];
  const rows = delivery.scanHistory.map((s, idx) => [
    idx + 1,
    new Date(s.timestamp).toISOString(),
    `"${s.code.replace(/"/g, '""')}"`,
    s.codeType.toUpperCase(),
    s.status.toUpperCase(),
    `"${(s.partNumber || '').replace(/"/g, '""')}"`,
    `"${(s.itemNumber || '').replace(/"/g, '""')}"`,
    s.requiredQuantity ?? '',
    s.receivedQuantity ?? '',
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
    `${BRANDING.exportFilePrefix}_Docket_${delivery.docketNumber}_${new Date().toISOString().slice(0, 10)}.csv`
  );
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
