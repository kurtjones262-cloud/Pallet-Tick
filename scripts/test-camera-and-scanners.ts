import {
  CAMERA_PROFILES,
  rankRearVideoDevices,
  applyCameraProfileToTrack,
  triggerCameraRefocusPulse,
  createVerifiedNativeBarcodeDetector,
  createInitialDiagnostics,
} from '../src/utils/cameraManager';
import {
  parsePalletLabelOcrText,
  evaluatePalletLabelMatch,
} from '../src/utils/palletLabelOcr';
import { parseBarcodeDocketNo } from '../src/utils/storage';
import { detectDuplicateScan } from '../src/utils/duplicateDetection';
import { Delivery } from '../src/types/delivery';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runTests() {
  console.log('=== PalletTrack Camera & Scanner Application-Wide Verification ===\n');

  // 1. Verify Camera Profiles for GCI QR, Laser Central Barcode, and OCR Label
  console.log('1. Verifying task-specific camera profiles...');
  const gciProfile = CAMERA_PROFILES.gci;
  const laserProfile = CAMERA_PROFILES.laser_central;
  const ocrProfile = CAMERA_PROFILES.ocr_label;

  assert(
    gciProfile.idealWidth === 1280 && gciProfile.idealHeight === 720,
    'GCI QR profile should request 1280x720 ideal resolution'
  );
  assert(
    gciProfile.scanIntervalMs === 45 &&
      gciProfile.nativeFormats.length === 1 &&
      gciProfile.nativeFormats[0] === 'qr_code' &&
      gciProfile.enableBackgroundOcr === false,
    'GCI QR profile must isolate to qr_code at 45ms cadence with background OCR disabled'
  );

  assert(
    laserProfile.idealWidth === 1920 &&
      laserProfile.idealHeight === 1080 &&
      laserProfile.scanIntervalMs === 60 &&
      laserProfile.requiredFormats.includes('code_128') &&
      laserProfile.requiredFormats.includes('code_39') &&
      laserProfile.enableBackgroundOcr === false,
    'Laser Central profile must request 1920x1080 1D barcode HD profile at 60ms cadence'
  );

  assert(
    ocrProfile.idealWidth === 1920 &&
      ocrProfile.idealHeight === 1080 &&
      ocrProfile.enableBackgroundOcr === true &&
      ocrProfile.ocrIntervalMs === 1350,
    'OCR Label profile must request 1920x1080 HD profile with background OCR enabled'
  );
  console.log('   ✓ Camera profiles verified (GCI 720p@45ms, Laser Central 1080p@60ms, OCR Label 1080p@85ms+OCR)');

  // 2. Verify Multi-Lens Rear Camera Ranking (Samsung S25 Ultra simulation)
  console.log('2. Verifying multi-lens rear camera ranking (Samsung S25 Ultra)...');
  const mockS25UltraDevices: MediaDeviceInfo[] = [
    {
      deviceId: 'front_cam_1',
      groupId: 'g1',
      kind: 'videoinput',
      label: 'camera2 1, facing front',
      toJSON: () => ({}),
    },
    {
      deviceId: 'rear_ultrawide_2',
      groupId: 'g2',
      kind: 'videoinput',
      label: 'camera2 2, facing back ultra-wide 0.6x',
      toJSON: () => ({}),
    },
    {
      deviceId: 'rear_macro_4',
      groupId: 'g4',
      kind: 'videoinput',
      label: 'camera2 4, facing back macro',
      toJSON: () => ({}),
    },
    {
      deviceId: 'rear_main_0',
      groupId: 'g0',
      kind: 'videoinput',
      label: 'camera2 0, facing back wide',
      toJSON: () => ({}),
    },
    {
      deviceId: 'rear_tele_3',
      groupId: 'g3',
      kind: 'videoinput',
      label: 'camera2 3, facing back telephoto 3x',
      toJSON: () => ({}),
    },
  ];

  const ranked = rankRearVideoDevices(mockS25UltraDevices);
  assert(
    ranked.length === 4,
    `Expected front camera to be filtered out (got ${ranked.length} rear cameras)`
  );
  assert(
    ranked[0].deviceId === 'rear_main_0',
    `Expected primary rear wide camera 'rear_main_0' to rank #1, got '${ranked[0].deviceId}'`
  );
  console.log(
    `   ✓ Ranked S25 Ultra cameras: #1 ${ranked[0].label} -> #2 ${ranked[1].label} (Front camera excluded)`
  );

  // 3. Verify In-Place Track Profile Switching & Continuous Autofocus / Exposure / White Balance
  console.log('3. Verifying in-place track profile switching & continuous AF/AE/AWB...');
  const appliedConstraintsLog: any[] = [];
  let activeSettings: any = {
    width: 1280,
    height: 720,
    frameRate: 30,
    focusMode: 'continuous',
    exposureMode: 'continuous',
    whiteBalanceMode: 'continuous',
    zoom: 1,
    deviceId: 'rear_main_0',
  };

  const mockTrack: any = {
    label: 'camera2 0, facing back wide',
    getCapabilities: () => ({
      focusMode: ['manual', 'single-shot', 'continuous'],
      exposureMode: ['manual', 'continuous'],
      whiteBalanceMode: ['manual', 'continuous'],
      zoom: { min: 1, max: 8, step: 0.1 },
      torch: true,
    }),
    getSettings: () => activeSettings,
    applyConstraints: async (c: any) => {
      appliedConstraintsLog.push(c);
      if (c.width?.ideal) activeSettings.width = c.width.ideal;
      if (c.height?.ideal) activeSettings.height = c.height.ideal;
      if (c.frameRate?.ideal) activeSettings.frameRate = c.frameRate.ideal;
      if (c.advanced && c.advanced[0]) {
        Object.assign(activeSettings, c.advanced[0]);
      }
    },
  };

  const gciApplied = await applyCameraProfileToTrack(mockTrack as MediaStreamTrack, 'gci', 1.5);
  assert(gciApplied.resolution === '1280x720', 'GCI track resolution should be 1280x720');
  assert(gciApplied.activeFocusMode === 'continuous', 'GCI activeFocusMode should be continuous');
  assert(
    gciApplied.activeExposureMode === 'continuous' &&
      gciApplied.activeWhiteBalanceMode === 'continuous',
    'GCI exposure & white balance should be continuous'
  );
  assert(gciApplied.zoomCurrent === 1.5, 'GCI hardware zoom should apply 1.5x');

  // Switch in-place to Laser Central 1D HD (1920x1080) without stopping track
  const laserApplied = await applyCameraProfileToTrack(
    mockTrack as MediaStreamTrack,
    'laser_central',
    1.0
  );
  assert(
    laserApplied.resolution === '1920x1080',
    'Switching to Laser Central should upgrade track resolution in-place to 1920x1080'
  );

  // Trigger refocus pulse
  const pulseResult = await triggerCameraRefocusPulse(mockTrack as MediaStreamTrack);
  assert(
    pulseResult.includes('continuous'),
    `Refocus pulse should restore continuous focus, got ${pulseResult}`
  );
  console.log('   ✓ In-place profile switch (720p <-> 1080p) and continuous AF/AE/AWB + refocus pulse verified');

  // 4. Verify Native BarcodeDetector Format Capability Verification & Fallback
  console.log('4. Verifying native BarcodeDetector format verification & ZXing fallback...');
  const origWindow = (globalThis as any).window;
  (globalThis as any).window = {
    BarcodeDetector: class MockBarcodeDetector {
      formats: string[];
      constructor(opts?: { formats?: string[] }) {
        this.formats = opts?.formats || [];
      }
      static async getSupportedFormats() {
        return ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'];
      }
    },
  };

  const gciDetector = await createVerifiedNativeBarcodeDetector('gci');
  assert(
    gciDetector.detector !== null &&
      gciDetector.supportedFormats.length === 1 &&
      gciDetector.supportedFormats[0] === 'qr_code',
    'GCI detector should isolate strictly to qr_code'
  );

  const laserDetector = await createVerifiedNativeBarcodeDetector('laser_central');
  assert(
    laserDetector.detector !== null &&
      laserDetector.supportedFormats.includes('code_128') &&
      laserDetector.supportedFormats.includes('code_39'),
    'Laser Central detector should include code_128 and code_39'
  );

  // Simulate a browser where BarcodeDetector only supports qr_code and NOT 1D barcodes
  (globalThis as any).window.BarcodeDetector.getSupportedFormats = async () => ['qr_code'];
  const fallbackLaserDetector = await createVerifiedNativeBarcodeDetector('laser_central');
  assert(
    fallbackLaserDetector.detector === null &&
      fallbackLaserDetector.engineName.includes('ZXing'),
    'Laser Central must fall back to ZXing if browser BarcodeDetector lacks code_128/code_39 support'
  );
  (globalThis as any).window = origWindow;
  console.log('   ✓ Native BarcodeDetector format verification & automatic 1D ZXing fallback verified');

  // 5. Verify Laser Central Barcode, GCI QR, OCR Label Parsing, and Duplicate Prevention
  console.log('5. Verifying Laser Central barcode, OCR Label parser, and duplicate prevention...');
  const parsedLaser = parseBarcodeDocketNo('246982-3');
  assert(
    parsedLaser.hasDashFormat &&
      parsedLaser.prefix === '246982' &&
      parsedLaser.numericNo === 3,
    'Laser Central ######-<No> barcode parser must extract docket 246982 and item 3'
  );

  const mockParts: Delivery['parts'] = [
    {
      id: 'p1',
      partNumber: '0045-PLT-102',
      description: 'BASE PLATE 10MM',
      quantity: 24,
      receivedQuantity: 0,
      status: 'outstanding',
      itemNumber: '3',
      docketLineIndex: 3,
    },
  ];

  const parsedOcr = parsePalletLabelOcrText(
    'ORDER NO: PO-99102\nDATE: 11/11/2026\nPALLET 1 OF 4\nPART NUMBER: 0045-PLT-102\nDESCRIPTION: BASE PLATE 10MM\nQTY: 12 PCS\nWEIGHT: 180 KG',
    mockParts,
    92
  );
  assert(
    parsedOcr.partNumber === '0045-PLT-102' &&
      parsedOcr.quantity === 12 &&
      parsedOcr.ocrConfidence === 'high',
    'OCR Label parser must extract partNumber 0045-PLT-102 and split pallet quantity 12 while ignoring PO/Date/Weight'
  );

  const matchEval = evaluatePalletLabelMatch(
    parsedOcr.partNumber,
    parsedOcr.quantity,
    mockParts,
    parsedOcr.ocrConfidence
  );
  assert(
    matchEval.matchedPart?.id === 'p1',
    'OCR Label matcher must match part 0045-PLT-102 to compiled docket part'
  );

  const diagInit = createInitialDiagnostics('gci');
  assert(
    diagInit.scanIntervalMs === 45 && diagInit.multipleDecodersActive === false,
    'Initial diagnostics must report 45ms scan interval and single-flight decoder status'
  );

  const mockScannedDelivery: Delivery = {
    id: 'del_1',
    docketNumber: '246982',
    supplier: 'GCI',
    deliveryDate: '2026-11-11',
    status: 'receiving',
    parts: [
      {
        ...mockParts[0],
        receivedQuantity: 24,
        status: 'received',
        scannedAt: '2026-11-11T10:00:00Z',
      },
    ],
    docketAttachments: [],
    unexpectedParts: [],
    scanHistory: [],
    createdAt: '2026-11-11T09:00:00Z',
    updatedAt: '2026-11-11T10:00:00Z',
  };

  const dupResult = detectDuplicateScan(mockScannedDelivery, '0045-PLT-102');
  assert(dupResult.isDuplicate === true, 'Duplicate scan check must flag already-verified part');
  console.log('   ✓ Laser Central barcode, OCR Label parser, and duplicate scan prevention verified');

  console.log('\nALL CAMERA & SCANNER VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
