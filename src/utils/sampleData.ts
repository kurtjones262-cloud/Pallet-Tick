import { Delivery, DeliveryPart, AppSettings } from '../types/delivery';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  soundEnabled: true,
  vibrationEnabled: true,
  speechEnabled: false,
  autoTorch: false,
  preferredCamera: 'environment',
  autoExpandQuantities: true,
  darkHighContrast: true,
};

const STEEL_PART_TEMPLATES = [
  { prefix: 'PLT', desc: 'Mild Steel Base Plate', mat: '350 Grade Steel', thk: '10.0mm' },
  { prefix: 'GST', desc: 'Corner Gusset Stiffener', mat: '250 Grade Steel', thk: '6.0mm' },
  { prefix: 'FLG', desc: 'Pipe Flange Blank 8-Hole', mat: '350 Grade Steel', thk: '12.0mm' },
  { prefix: 'LUG', desc: 'Lifting Lug Proof-Rated', mat: '350 Grade Steel', thk: '16.0mm' },
  { prefix: 'BRK', desc: 'Mounting Bracket Right-Angle', mat: '250 Grade Steel', thk: '6.0mm' },
  { prefix: 'RIB', desc: 'Web Reinforcement Rib', mat: '350 Grade Steel', thk: '8.0mm' },
  { prefix: 'CAP', desc: 'RHS End Cap Chamfered', mat: 'Mild Steel 250', thk: '5.0mm' },
  { prefix: 'CLE', desc: 'Beam Connection Cleat 4-Hole', mat: '350 Grade Steel', thk: '10.0mm' },
  { prefix: 'WSH', desc: 'Heavy Duty Structural Washer', mat: 'High Tensile 400', thk: '8.0mm' },
  { prefix: 'SPL', desc: 'Girder Splice Plate', mat: '350 Grade Steel', thk: '12.0mm' },
  { prefix: 'ANC', desc: 'Hold-Down Anchor Plate', mat: '350 Grade Steel', thk: '20.0mm' },
  { prefix: 'SHM', desc: 'Precision Alignment Shim Pack', mat: '304 Stainless', thk: '3.0mm' },
];

/**
 * Generates an authentic 200-part laser cut steel delivery across 6 pallets
 */
