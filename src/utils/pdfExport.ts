import { jsPDF } from 'jspdf';
import { Delivery, DeliveryPart, DocketGroup, ScanEvent } from '../types/delivery';
import { getPartVerificationState, getDeliverySupplierRule } from './storage';
import { PARTTRACK_LOGO_BASE64 } from './logoBase64';
import { BRANDING } from '../config/branding';

export function formatPartScannersSummary(part: DeliveryPart, fallbackHistory?: ScanEvent[]): string {
  if (Array.isArray(part.scannedByUsers) && part.scannedByUsers.length > 0) {
    const names = Array.from(
      new Set(
        part.scannedByUsers
          .map((u) => (u.employeeName || '').trim())
          .filter(Boolean)
      )
    );
    if (names.length > 0) return names.join(', ');
  }
  if (fallbackHistory && fallbackHistory.length > 0) {
    const fromHistory = Array.from(
      new Set(
        fallbackHistory
          .filter(
            (ev) =>
              ev.partId === part.id &&
              ev.status !== 'undo_performed' &&
              ev.status !== 'unexpected_warning' &&
              (ev.employeeName || '').trim()
          )
          .map((ev) => (ev.employeeName || '').trim())
      )
    );
    if (fromHistory.length > 0) return fromHistory.join(', ');
  }
  if (part.lastScannedByName && part.lastScannedByName.trim()) {
    return part.lastScannedByName.trim();
  }
  return '—';
}

