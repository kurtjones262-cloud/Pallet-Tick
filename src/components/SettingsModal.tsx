import React, { useState } from 'react';
import {
  RotateCcw,
  X,
  Trash2,
  Archive,
  Download,
  Loader2,
} from 'lucide-react';
import { AppSettings } from '../types/delivery';
import {
  getStoredSettings,
  saveStoredSettings,
  saveStoredDeliveries,
  setActiveDeliveryId,
  clearAllDeliveries,
} from '../utils/storage';
import { generate200PartDelivery } from '../utils/sampleData';
import { playAudio, triggerHaptic } from '../utils/audioFeedback';
import { exportAllDeliveriesBackupZip } from '../utils/zipExport';

interface SettingsModalProps {
  onClose: () => void;
  onSettingsSaved: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  onClose,
  onSettingsSaved,
}) => {
  const [settings, setSettings] = useState<AppSettings>(getStoredSettings());
  const [resetDone, setResetDone] = useState(false);
  const [isBackingUpZip, setIsBackingUpZip] = useState(false);
  const [isDownloadingSource, setIsDownloadingSource] = useState(false);

  const handleToggle = (field: keyof AppSettings) => {
    const next = { ...settings, [field]: !settings[field] };
    setSettings(next);
    saveStoredSettings(next);
    onSettingsSaved();

    if (field === 'soundEnabled' && next.soundEnabled) {
      playAudio.success();
    }
    if (field === 'vibrationEnabled' && next.vibrationEnabled) {
      triggerHaptic('success');
    }
  };

  const handleClearAll = () => {
    if (confirm('Clear all deliveries and reset to a completely fresh app?')) {
      clearAllDeliveries();
      onSettingsSaved();
      onClose();
    }
  };

  const handleBackupAllZip = async () => {
    setIsBackingUpZip(true);
    try {
      await exportAllDeliveriesBackupZip();
    } catch (err) {
      console.error('Backup zip failed:', err);
    } finally {
      setIsBackingUpZip(false);
    }
  };

  const handleDownloadSourceZip = () => {
    setIsDownloadingSource(true);
    const link = document.createElement('a');
    link.href = '/api/export-project-zip';
    link.download = 'pallettick-app-source.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => setIsDownloadingSource(false), 1500);
  };

  const handleLoadSampleData = () => {
    if (confirm('Load 200-part laser cutting delivery (6 pallets) for testing?')) {
      const sample = [generate200PartDelivery()];
      saveStoredDeliveries(sample);
      setActiveDeliveryId(sample[0].id);
      setResetDone(true);
      setTimeout(() => {
        setResetDone(false);
        onSettingsSaved();
        onClose();
      }, 300);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-[#F6F5F2] border-t sm:border border-[#E4E3DE] sm:rounded-[6px] shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#E4E3DE] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/pallettrack-icon.png"
              alt="PalletTick"
              className="w-5 h-5 rounded-[4px] object-cover shadow-2xs"
            />
            <h3 className="font-semibold text-sm text-[#18181B]">PalletTick Settings</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-white divide-y divide-[#E4E3DE] border-b border-[#E4E3DE] text-xs">
          <label className="px-4 py-3 flex items-center justify-between cursor-pointer">
            <div>
              <span className="font-medium text-[#18181B] block">Sound feedback</span>
              <span className="text-[11px] text-zinc-500">Audio chime on scan match</span>
            </div>
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={() => handleToggle('soundEnabled')}
              className="w-4 h-4 accent-[#059669] cursor-pointer"
            />
          </label>

          <label className="px-4 py-3 flex items-center justify-between cursor-pointer">
            <div>
              <span className="font-medium text-[#18181B] block">Haptic vibration</span>
              <span className="text-[11px] text-zinc-500">Vibrate on scan confirmation</span>
            </div>
            <input
              type="checkbox"
              checked={settings.vibrationEnabled}
              onChange={() => handleToggle('vibrationEnabled')}
              className="w-4 h-4 accent-[#059669] cursor-pointer"
            />
          </label>

          <label className="px-4 py-3 flex items-center justify-between cursor-pointer">
            <div>
              <span className="font-medium text-[#18181B] block">Voice announcements</span>
              <span className="text-[11px] text-zinc-500">Speak part numbers aloud</span>
            </div>
            <input
              type="checkbox"
              checked={settings.speechEnabled}
              onChange={() => handleToggle('speechEnabled')}
              className="w-4 h-4 accent-[#059669] cursor-pointer"
            />
          </label>

          <div className="px-4 py-3 flex items-center justify-between">
            <span className="font-medium text-[#18181B]">Default camera</span>
            <div className="flex items-center border border-[#E4E3DE] rounded-[4px] overflow-hidden">
              <button
                onClick={() => {
                  const next = { ...settings, preferredCamera: 'environment' as const };
                  setSettings(next);
                  saveStoredSettings(next);
                  onSettingsSaved();
                }}
                className={`px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                  settings.preferredCamera === 'environment'
                    ? 'bg-[#18181B] text-white'
                    : 'bg-white text-zinc-600'
                }`}
              >
                Rear
              </button>
              <button
                onClick={() => {
                  const next = { ...settings, preferredCamera: 'user' as const };
                  setSettings(next);
                  saveStoredSettings(next);
                  onSettingsSaved();
                }}
                className={`px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                  settings.preferredCamera === 'user'
                    ? 'bg-[#18181B] text-white'
                    : 'bg-white text-zinc-600'
                }`}
              >
                Front
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-2 border-t border-[#E4E3DE]">
          <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Export & Backup
          </div>

          <button
            onClick={handleBackupAllZip}
            disabled={isBackingUpZip}
            className="w-full h-9 px-3 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-700 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            {isBackingUpZip ? (
              <Loader2 className="w-3.5 h-3.5 text-[#059669] animate-spin" />
            ) : (
              <Archive className="w-3.5 h-3.5 text-zinc-500" />
            )}
            <span>{isBackingUpZip ? 'Packaging backup...' : 'Backup all deliveries (.zip)'}</span>
          </button>

          <button
            onClick={handleDownloadSourceZip}
            disabled={isDownloadingSource}
            className="w-full h-9 px-3 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-700 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            {isDownloadingSource ? (
              <Loader2 className="w-3.5 h-3.5 text-[#059669] animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5 text-zinc-500" />
            )}
            <span>{isDownloadingSource ? 'Compressing source...' : 'Download app source code (.zip)'}</span>
          </button>

          <div className="pt-2 border-t border-[#E4E3DE]" />

          <button
            onClick={handleClearAll}
            className="w-full h-9 px-3 rounded-[4px] border border-red-200 bg-red-50/50 hover:bg-red-50 text-xs font-semibold text-red-700 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear all deliveries (Fresh app)</span>
          </button>

          <button
            onClick={handleLoadSampleData}
            disabled={resetDone}
            className="w-full h-9 px-3 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-600 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{resetDone ? 'Loading...' : 'Load 200-part demo docket'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