export function generate200PartDelivery(): Delivery {
  const deliveryId = 'del_200_parts_laser';
  const parts: DeliveryPart[] = [];
  const totalParts = 200;
  const pallets = [
    'Pallet 1 of 6',
    'Pallet 2 of 6',
    'Pallet 3 of 6',
    'Pallet 4 of 6',
    'Pallet 5 of 6',
    'Pallet 6 of 6',
  ];

  let currentItemSeq = 9001;

  for (let i = 0; i < totalParts; i++) {
    const template = STEEL_PART_TEMPLATES[i % STEEL_PART_TEMPLATES.length];
    const groupNum = Math.floor(i / 10) + 1;
    const palletIndex = Math.min(Math.floor((i / totalParts) * 6), 5);
    const pallet = pallets[palletIndex];

    const partNumber = `${template.prefix}-${100 + groupNum * 5}`;
    const itemNumber = `${i + 1}`;

    // Mark the first 18 parts as already received to demonstrate live progress
    const isPreReceived = i < 18;
    const scannedAtTime = isPreReceived
      ? new Date(Date.now() - (18 - i) * 65000).toISOString()
      : undefined;
    const reqQty = i % 3 === 0 ? 4 : i % 5 === 0 ? 2 : 1;

    parts.push({
      id: `part_${i + 1}`,
      docketLineIndex: i + 1,
      partNumber,
      itemNumber,
      description: `${template.desc} (Size ${120 + (i % 8) * 20}x${80 + (i % 5) * 25}mm)`,
      material: template.mat,
      thickness: template.thk,
      quantity: reqQty,
      receivedQuantity: isPreReceived ? reqQty : undefined,
      verificationStatus: isPreReceived ? 'verified' : 'unscanned',
      palletNumber: pallet,
      status: isPreReceived ? 'received' : 'outstanding',
      scannedAt: scannedAtTime,
      scannedVia: isPreReceived ? (i % 2 === 0 ? 'qr' : 'barcode') : undefined,
      scannedCode: isPreReceived ? (i % 2 === 0 ? partNumber : `894201-${i + 1}`) : undefined,
      ocrConfidence: i === 47 || i === 83 ? 'low' : 'high',
      flaggedForReview: i === 47,
    });
  }

  return {
    id: deliveryId,
    docketNumber: 'DK-89420-STEEL',
    supplier: 'Laser Central',
    supplierProfile: 'laser_central',
    deliveryDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    updatedAt: new Date().toISOString(),
    carrier: 'Direct Workshop Linehaul Freight',
    orderNumber: 'PO-66810-STRUCT',
    palletCount: 6,
    notes: '200 Laser-cut components tagged with Laser Central Barcode (######-No) & QR (part number). Verify 6 heavy wooden pallets.',
    status: 'receiving',
    docketAttachments: [
      {
        id: 'att_1',
        name: 'docket_page1_signed.jpg',
        uploadedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      },
    ],
    parts,
    unexpectedParts: [
      {
        id: 'unexp_1',
        code: 'SPARE-LUG-99',
        codeType: 'qr',
        scannedAt: new Date(Date.now() - 900000).toISOString(),
        notes: 'Found in corner of Pallet 2 with no matching docket entry. Quarantined.',
        resolved: false,
      },
    ],
    scanHistory: [
      {
        id: 'scan_1',
        timestamp: new Date(Date.now() - 1100000).toISOString(),
        code: 'PLT-105',
        codeType: 'qr',
        status: 'match_success',
        partId: 'part_1',
        partNumber: 'PLT-105',
        itemNumber: 'BC-9001',
        message: 'Matched Part PLT-105 via QR code',
      },
      {
        id: 'scan_2',
        timestamp: new Date(Date.now() - 900000).toISOString(),
        code: 'SPARE-LUG-99',
        codeType: 'qr',
        status: 'unexpected_warning',
        message: 'Code SPARE-LUG-99 not found on delivery docket',
      },
      {
        id: 'scan_3',
        timestamp: new Date(Date.now() - 750000).toISOString(),
        code: 'BC-9002',
        codeType: 'barcode',
        status: 'match_success',
        partId: 'part_2',
        partNumber: 'GST-105',
        itemNumber: 'BC-9002',
        message: 'Matched Item BC-9002 via Barcode',
      },
    ],
  };
}

/**
 * Generates a 45-part mining bracket delivery across 2 pallets
 */
export function generate45PartDelivery(): Delivery {
  const parts: DeliveryPart[] = [];
  const totalParts = 45;

  for (let i = 0; i < totalParts; i++) {
    const pallet = i < 24 ? 'Pallet 1 of 2' : 'Pallet 2 of 2';
    const partNum = `M-BRKT-${100 + (i % 9)}`;
    const itemNum = `${i + 1}`;
    const reqQty = i % 2 === 0 ? 4 : 1;

    parts.push({
      id: `mining_part_${i + 1}`,
      docketLineIndex: i + 1,
      partNumber: partNum,
      itemNumber: itemNum,
      description: `Mining Chute Wear Liner Bracket ${150 + (i % 4) * 30}mm`,
      material: 'Hardox 450 Wear Plate',
      thickness: '12.0mm',
      quantity: reqQty,
      receivedQuantity: i < 5 ? reqQty : undefined,
      verificationStatus: i < 5 ? 'verified' : 'unscanned',
      palletNumber: pallet,
      status: i < 5 ? 'received' : 'outstanding',
      scannedAt: i < 5 ? new Date(Date.now() - (5 - i) * 120000).toISOString() : undefined,
      scannedVia: i < 5 ? 'qr' : undefined,
      scannedCode: i < 5 ? partNum : undefined,
      ocrConfidence: 'high',
    });
  }

  return {
    id: 'del_45_parts_mining',
    docketNumber: 'DK-4409-MINING',
    supplier: 'Laser Central',
    supplierProfile: 'laser_central',
    deliveryDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    updatedAt: new Date().toISOString(),
    carrier: 'Toll Express Priority',
    orderNumber: 'PO-9102-CHUTE',
    palletCount: 2,
    notes: 'Hardox 450 chute liner brackets. Heavy duty packaging.',
    status: 'receiving',
    docketAttachments: [],
    parts,
    unexpectedParts: [],
    scanHistory: [],
  };
}