function renderBannerHeader(
  doc: jsPDF,
  titleText: string,
  subtitleText: string,
  badgeText: string,
  badgeColor: [number, number, number]
): void {
  doc.setFillColor(18, 22, 30);
  doc.rect(0, 0, 210, 38, 'F');

  try {
    doc.addImage(PARTTRACK_LOGO_BASE64, 'PNG', 12, 6, 26, 26);
  } catch {
    // ignore logo load failure in headless environments
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text(titleText, 42, 18);

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text(subtitleText, 42, 25);

  doc.setFillColor(badgeColor[0], badgeColor[1], badgeColor[2]);
  doc.roundedRect(142, 10, 54, 18, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(badgeText, 169, 21, { align: 'center' });
}

function renderSingleDeliveryContent(
  doc: jsPDF,
  delivery: Delivery,
  options?: { isSectionStartOnCurrentPage?: boolean; sectionIndexLabel?: string }
): void {
  const totalParts = delivery.parts.length;
  const partStates = delivery.parts.map((p) => {
    const v = getPartVerificationState(p);
    const remainingQty = Math.max(0, v.requiredQty - v.receivedQty);
    return {
      part: p,
      ...v,
      remainingQty,
    };
  });

  const verifiedGreenCount = partStates.filter((s) => s.state === 'verified').length;
  const mismatchOrangeCount = partStates.filter((s) => s.state === 'quantity_mismatch').length;
  const unscannedRedCount = partStates.filter((s) => s.state === 'unscanned').length;
  const scannedTotalCount = verifiedGreenCount + mismatchOrangeCount;
  const percentage = totalParts > 0 ? Math.round((verifiedGreenCount / totalParts) * 100) : 0;
  const supplierRule = getDeliverySupplierRule(delivery);

  const badgeColor: [number, number, number] =
    verifiedGreenCount === totalParts && totalParts > 0
      ? [16, 185, 129]
      : mismatchOrangeCount > 0
      ? [249, 115, 22]
      : [245, 158, 11];
  const completionStatusLabel =
    delivery.status === 'completed' || (verifiedGreenCount === totalParts && totalParts > 0)
      ? 'COMPLETED'
      : scannedTotalCount > 0
      ? 'IN PROGRESS'
      : 'INCOMPLETE';

  let y = 47;
  if (!options?.isSectionStartOnCurrentPage) {
    renderBannerHeader(
      doc,
      options?.sectionIndexLabel
        ? `${BRANDING.appName} • ${options.sectionIndexLabel}`
        : BRANDING.appName,
      BRANDING.reportSubtitle,
      verifiedGreenCount === totalParts && totalParts > 0
        ? '100% VERIFIED'
        : `${percentage}% VERIFIED`,
      badgeColor
    );
  } else {
    y = 20;
    doc.setFillColor(18, 22, 30);
    doc.roundedRect(14, y - 6, 182, 12, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(255, 255, 255);
    doc.text(
      `${options.sectionIndexLabel ? `${options.sectionIndexLabel}: ` : ''}DOCKET #${
        delivery.docketNumber
      } — ${delivery.supplier || supplierRule.name}`,
      18,
      y + 1.5
    );
    doc.setFontSize(8.5);
    doc.text(`${completionStatusLabel} (${percentage}%)`, 192, y + 1.5, { align: 'right' });
    y += 12;
  }

  // Metadata block
  doc.setFontSize(8.5);
  doc.setTextColor(55, 65, 81);
  doc.setFont('helvetica', 'bold');
  doc.text('DOCKET NUMBER:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.docketNumber, 46, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('CUSTOMER / SUPPLIER:', 102, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.supplier || supplierRule.name, 144, y);

  y += 5.5;
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('DATE RECEIVED:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(delivery.deliveryDate || '—', 46, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('COMPLETION STATUS:', 102, y);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(badgeColor[0], badgeColor[1], badgeColor[2]);
  doc.text(`${completionStatusLabel} (${verifiedGreenCount}/${totalParts} parts)`, 144, y);

  y += 5.5;
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('PALLETS / PO:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(
    `${delivery.palletCount ? `${delivery.palletCount} Pallets` : 'N/A'}${
      delivery.orderNumber ? ` • PO: ${delivery.orderNumber}` : ''
    }${delivery.carrier ? ` • ${delivery.carrier}` : ''}`,
    46,
    y
  );

  // Summary Metrics Box
  y += 6;
  doc.setFillColor(243, 244, 246);
  doc.roundedRect(14, y, 182, 20, 2, 2, 'F');

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
    doc.text(m.label, x + colWidth / 2, y + 7, { align: 'center' });

    doc.setFontSize(13);
    doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    doc.text(m.value, x + colWidth / 2, y + 16, { align: 'center' });
  });

  y += 26;

  // Section Title + Legend
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 24, 39);
  doc.text(
    `PARTS VERIFICATION & SCAN ATTRIBUTION (${scannedTotalCount}/${totalParts} Scanned)`,
    14,
    y
  );

  const legendY = y - 3.3;
  doc.setFillColor(220, 252, 231);
  doc.setDrawColor(16, 185, 129);
  doc.rect(128, legendY, 3, 3, 'FD');
  doc.setFontSize(6);
  doc.setTextColor(6, 95, 70);
  doc.text('Verified', 132, legendY + 2.4);

  doc.setFillColor(255, 237, 213);
  doc.setDrawColor(249, 115, 22);
  doc.rect(147, legendY, 3, 3, 'FD');
  doc.setTextColor(154, 52, 18);
  doc.text('Mismatch', 151, legendY + 2.4);

  doc.setFillColor(254, 226, 226);
  doc.setDrawColor(239, 68, 68);
  doc.rect(167, legendY, 3, 3, 'FD');
  doc.setTextColor(153, 27, 27);
  doc.text('Unscanned', 171, legendY + 2.4);

  y += 4;

  const drawPartsTableHeader = (topY: number) => {
    doc.setFillColor(31, 41, 55);
    doc.rect(14, topY, 182, 7, 'F');
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('NO.', 16.5, topY + 4.8);
    doc.text('PART #', 25, topY + 4.8);
    doc.text('DESCRIPTION', 56, topY + 4.8);
    doc.text('REQ', 110, topY + 4.8, { align: 'center' });
    doc.text('REC', 120, topY + 4.8, { align: 'center' });
    doc.text('REM', 130, topY + 4.8, { align: 'center' });
    doc.text('STATUS', 137, topY + 4.8);
    doc.text('SCANNED BY / TIME', 158, topY + 4.8);
    return topY + 7;
  };

  y = drawPartsTableHeader(y);

  for (let i = 0; i < partStates.length; i++) {
    if (y > 272) {
      doc.addPage();
      y = 18;
      y = drawPartsTableHeader(y);
    }

    const { part, state, requiredQty, receivedQty, remainingQty } = partStates[i];
    const rowHeight = 7.4;

    let rowFill: [number, number, number];
    let leftStripeColor: [number, number, number];
    let statusTextColor: [number, number, number];
    let statusLabel: string;

    if (state === 'verified') {
      rowFill = [220, 252, 231];
      leftStripeColor = [16, 185, 129];
      statusTextColor = [6, 95, 70];
      statusLabel = 'VERIFIED';
    } else if (state === 'quantity_mismatch') {
      rowFill = [255, 237, 213];
      leftStripeColor = [249, 115, 22];
      statusTextColor = [154, 52, 18];
      statusLabel = `MISMATCH`;
    } else {
      rowFill = [254, 226, 226];
      leftStripeColor = [239, 68, 68];
      statusTextColor = [153, 27, 27];
      statusLabel = 'PENDING';
    }

    doc.setFillColor(rowFill[0], rowFill[1], rowFill[2]);
    doc.rect(14, y, 182, rowHeight, 'F');
    doc.setFillColor(leftStripeColor[0], leftStripeColor[1], leftStripeColor[2]);
    doc.rect(14, y, 2, rowHeight, 'F');
    doc.setDrawColor(209, 213, 219);
    doc.setLineWidth(0.15);
    doc.line(14, y + rowHeight, 196, y + rowHeight);

    const textY = y + 4.8;
    const docketNo = part.itemNumber || String(part.docketLineIndex || i + 1);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(17, 24, 39);
    doc.text(String(docketNo), 17, textY);

    const partNumDisplay =
      part.partNumber.length > 16 ? part.partNumber.slice(0, 16) + '..' : part.partNumber;
    doc.text(partNumDisplay, 25, textY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.4);
    doc.setTextColor(31, 41, 55);
    const specSuffix = [part.thickness, part.material].filter(Boolean).join(' ');
    const fullDesc = specSuffix ? `${part.description} [${specSuffix}]` : part.description;
    const descDisplay = fullDesc.length > 32 ? fullDesc.slice(0, 32) + '...' : fullDesc;
    doc.text(descDisplay, 56, textY);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(17, 24, 39);
    doc.text(String(requiredQty), 110, textY, { align: 'center' });

    doc.setTextColor(statusTextColor[0], statusTextColor[1], statusTextColor[2]);
    doc.text(state === 'unscanned' ? '0' : String(receivedQty), 120, textY, { align: 'center' });

    doc.setTextColor(remainingQty > 0 ? 185 : 6, remainingQty > 0 ? 28 : 95, remainingQty > 0 ? 28 : 70);
    doc.text(String(remainingQty), 130, textY, { align: 'center' });

    doc.setFontSize(6.2);
    doc.setTextColor(statusTextColor[0], statusTextColor[1], statusTextColor[2]);
    doc.text(statusLabel, 137, textY);

    // Scanned by + timestamp attribution
    const scannersLabel = formatPartScannersSummary(part, delivery.scanHistory);
    const timeLabel = part.scannedAt
      ? new Date(part.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    const combinedAttr =
      scannersLabel !== '—' && timeLabel ? `${scannersLabel} (${timeLabel})` : scannersLabel;
    doc.setFont('helvetica', scannersLabel !== '—' ? 'bold' : 'normal');
    doc.setFontSize(6.1);
    doc.setTextColor(31, 41, 55);
    doc.text(
      combinedAttr.length > 27 ? combinedAttr.slice(0, 27) + '..' : combinedAttr,
      158,
      textY
    );

    y += rowHeight;
  }

  // Chronological Scan Attribution Audit Section
  const validScanEvents = (delivery.scanHistory || []).filter(
    (ev) => ev.status !== 'part_added' && ev.status !== 'part_edited' && ev.status !== 'part_deleted'
  );
  if (validScanEvents.length > 0) {
    y += 7;
    if (y > 252) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(17, 24, 39);
    doc.text(`SCANNING ATTRIBUTION HISTORY (${validScanEvents.length} Events)`, 14, y);
    y += 5;

    for (let idx = 0; idx < Math.min(validScanEvents.length, 40); idx++) {
      if (y > 276) {
        doc.addPage();
        y = 20;
      }
      const ev = validScanEvents[idx];
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(55, 65, 81);
      const who = ev.employeeName || 'Workshop Operator';
      const ts = new Date(ev.timestamp).toLocaleString();
      const qtyTxt = ev.addedQuantity
        ? `+${ev.addedQuantity} (Total ${ev.receivedQuantity ?? ev.addedQuantity}/${ev.requiredQuantity ?? '?'})`
        : ev.receivedQuantity !== undefined
        ? `${ev.receivedQuantity}/${ev.requiredQuantity ?? '?'}`
        : '';
      const line = `${idx + 1}. ${ev.partNumber || ev.code} ${qtyTxt ? `[Qty ${qtyTxt}] ` : ''}— Scanned by ${who} via ${(
        ev.codeType || 'SCAN'
      ).toUpperCase()} at ${ts}`;
      doc.text(line.slice(0, 118), 16, y);
      y += 4.5;
    }
  }

  // Unexpected Parts if any
  if (delivery.unexpectedParts.length > 0) {
    y += 5;
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38);
    doc.text(`UNEXPECTED PARTS SCANNED (${delivery.unexpectedParts.length})`, 14, y);
    y += 5;

    delivery.unexpectedParts.forEach((unexp, idx) => {
      if (y > 276) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(55, 65, 81);
      doc.text(
        `${idx + 1}. Code: ${unexp.code} [${unexp.codeType.toUpperCase()}] - Scanned: ${new Date(
          unexp.scannedAt
        ).toLocaleTimeString()} - Notes: ${unexp.notes || 'No match on docket'}`,
        16,
        y
      );
      y += 4.5;
    });
  }
}

export function createDeliveryPdfDoc(delivery: Delivery): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  renderSingleDeliveryContent(doc, delivery);

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${BRANDING.appName} Verification Report • Docket ${delivery.docketNumber} (${delivery.supplier}) • Generated ${new Date().toLocaleString()} • Page ${p} of ${pageCount}`,
      105,
      290,
      { align: 'center' }
    );
  }

  return doc;
}

export function createGroupPdfDoc(group: DocketGroup, memberDeliveries: Delivery[]): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const orderedDeliveries = [...memberDeliveries];
  const totalPartsCount = orderedDeliveries.reduce((acc, d) => acc + d.parts.length, 0);
  const verifiedPartsCount = orderedDeliveries.reduce(
    (acc, d) =>
      acc + d.parts.filter((p) => getPartVerificationState(p).state === 'verified').length,
    0
  );
  const totalReqQty = orderedDeliveries.reduce(
    (acc, d) => acc + d.parts.reduce((s, p) => s + Math.max(1, p.quantity ?? 1), 0),
    0
  );
  const totalRecQty = orderedDeliveries.reduce(
    (acc, d) => acc + d.parts.reduce((s, p) => s + getPartVerificationState(p).receivedQty, 0),
    0
  );
  const totalRemQty = Math.max(0, totalReqQty - totalRecQty);
  const overallPct = totalPartsCount > 0 ? Math.round((verifiedPartsCount / totalPartsCount) * 100) : 0;

  const badgeColor: [number, number, number] =
    overallPct === 100 && totalPartsCount > 0
      ? [16, 185, 129]
      : verifiedPartsCount > 0
      ? [245, 158, 11]
      : [100, 116, 139];

  renderBannerHeader(
    doc,
    `GROUP: ${group.name.slice(0, 28)}`,
    `${BRANDING.appName} Docket Group Report • ${orderedDeliveries.length} Delivery Dockets`,
    `${overallPct}% VERIFIED`,
    badgeColor
  );

  let y = 47;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('DOCKET GROUP:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(group.name, 46, y);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(55, 65, 81);
  doc.text('CREATED BY:', 118, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(17, 24, 39);
  doc.text(group.createdBy || 'Workshop Team', 146, y);

  y += 6.5;
  doc.setFillColor(243, 244, 246);
  doc.roundedRect(14, y, 182, 20, 2, 2, 'F');
  const colW = 182 / 4;
  [
    { label: 'INCLUDED DOCKETS', val: String(orderedDeliveries.length), color: [31, 41, 55] },
    { label: 'VERIFIED PARTS', val: `${verifiedPartsCount}/${totalPartsCount}`, color: [5, 150, 105] },
    { label: 'TOTAL SCANNED QTY', val: `${totalRecQty}/${totalReqQty}`, color: [37, 99, 235] },
    { label: 'REMAINING QTY', val: String(totalRemQty), color: totalRemQty > 0 ? [220, 38, 38] : [5, 150, 105] },
  ].forEach((m, i) => {
    const x = 14 + i * colW;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(75, 85, 99);
    doc.text(m.label, x + colW / 2, y + 7, { align: 'center' });
    doc.setFontSize(12.5);
    doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    doc.text(m.val, x + colW / 2, y + 16, { align: 'center' });
  });

  y += 28;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 24, 39);
  doc.text('INCLUDED DELIVERY DOCKETS SUMMARY', 14, y);
  y += 4;

  // Summary table header
  doc.setFillColor(31, 41, 55);
  doc.rect(14, y, 182, 7, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('#', 17, y + 4.8);
  doc.text('DOCKET NUMBER', 26, y + 4.8);
  doc.text('CUSTOMER / SUPPLIER', 72, y + 4.8);
  doc.text('DATE', 124, y + 4.8);
  doc.text('PARTS', 152, y + 4.8, { align: 'center' });
  doc.text('PROGRESS', 178, y + 4.8, { align: 'center' });
  y += 7;

  orderedDeliveries.forEach((del, idx) => {
    if (y > 272) {
      doc.addPage();
      y = 20;
    }
    const vCount = del.parts.filter((p) => getPartVerificationState(p).state === 'verified').length;
    const pct = del.parts.length > 0 ? Math.round((vCount / del.parts.length) * 100) : 0;
    doc.setFillColor(idx % 2 === 0 ? 249 : 255, idx % 2 === 0 ? 250 : 255, idx % 2 === 0 ? 251 : 255);
    doc.rect(14, y, 182, 6.8, 'F');
    doc.setDrawColor(229, 231, 235);
    doc.line(14, y + 6.8, 196, y + 6.8);
    doc.setFontSize(7.2);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(17, 24, 39);
    doc.text(String(idx + 1), 17, y + 4.6);
    doc.text(del.docketNumber, 26, y + 4.6);
    doc.setFont('helvetica', 'normal');
    doc.text((del.supplier || '').slice(0, 26), 72, y + 4.6);
    doc.text(del.deliveryDate || '—', 124, y + 4.6);
    doc.text(`${vCount}/${del.parts.length}`, 152, y + 4.6, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(pct === 100 ? 5 : 17, pct === 100 ? 150 : 24, pct === 100 ? 105 : 39);
    doc.text(`${pct}%`, 178, y + 4.6, { align: 'center' });
    y += 6.8;
  });

  // Render each member docket on its own separate section page(s)
  orderedDeliveries.forEach((del, idx) => {
    doc.addPage();
    renderSingleDeliveryContent(doc, del, {
      isSectionStartOnCurrentPage: true,
      sectionIndexLabel: `Docket ${idx + 1} of ${orderedDeliveries.length}`,
    });
  });

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${BRANDING.appName} Group Report • ${group.name} (${orderedDeliveries.length} Dockets) • Generated ${new Date().toLocaleString()} • Page ${p} of ${pageCount}`,
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

export function exportGroupPdf(group: DocketGroup, memberDeliveries: Delivery[]): void {
  const doc = createGroupPdfDoc(group, memberDeliveries);
  const safeName = group.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'Group';
  doc.save(
    `${BRANDING.exportFilePrefix}_GroupReport_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`
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
    'Remaining Qty',
    'Verification Status',
    'Colour Code',
    'Pallet Location',
    'Scanned By',
    'Scanned At',
    'Scanned Via',
    'Docket Number',
    'Supplier',
  ];

  const rows = delivery.parts.map((p, idx) => {
    const vState = getPartVerificationState(p);
    const rem = Math.max(0, vState.requiredQty - vState.receivedQty);
    const scanners = formatPartScannersSummary(p, delivery.scanHistory);
    return [
      idx + 1,
      `"${p.partNumber.replace(/"/g, '""')}"`,
      `"${p.itemNumber.replace(/"/g, '""')}"`,
      `"${p.description.replace(/"/g, '""')}"`,
      `"${(p.material || '').replace(/"/g, '""')}"`,
      `"${(p.thickness || '').replace(/"/g, '""')}"`,
      vState.requiredQty,
      vState.receivedQty,
      rem,
      vState.state.toUpperCase(),
      vState.color.toUpperCase(),
      `"${String(p.palletNumber || '').replace(/"/g, '""')}"`,
      `"${scanners.replace(/"/g, '""')}"`,
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
    'Scanned By',
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
    `"${(s.employeeName || '').replace(/"/g, '""')}"`,
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
