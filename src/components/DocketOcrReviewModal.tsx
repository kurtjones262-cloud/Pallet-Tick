import React, { useState } from 'react';
import {
  AlertTriangle,
  Plus,
  Trash2,
  X,
  Eye,
  EyeOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { Delivery, DeliveryPart, DocketAttachment } from '../types/delivery';
import { ExtractedDocketResult, ExtractedDocketItem } from '../server/docketOcr';
import { updateDelivery, setActiveDeliveryId, saveDocketImages } from '../utils/storage';

interface AttachedPage {
  pageNumber: number;
  dataUrl: string;
  name?: string;
}

interface DocketOcrReviewModalProps {
  extractedData: ExtractedDocketResult;
  attachedPages?: AttachedPage[];
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery) => void;
}

export const DocketOcrReviewModal: React.FC<DocketOcrReviewModalProps> = ({
  extractedData,
  attachedPages = [],
  onClose,
  onDeliveryCreated,
}) => {
  const [docketNumber, setDocketNumber] = useState(extractedData.docketNumber || 'DK-0001');
  const [supplier, setSupplier] = useState(extractedData.supplier || 'Laser Cutting Supplier');
  const [deliveryDate, setDeliveryDate] = useState(
    extractedData.deliveryDate || new Date().toISOString().slice(0, 10)
  );
  const [carrier, setCarrier] = useState(extractedData.carrier || '');
  const [palletCount, setPalletCount] = useState<number>(extractedData.palletCount || 1);
  const [orderNumber, setOrderNumber] = useState(extractedData.orderNumber || '');
  const [notes, setNotes] = useState(extractedData.notes || '');

  const [items, setItems] = useState<ExtractedDocketItem[]>(extractedData.items || []);
  const [filterMode, setFilterMode] = useState<'all' | 'flagged'>('all');
  const [expandQuantities, setExpandQuantities] = useState(false);

  const [showPhotoViewer, setShowPhotoViewer] = useState(false);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  const handleItemChange = (index: number, field: keyof ExtractedDocketItem, value: any) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      if (field === 'partNumber' || field === 'itemNumber') {
        next[index].confidence = 'high';
      }
      return next;
    });
  };

  const handleAddItem = () => {
    const newItem: ExtractedDocketItem = {
      partNumber: `PLT-${items.length + 101}`,
      itemNumber: `${items.length + 1}`,
      description: 'Laser-cut steel part',
      material: '350Gr',
      thickness: '10mm',
      dimensions: '',
      quantity: 1,
      palletNumber: `Pallet 1`,
      confidence: 'high',
    };
    setItems([newItem, ...items]);
  };

  const handleRemoveItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const totalExpandedParts = items.reduce((acc, it) => acc + (it.quantity || 1), 0);
  const lowConfidenceCount = items.filter((i) => i.confidence === 'low').length;

  const filteredItems = items.filter((it) => {
    if (filterMode === 'flagged') return it.confidence === 'low';
    return true;
  });

  const handleConfirmImport = async () => {
    const deliveryId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const finalParts: DeliveryPart[] = [];
    let lineIdx = 1;

    items.forEach((it, rowIdx) => {
      const qty = expandQuantities ? Math.max(1, it.quantity || 1) : 1;
      const isMultiple = qty > 1;
      // Preserve the exact Docket "No" (e.g. "1", "2", "3") so "<numbers>-<No>" barcodes cross-reference directly
      const cleanDocketNo =
        it.itemNumber.trim().replace(/^(?:ITM|LINE|POS|NO\.?)\s*[-:]?\s*0*/i, '') ||
        String(rowIdx + 1);

      for (let q = 1; q <= qty; q++) {
        finalParts.push({
          id: `part_${deliveryId}_${lineIdx}`,
          docketLineIndex: rowIdx + 1,
          partNumber: it.partNumber.trim().toUpperCase(),
          itemNumber: cleanDocketNo.toUpperCase(),
          description: isMultiple
            ? `${it.description} (Piece ${q} of ${qty})`
            : it.description,
          material: it.material?.trim() || undefined,
          thickness: it.thickness?.trim() || undefined,
          dimensions: it.dimensions?.trim() || undefined,
          weight: it.weight?.trim() || undefined,
          quantity: expandQuantities ? 1 : Math.max(1, it.quantity || 1),
          palletNumber: it.palletNumber || `Pallet 1`,
          status: 'outstanding',
          ocrConfidence: it.confidence,
          flaggedForReview: it.confidence === 'low',
          notes: it.notes,
        });

        lineIdx++;
      }
    });

    const attachments: DocketAttachment[] = attachedPages.map((p, idx) => ({
      id: `att_${deliveryId}_${idx + 1}`,
      name: p.name || `docket_${docketNumber}_p${idx + 1}.jpg`,
      uploadedAt: new Date().toISOString(),
      dataUrl: p.dataUrl,
    }));

    const newDelivery: Delivery = {
      id: deliveryId,
      docketNumber: docketNumber.trim().toUpperCase(),
      supplier: supplier.trim(),
      deliveryDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      carrier: carrier.trim() || undefined,
      orderNumber: orderNumber.trim() || undefined,
      palletCount,
      notes: notes.trim() || undefined,
      status: 'receiving',
      docketAttachments: attachments,
      parts: finalParts,
      unexpectedParts: [],
      scanHistory: [],
    };

    updateDelivery(newDelivery);
    setActiveDeliveryId(newDelivery.id);

    if (attachedPages.length > 0) {
      await saveDocketImages(newDelivery.id, attachedPages);
    }

    onDeliveryCreated(newDelivery);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-0 sm:p-4">
      <div className="w-full max-w-6xl h-[100dvh] sm:h-[92vh] bg-[#F6F5F2] sm:border border-[#E4E3DE] sm:rounded-[6px] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#E4E3DE] bg-white flex items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-[#18181B]">
                Compiled Docket Parts List ({items.length} Distinct Part Lines · {totalExpandedParts} Total Pieces)
              </h3>
              {extractedData.extractionMethod === 'ai-vision' ? (
                <span className="font-mono text-[10px] font-semibold text-[#059669] bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>Compiled by Gemini AI</span>
                </span>
              ) : (
                <span className="font-mono text-[10px] font-semibold text-zinc-700 bg-zinc-100 border border-zinc-300 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                  <WifiOff className="w-2.5 h-2.5" />
                  <span>On-Device OCR</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {extractedData.extractionMethod === 'ai-vision'
                ? 'Gemini AI analyzed your docket photo and compiled each individual part and all of its details below.'
                : 'Each individual part and all of its extracted details are compiled below. Document barcodes and headers were excluded.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {attachedPages.length > 0 && (
              <button
                onClick={() => setShowPhotoViewer(!showPhotoViewer)}
                className={`h-7 px-2.5 rounded-[4px] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                  showPhotoViewer
                    ? 'bg-[#18181B] text-white'
                    : 'bg-white border border-[#E4E3DE] text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                {showPhotoViewer ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                <span>{showPhotoViewer ? 'Hide photo' : 'View docket photo'}</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Area: Table Review + Optional Side-by-Side Docket Photo */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left / Main Section: Metadata & Compiled Parts Table */}
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Header Metadata Form */}
            <div className="p-3.5 bg-white border-b border-[#E4E3DE] grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                  Docket / Ref #
                </label>
                <input
                  type="text"
                  value={docketNumber}
                  onChange={(e) => setDocketNumber(e.target.value)}
                  className="w-full h-8 px-2.5 font-mono text-xs font-bold bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] uppercase outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                  Supplier
                </label>
                <input
                  type="text"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs font-semibold bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                  PO / Order #
                </label>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="Optional"
                  className="w-full h-8 px-2.5 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] uppercase outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                  Delivery Date
                </label>
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                  Pallets / Packs
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={palletCount}
                  onChange={(e) => setPalletCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-full h-8 px-2.5 text-xs font-mono bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none"
                />
              </div>
            </div>

            {/* Table Controls & Filter Bar */}
            <div className="px-4 py-2 bg-[#F6F5F2] border-b border-[#E4E3DE] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFilterMode('all')}
                  className={`px-2.5 py-1 rounded-[3px] font-medium transition-colors cursor-pointer ${
                    filterMode === 'all'
                      ? 'bg-[#18181B] text-white'
                      : 'bg-white border border-[#E4E3DE] text-zinc-600 hover:text-[#18181B]'
                  }`}
                >
                  All Individual Parts ({items.length})
                </button>

                {lowConfidenceCount > 0 && (
                  <button
                    onClick={() => setFilterMode('flagged')}
                    className={`px-2.5 py-1 rounded-[3px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                      filterMode === 'flagged'
                        ? 'bg-amber-600 text-white'
                        : 'bg-amber-50 border border-amber-200 text-amber-800'
                    }`}
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                    <span>Flagged ({lowConfidenceCount})</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-zinc-600">
                  <input
                    type="checkbox"
                    checked={expandQuantities}
                    onChange={(e) => setExpandQuantities(e.target.checked)}
                    className="accent-[#059669] rounded-[2px]"
                  />
                  <span>Expand multi-qty rows into individual checkable pieces ({totalExpandedParts} total)</span>
                </label>

                <button
                  onClick={handleAddItem}
                  className="h-7 px-2.5 bg-white border border-[#E4E3DE] hover:bg-zinc-50 rounded-[3px] font-medium text-xs text-[#18181B] flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add part</span>
                </button>
              </div>
            </div>

            {/* Extracted Individual Parts Table with ALL Details */}
            <div className="flex-1 overflow-x-auto bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#F6F5F2] text-[10px] font-mono uppercase text-zinc-500 sticky top-0 border-b border-[#E4E3DE] z-10">
                  <tr>
                    <th
                      className="py-2 px-2.5 w-20 text-center text-[#059669] font-bold"
                      title="The 'No' column on the delivery docket (matched by the numbers after '-' in ######-No barcodes)"
                    >
                      No (######-No)
                    </th>
                    <th className="py-2 px-2.5 min-w-[130px]">Part #</th>
                    <th className="py-2 px-2.5 min-w-[200px]">Part Description</th>
                    <th className="py-2 px-2 min-w-[95px]">Material</th>
                    <th className="py-2 px-2 w-20">Thickness</th>
                    <th className="py-2 px-2 min-w-[105px]">Size / Dim</th>
                    <th className="py-2 px-2 w-16 text-center">Qty</th>
                    <th className="py-2 px-2 w-24">Pallet</th>
                    <th className="py-2 px-2 w-10 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4E3DE]">
                  {filteredItems.map((item) => {
                    const originalIdx = items.indexOf(item);
                    const isFlagged = item.confidence === 'low';

                    return (
                      <tr
                        key={originalIdx}
                        className={`hover:bg-zinc-50/80 transition-colors ${
                          isFlagged ? 'bg-amber-50/30' : ''
                        }`}
                      >
                        {/* Docket "No" Column (matched by numbers after '-' in ######-No barcode) */}
                        <td className="py-1.5 px-2 text-center">
                          <div className="flex items-center gap-1">
                            {attachedPages.length > 1 && item.pageNumber && (
                              <span
                                className="px-1 py-0.5 rounded-[2px] bg-zinc-100 border border-zinc-200 font-mono text-[9px] text-zinc-500 shrink-0"
                                title={`Extracted from Page ${item.pageNumber}`}
                              >
                                P{item.pageNumber}
                              </span>
                            )}
                            <input
                              type="text"
                              value={item.itemNumber}
                              onChange={(e) =>
                                handleItemChange(originalIdx, 'itemNumber', e.target.value)
                              }
                              title="Part 'No' on the delivery docket / invoice (cross-referenced by numbers after '-' in barcode)"
                              className="w-full h-7 px-1.5 text-center font-mono text-xs font-bold text-[#059669] bg-emerald-50/70 border border-emerald-200 hover:border-emerald-400 focus:border-[#059669] rounded-[3px] outline-none"
                            />
                          </div>
                        </td>

                        {/* Part Number */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.partNumber}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'partNumber', e.target.value)
                            }
                            className={`w-full h-7 px-2 font-mono text-xs font-bold uppercase rounded-[3px] outline-none ${
                              isFlagged
                                ? 'bg-amber-50 border border-amber-300 text-amber-900 focus:border-amber-500'
                                : 'bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 text-[#18181B]'
                            }`}
                          />
                        </td>

                        {/* Description */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.description}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'description', e.target.value)
                            }
                            className="w-full h-7 px-2 text-xs text-zinc-800 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Material */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.material || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'material', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Thickness */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.thickness || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'thickness', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Dimensions / Weight */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.dimensions || item.weight || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'dimensions', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-600 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Quantity */}
                        <td className="py-1.5 px-2 text-center">
                          <input
                            type="number"
                            min="1"
                            max="9999"
                            value={item.quantity}
                            onChange={(e) =>
                              handleItemChange(
                                originalIdx,
                                'quantity',
                                Math.max(1, parseInt(e.target.value, 10) || 1)
                              )
                            }
                            className="w-14 h-7 px-1 text-center font-mono text-xs font-bold bg-zinc-50 border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Pallet */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.palletNumber || `Pallet 1`}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'palletNumber', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-500 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Delete action */}
                        <td className="py-1.5 px-2 text-center">
                          <button
                            onClick={() => handleRemoveItem(originalIdx)}
                            className="p-1 text-zinc-300 hover:text-red-600 transition-colors cursor-pointer"
                            title="Delete part row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filteredItems.length === 0 && (
                <div className="py-12 px-4 text-center text-xs text-zinc-500">
                  <p className="font-semibold text-[#18181B] mb-1">
                    No individual parts detected on this page
                  </p>
                  <p className="text-[11px] text-zinc-400 mb-3">
                    Click &quot;Add part&quot; above to add parts manually or re-photograph the parts table section of the docket clearly.
                  </p>
                  <button
                    onClick={handleAddItem}
                    className="h-8 px-3 bg-[#18181B] text-white rounded-[4px] font-medium text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Part Row</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Section: Original Photographed Docket Image Viewer */}
          {showPhotoViewer && attachedPages.length > 0 && (
            <div className="w-80 sm:w-96 border-l border-[#E4E3DE] bg-[#141413] flex flex-col shrink-0">
              <div className="px-3 py-2 bg-black/60 border-b border-white/10 flex items-center justify-between text-xs text-white">
                <span className="font-mono text-[11px]">
                  Page {activePhotoIdx + 1} of {attachedPages.length}
                </span>

                <div className="flex items-center gap-1">
                  {attachedPages.length > 1 && (
                    <>
                      <button
                        onClick={() =>
                          setActivePhotoIdx((prev) =>
                            prev > 0 ? prev - 1 : attachedPages.length - 1
                          )
                        }
                        className="p-1 hover:bg-white/10 rounded cursor-pointer"
                        title="Previous page"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 text-white" />
                      </button>
                      <button
                        onClick={() =>
                          setActivePhotoIdx((prev) =>
                            prev < attachedPages.length - 1 ? prev + 1 : 0
                          )
                        }
                        className="p-1 hover:bg-white/10 rounded cursor-pointer"
                        title="Next page"
                      >
                        <ChevronRight className="w-3.5 h-3.5 text-white" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setShowPhotoViewer(false)}
                    className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white cursor-pointer ml-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-2 flex items-center justify-center">
                <img
                  src={attachedPages[activePhotoIdx].dataUrl}
                  alt={`Docket Page ${activePhotoIdx + 1}`}
                  className="max-w-full max-h-full object-contain rounded-[2px]"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Confirmation Bar */}
        <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-zinc-500 font-mono">
            <span>{items.length} part lines</span>
            <span className="mx-1.5 text-zinc-300">·</span>
            <span className="font-semibold text-[#18181B]">
              {expandQuantities ? totalExpandedParts : items.length} parts in compiled checklist
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-9 px-3.5 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>

            <button
              onClick={handleConfirmImport}
              disabled={items.length === 0}
              className="h-9 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>
                Import Compiled List ({expandQuantities ? totalExpandedParts : items.length} Parts)
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