/**
 * Generates an urgent 15-part prototype flange delivery
 */
export function generate15PartDelivery(): Delivery {
  const parts: DeliveryPart[] = [];
  const names = [
    { p: 'FLG-150-PN16', i: 'BAR-3301', d: 'DN150 PN16 Table E Flange Blank', th: '16mm', q: 1 },
    { p: 'FLG-200-PN16', i: 'BAR-3302', d: 'DN200 PN16 Table E Flange Blank', th: '16mm', q: 4 },
    { p: 'FLG-250-PN16', i: 'BAR-3303', d: 'DN250 PN16 Table E Flange Blank', th: '20mm', q: 2 },
    { p: 'PLT-GUSSET-8', i: 'BAR-3304', d: '8mm Stainless 316 Gusset Bracket', th: '8mm', q: 6 },
    { p: 'PLT-GUSSET-10', i: 'BAR-3305', d: '10mm Stainless 316 Gusset Bracket', th: '10mm', q: 1 },
    { p: 'PLT-GUSSET-12', i: 'BAR-3306', d: '12mm Stainless 316 Gusset Bracket', th: '12mm', q: 4 },
    { p: 'LUG-PROOF-2T', i: 'BAR-3307', d: '2 Tonne Certified Lifting Eye Lug', th: '25mm', q: 2 },
    { p: 'LUG-PROOF-5T', i: 'BAR-3308', d: '5 Tonne Certified Lifting Eye Lug', th: '25mm', q: 1 },
    { p: 'BS-BASE-300', i: 'BAR-3309', d: 'Column Baseplate 300x300 with 4x24mm Holes', th: '20mm', q: 4 },
    { p: 'BS-BASE-400', i: 'BAR-3310', d: 'Column Baseplate 400x400 with 4x24mm Holes', th: '20mm', q: 1 },
    { p: 'SHM-2MM-PACK', i: 'BAR-3311', d: 'Precision Motor Levelling Shim 100x100', th: '2mm', q: 8 },
    { p: 'SHM-3MM-PACK', i: 'BAR-3312', d: 'Precision Motor Levelling Shim 100x100', th: '3mm', q: 1 },
    { p: 'SHM-5MM-PACK', i: 'BAR-3313', d: 'Precision Motor Levelling Shim 100x100', th: '5mm', q: 4 },
    { p: 'SHM-6MM-PACK', i: 'BAR-3314', d: 'Precision Motor Levelling Shim 100x100', th: '6mm', q: 2 },
    { p: 'CAP-POST-75', i: 'BAR-3315', d: '75x75 SHS Pyramid Post Cap', th: '3mm', q: 1 },
  ];

  names.forEach((item, idx) => {
    parts.push({
      id: `proto_part_${idx + 1}`,
      docketLineIndex: idx + 1,
      partNumber: item.p,
      itemNumber: `${idx + 1}`,
      description: item.d,
      material: '350 Steel / 316 SS',
      thickness: item.th,
      quantity: item.q,
      verificationStatus: 'unscanned',
      palletNumber: 'Pallet 1 of 1',
      status: 'outstanding',
      ocrConfidence: 'high',
    });
  });

  return {
    id: 'del_15_parts_proto',
    docketNumber: 'DK-102-FAST',
    supplier: 'GCI',
    supplierProfile: 'gci',
    deliveryDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    carrier: 'Same Day Courier',
    orderNumber: 'PO-0089-PROTO',
    palletCount: 1,
    notes: 'Urgent prototype run for test rig assembly.',
    status: 'receiving',
    docketAttachments: [],
    parts,
    unexpectedParts: [],
    scanHistory: [],
  };
}
