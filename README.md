# PalletTick — Industrial Parts Receiving & Delivery Verification (Android APK)

PalletTick is a standalone, offline-first mobile application designed specifically for workshop environments receiving deliveries of laser-cut steel parts, fabrications, and palletized materials.

---

## Key Capabilities

- **Standalone Android Application**: Configured as a native Android app via Capacitor (`com.parttrack.app`). Installs directly via APK onto Samsung Galaxy and Android phones and tablets—zero Google Play Store or hosted server required.
- **Continuous Industrial Camera Scanning**: Real-time camera scanner for 1D Barcodes (Item Numbers) and 2D QR Codes (Part Numbers) with audio chimes and haptic vibration feedback.
- **100% Offline On-Device OCR**: Photographs single or multi-page delivery dockets and extracts metadata, part numbers, item codes, and quantities locally using on-device Tesseract.js WebAssembly. Works with Wi-Fi and mobile data completely disabled.
- **Local Persistence via IndexedDB**: Full-resolution docket photos, deliveries, pallets, and scan event logs are stored locally on the device (`parttrack_offline_db`). Data survives app restarts and phone reboots.
- **Comprehensive Verification & Exports**:
  - Live progress tracking (`Received / Total Parts`).
  - Pallet breakdown and itemized checklist.
  - Unexpected / unlisted part discrepancy flags.
  - 1-click export of complete receiving packages as `.zip` (containing the PDF report, CSV inventory, scan logs, and original photographed docket images).

---

## Android Project Configuration

- **App Name**: `PalletTick`
- **Application ID / Package**: `com.parttrack.app`
- **Minimum SDK**: Android 7.0 (API Level 24)
- **Target SDK**: Android 15 / 16 (API Level 36)
- **Permissions**:
  - `android.permission.CAMERA` (Barcode/QR scanning & docket photography)
  - `android.permission.VIBRATE` (Haptic confirmation on parts matched)
  - `android.permission.INTERNET` (Local asset serving within Capacitor WebView)

---

## Building the Standalone APK for Your Samsung Phone

### 1. Build & Sync Web Assets to Android
Run in the project directory:
```bash
npm run android:sync
```
*(Or `npm run build && npx cap sync android`)*

This compiles the frontend application and copies all web assets, icons, and offline OCR WebAssembly models into `android/app/src/main/assets/public`.

---

### 2. Generate Debug APK (Direct Phone Installation)
To build the installable debug APK on your computer or build machine:
```bash
cd android
./gradlew assembleDebug
```
*On Windows command prompt:*
```cmd
cd android
gradlew.bat assembleDebug
```

The APK will be generated at:
```text
android/app/build/outputs/apk/debug/app-debug.apk
```

---

### 3. Installing the APK on your Samsung Phone

#### Method A: Direct Transfer (USB or Download)
1. Copy `app-debug.apk` to your Samsung phone (via USB cable, Google Drive, Quick Share, or local network).
2. Open the **My Files** app on your Samsung phone.
3. Tap **Downloads** (or find `app-debug.apk`).
4. Tap the file to install.
5. If prompted:
   - Allow **"Install unknown apps"** for **My Files** in `Settings > Security and privacy > Install unknown apps`.
6. Tap **Install**.
7. Launch **PalletTick** from your home screen or app drawer!

#### Method B: ADB (USB Debugging)
If your phone is connected to your computer via USB with Developer Options & USB Debugging enabled:
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

### 4. Generating a Signed Release APK (Optional)
To create an optimized, signed release APK:

1. Generate a keystore if you don't already have one:
   ```bash
   keytool -genkey -v -keystore parttrack-release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias parttrack-key
   ```
2. Place `parttrack-release-key.jks` in the `android/` directory.
3. Copy `android/keystore.properties.example` to `android/keystore.properties`:
   ```properties
   storeFile=parttrack-release-key.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=parttrack-key
   keyPassword=YOUR_KEY_PASSWORD
   ```
4. Build the release APK:
   ```bash
   cd android
   ./gradlew assembleRelease
   ```
   The signed release APK will be generated at:
   ```text
   android/app/build/outputs/apk/release/app-release.apk
   ```

---

## Testing Offline Functionality
1. Open PalletTick on your phone.
2. Put the phone into **Airplane Mode** (disable Wi-Fi and Cellular Data).
3. Create a delivery and photograph a docket—the on-device OCR engine processes the document without internet access.
4. Scan parts or simulate barcodes—all matches, duplicates, and discrepancies update instantly.
5. Export a `.zip` receiving package—the PDF report, CSVs, and photos are bundled entirely in the device memory.
6. Force close the app and reopen—all deliveries and scan history remain intact in local storage.
