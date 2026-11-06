import React, { useState, useRef } from 'react';
import {
  Camera,
  Upload,
  X,
  AlertCircle,
  ChevronRight,
  Trash2,
  FileCheck2,
  Cpu,
  WifiOff,
  Sparkles,
} from 'lucide-react';
import { Delivery } from '../types/delivery';
import {
  generate200PartDelivery,
  generate45PartDelivery,
  generate15PartDelivery,
} from '../utils/sampleData';
import { updateDelivery, setActiveDeliveryId } from '../utils/storage';
import { ExtractedDocketResult } from '../server/docketOcr';
import {
  performSmartDocketExtraction,
  prepareColorImageForGemini,
  OcrProgressUpdate,
} from '../utils/offlineOcr';
import { DocketOcrReviewModal } from './DocketOcrReviewModal';

interface NewDeliveryModalProps {
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery) => void;
}

interface CapturedPage {
  id: string;
  dataUrl: string;
  name: string;
}

export const NewDeliveryModal: React.FC<NewDeliveryModalProps> = ({
  onClose,
  onDeliveryCreated,
}) => {
  const [capturedPages, setCapturedPages] = useState<CapturedPage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgressUpdate | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [reviewData, setReviewData] = useState<ExtractedDocketResult | null>(null);
  const [forceOfflineMode, setForceOfflineMode] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

  const handleFilesAdded = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    setOcrError(null);
    const filesArray = Array.from(fileList);
    const newPages: CapturedPage[] = [];

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      try {
        const prepared = await prepareColorImageForGemini(file, 1800);
        newPages.push({
          id: `page_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
          dataUrl: prepared.dataUrl,
          name: file.name || `Page ${capturedPages.length + i + 1}`,
        });
      } catch (err) {
        console.error('Failed reading file, falling back to raw reader:', err);
        try {
          const dataUrl = await readFileAsDataUrl(file);
          newPages.push({
            id: `page_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
            dataUrl,
            name: file.name || `Page ${capturedPages.length + i + 1}`,
          });
        } catch (innerErr) {
          console.error('Fallback file read failed:', innerErr);
        }
      }
    }

    setCapturedPages((prev) => [...prev, ...newPages]);
  };

  const handleRemovePage = (id: string) => {
    setCapturedPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleExtractPartsFromDocket = async () => {
    if (capturedPages.length === 0) return;

    setIsProcessing(true);
    setOcrError(null);
    setOcrProgress({
      currentPage: 1,
      totalPages: capturedPages.length,
      stage: 'preparing',
      percent: 5,
      statusText: 'Analyzing delivery docket for individual parts...',
    });

    try {
      const imagesToProcess = capturedPages.map((p) => p.dataUrl);
      const output = await performSmartDocketExtraction(
        imagesToProcess,
        (update) => {
          setOcrProgress(update);
        },
        forceOfflineMode
      );

      setIsProcessing(false);
      setReviewData(output.extractedData);
    } catch (err: any) {
      console.error('Docket extraction error:', err);
      setIsProcessing(false);
      setOcrError(
        err?.message ||
          'Docket extraction failed. Ensure docket image is legible, or load a sample template.'
      );
    }
  };

  const handleSelectPreset = (presetType: '200' | '45' | '15') => {
    let delivery: Delivery;
    if (presetType === '200') {
      delivery = generate200PartDelivery();
    } else if (presetType === '45') {
      delivery = generate45PartDelivery();
    } else {
      delivery = generate15PartDelivery();
    }

    const uniqueDelivery: Delivery = {
      ...delivery,
      id: `del_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    updateDelivery(uniqueDelivery);
    setActiveDeliveryId(uniqueDelivery.id);
    onDeliveryCreated(uniqueDelivery);
    onClose();
  };

  return (
    <>
      {reviewData ? (
        <DocketOcrReviewModal
          extractedData={reviewData}
          attachedPages={capturedPages.map((p, idx) => ({
            pageNumber: idx + 1,
            dataUrl: p.dataUrl,
            name: p.name,
          }))}
          onClose={() => setReviewData(null)}
          onDeliveryCreated={onDeliveryCreated}
        />
      ) : (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={onClose}
        >
          <div
            className="w-full max-w-lg bg-[#F6F5F2] border-t sm:border border-[#E4E3DE] sm:rounded-[6px] shadow-xl overflow-hidden max-h-[92dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[#E4E3DE] flex items-center justify-between bg-white shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-[#18181B]">
                  Compile Parts List from Photo
                </h3>
                {isOnline && !forceOfflineMode ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-emerald-50 text-[#059669] font-mono text-[10px] font-semibold border border-emerald-200">
                    <Sparkles className="w-2.5 h-2.5" />
                    <span>Gemini AI Active</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-zinc-100 text-zinc-700 font-mono text-[10px] font-semibold border border-zinc-300">
                    <WifiOff className="w-2.5 h-2.5" />
                    <span>Offline OCR Mode</span>
                  </span>
                )}
              </div>
              <button
                onClick={onClose}
                className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Hidden native camera/file inputs */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (e) => {
                await handleFilesAdded(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                await handleFilesAdded(e.target.files);
                e.target.value = '';
              }}
            />

            {/* Main Modal Body */}
            <div className="flex-1 overflow-y-auto">
              {isProcessing ? (
                <div className="py-12 px-6 flex flex-col items-center justify-center text-center">
                  <div className="w-10 h-10 rounded-full border-2 border-[#E4E3DE] border-t-[#059669] animate-spin mb-4 flex items-center justify-center">
                    {!forceOfflineMode && isOnline ? (
                      <Sparkles className="w-4 h-4 text-[#059669]" />
                    ) : (
                      <Cpu className="w-4 h-4 text-[#059669]" />
                    )}
                  </div>

                  <span className="text-[11px] font-mono uppercase tracking-widest text-[#059669] font-semibold mb-1">
                    {!forceOfflineMode && isOnline
                      ? 'Gemini AI Vision · Compiling Parts List'
                      : 'Offline On-Device OCR · Compiling Parts List'}
                  </span>

                  <h4 className="text-sm font-bold text-[#18181B] mb-1">
                    {ocrProgress?.statusText || 'Gemini AI is analyzing your docket photo...'}
                  </h4>

                  <p className="text-xs text-zinc-500 max-w-xs leading-relaxed mb-5">
                    Identifying every individual part number, item code, description, material, thickness, dimensions, and quantity into a compiled checklist.
                  </p>

                  {/* Progress Bar */}
                  <div className="w-full max-w-xs h-1.5 bg-[#E4E3DE] rounded-full overflow-hidden mb-2">
                    <div
                      className="h-full bg-[#059669] transition-all duration-300"
                      style={{ width: `${ocrProgress?.percent || 20}%` }}
                    />
                  </div>

                  <span className="font-mono text-xs text-zinc-400 tabular-nums">
                    {ocrProgress?.percent || 20}% complete · Page {ocrProgress?.currentPage || 1} of{' '}
                    {ocrProgress?.totalPages || 1}
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-[#E4E3DE]">
                  {ocrError && (
                    <div className="px-4 py-3 bg-red-50 text-xs text-red-700 space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                        <span>{ocrError}</span>
                      </div>
                      {capturedPages.length > 0 && (
                        <div className="flex items-center gap-2 pl-6">
                          <button
                            onClick={handleExtractPartsFromDocket}
                            className="px-2.5 py-1 rounded-[3px] bg-[#059669] text-white font-semibold text-[11px] cursor-pointer"
                          >
                            Retry with Gemini AI
                          </button>
                          {!forceOfflineMode && (
                            <button
                              onClick={() => {
                                setForceOfflineMode(true);
                                setOcrError(null);
                              }}
                              className="px-2.5 py-1 rounded-[3px] bg-white border border-red-200 text-red-700 font-medium text-[11px] cursor-pointer"
                            >
                              Switch to Offline OCR
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Docket Photography & Upload Section */}
                  <div className="p-4 bg-white">
                    {/* Extraction Engine Toggle */}
                    <div className="flex items-center justify-between gap-2 mb-3 p-1 bg-[#F6F5F2] border border-[#E4E3DE] rounded-[4px]">
                      <button
                        type="button"
                        onClick={() => setForceOfflineMode(false)}
                        className={`flex-1 h-8 px-2.5 rounded-[3px] text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          !forceOfflineMode
                            ? 'bg-white text-[#059669] shadow-xs border border-emerald-200/70'
                            : 'text-zinc-500 hover:text-[#18181B]'
                        }`}
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Gemini AI Parts Compiler</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setForceOfflineMode(true)}
                        className={`flex-1 h-8 px-2.5 rounded-[3px] text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          forceOfflineMode
                            ? 'bg-white text-[#18181B] shadow-xs border border-[#E4E3DE]'
                            : 'text-zinc-500 hover:text-[#18181B]'
                        }`}
                      >
                        <WifiOff className="w-3.5 h-3.5" />
                        <span>Offline On-Device OCR</span>
                      </button>
                    </div>

                    <p className="text-xs text-zinc-500 mb-3.5 leading-relaxed">
                      Take a photo or upload an image of your delivery docket or packing slip.{' '}
                      <strong className="text-[#18181B]">Gemini AI</strong> analyzes the photo and compiles{' '}
                      <strong className="text-[#18181B]">only each individual part and all of its details</strong>{' '}
                      (Part #, Item #, Description, Material, Thickness, Dimensions, Qty, Pallet) into a structured list.
                    </p>

                    {/* Action Buttons to capture/add pages */}
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <button
                        onClick={() => cameraInputRef.current?.click()}
                        className="h-10 px-3 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
                      >
                        <Camera className="w-3.5 h-3.5" />
                        <span>{capturedPages.length > 0 ? 'Add docket photo' : 'Photograph docket'}</span>
                      </button>

                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="h-10 px-3 rounded-[4px] bg-white hover:bg-zinc-50 border border-[#E4E3DE] text-[#18181B] font-medium text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
                      >
                        <Upload className="w-3.5 h-3.5 text-zinc-500" />
                        <span>Upload docket photo</span>
                      </button>
                    </div>

                    {/* Photographed Page Thumbnails */}
                    {capturedPages.length > 0 && (
                      <div className="pt-2 border-t border-[#E4E3DE] space-y-2">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {capturedPages.map((page, idx) => (
                            <div
                              key={page.id}
                              className="relative group rounded border border-[#E4E3DE] bg-zinc-50 overflow-hidden aspect-[3/4]"
                            >
                              <img
                                src={page.dataUrl}
                                alt={`Page ${idx + 1}`}
                                className="w-full h-full object-cover"
                              />
                              <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/70 backdrop-blur-xs text-white font-mono text-[10px] rounded">
                                P{idx + 1}
                              </div>
                              <button
                                onClick={() => handleRemovePage(page.id)}
                                className="absolute top-1 right-1 p-1 bg-red-600/90 text-white rounded hover:bg-red-700 cursor-pointer"
                                title="Delete page"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>

                        {/* Execute Docket Part Extraction Button */}
                        <button
                          onClick={handleExtractPartsFromDocket}
                          className="w-full mt-3 h-11 px-4 bg-[#18181B] hover:bg-zinc-800 text-white font-semibold text-xs tracking-wider uppercase rounded-[4px] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                        >
                          {!forceOfflineMode && isOnline ? (
                            <>
                              <Sparkles className="w-4 h-4 text-emerald-400" />
                              <span>
                                Compile Parts List with Gemini AI ({capturedPages.length}{' '}
                                {capturedPages.length === 1 ? 'Photo' : 'Photos'})
                              </span>
                            </>
                          ) : (
                            <>
                              <FileCheck2 className="w-4 h-4 text-emerald-400" />
                              <span>
                                Extract Parts Offline ({capturedPages.length}{' '}
                                {capturedPages.length === 1 ? 'Photo' : 'Photos'})
                              </span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Sample Workshop Templates Section */}
                  <div className="p-4 bg-[#F6F5F2]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
                        Or Load Workshop Sample Dockets
                      </span>
                    </div>

                    <div className="bg-white border border-[#E4E3DE] rounded-[4px] divide-y divide-[#E4E3DE]">
                      <button
                        onClick={() => handleSelectPreset('200')}
                        className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-50 flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-[#18181B] block">
                            Structural Steel Laser Cutting
                          </span>
                          <span className="text-[11px] font-mono text-zinc-500">
                            200 parts · 6 pallets · ShapeCut Precision
                          </span>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      </button>

                      <button
                        onClick={() => handleSelectPreset('45')}
                        className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-50 flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-[#18181B] block">
                            Mining Conveyor Frame Brackets
                          </span>
                          <span className="text-[11px] font-mono text-zinc-500">
                            45 parts · 2 pallets · Hardox 450
                          </span>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      </button>

                      <button
                        onClick={() => handleSelectPreset('15')}
                        className="w-full px-3.5 py-2.5 text-left hover:bg-zinc-50 flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-[#18181B] block">
                            Prototype Flanges & Lugs
                          </span>
                          <span className="text-[11px] font-mono text-zinc-500">
                            15 parts · 1 pallet · Quick verification
                          </span>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}
