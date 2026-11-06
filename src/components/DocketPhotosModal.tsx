import React, { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, FileText, Download } from 'lucide-react';
import { Delivery } from '../types/delivery';
import { getDocketImagesForDelivery, StoredDocketImage } from '../utils/indexedDb';

interface DocketPhotosModalProps {
  delivery: Delivery;
  onClose: () => void;
}

export const DocketPhotosModal: React.FC<DocketPhotosModalProps> = ({
  delivery,
  onClose,
}) => {
  const [images, setImages] = useState<Array<{ pageNumber: number; dataUrl: string; name: string }>>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadImages() {
      // 1. Check IndexedDB first for full-resolution photos
      const fromDb = await getDocketImagesForDelivery(delivery.id);
      if (fromDb && fromDb.length > 0) {
        setImages(fromDb);
        setLoading(false);
        return;
      }

      // 2. Fallback to delivery.docketAttachments
      if (delivery.docketAttachments && delivery.docketAttachments.length > 0) {
        const mapped = delivery.docketAttachments.map((att, idx) => ({
          pageNumber: idx + 1,
          dataUrl: att.dataUrl || '',
          name: att.name || `Page ${idx + 1}`,
        })).filter((it) => Boolean(it.dataUrl));
        setImages(mapped);
      }
      setLoading(false);
    }

    loadImages();
  }, [delivery]);

  const currentImage = images[activeIdx];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[92dvh] bg-[#141413] border border-white/10 rounded-[6px] shadow-2xl flex flex-col overflow-hidden text-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-black/60 border-b border-white/10 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              <h3 className="font-bold text-xs sm:text-sm font-mono truncate">
                {delivery.docketNumber} — {delivery.supplier}
              </h3>
            </div>
            <p className="text-[11px] text-zinc-400 font-mono mt-0.5">
              Original Photographed Delivery Docket
              {images.length > 0 && ` · Page ${activeIdx + 1} of ${images.length}`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {currentImage && (
              <a
                href={currentImage.dataUrl}
                download={`${delivery.docketNumber}_page${activeIdx + 1}.jpg`}
                className="h-7 px-2.5 rounded-[4px] bg-white/15 hover:bg-white/25 text-white text-xs font-medium inline-flex items-center gap-1 cursor-pointer transition-colors"
                title="Download photo"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden xs:inline">Save</span>
              </a>
            )}

            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Image Canvas / Viewport */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center relative bg-black/40">
          {loading ? (
            <div className="text-center text-xs text-zinc-400">
              Loading docket photo...
            </div>
          ) : images.length === 0 ? (
            <div className="text-center text-xs text-zinc-400 max-w-xs">
              No photo attached to this delivery docket.
            </div>
          ) : (
            <img
              src={currentImage?.dataUrl}
              alt={`Docket Page ${activeIdx + 1}`}
              className="max-w-full max-h-full object-contain rounded-[2px] shadow-lg select-none"
            />
          )}

          {/* Navigation Controls */}
          {images.length > 1 && (
            <>
              <button
                onClick={() =>
                  setActiveIdx((prev) => (prev > 0 ? prev - 1 : images.length - 1))
                }
                className="absolute left-3 p-2 rounded-full bg-black/60 hover:bg-black/90 text-white cursor-pointer border border-white/10"
                title="Previous page"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>

              <button
                onClick={() =>
                  setActiveIdx((prev) => (prev < images.length - 1 ? prev + 1 : 0))
                }
                className="absolute right-3 p-2 rounded-full bg-black/60 hover:bg-black/90 text-white cursor-pointer border border-white/10"
                title="Next page"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}
        </div>

        {/* Footer Thumbnails (if multi-page) */}
        {images.length > 1 && (
          <div className="px-4 py-2.5 bg-black/70 border-t border-white/10 flex items-center gap-2 overflow-x-auto shrink-0">
            {images.map((img, idx) => (
              <button
                key={idx}
                onClick={() => setActiveIdx(idx)}
                className={`relative w-12 h-16 rounded overflow-hidden border cursor-pointer shrink-0 transition-all ${
                  activeIdx === idx
                    ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                    : 'border-white/20 opacity-60 hover:opacity-100'
                }`}
              >
                <img
                  src={img.dataUrl}
                  alt={`Thumbnail ${idx + 1}`}
                  className="w-full h-full object-cover"
                />
                <span className="absolute bottom-0 inset-x-0 bg-black/80 text-[9px] font-mono text-center">
                  P{idx + 1}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
