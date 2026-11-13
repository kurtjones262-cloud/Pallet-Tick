import React, { useState, useMemo } from 'react';
import {
  FolderKanban,
  Plus,
  QrCode,
  Printer,
  Trash2,
  Edit3,
  Check,
  X,
  ArrowLeft,
  Layers,
  CheckCircle2,
  Clock,
  ArrowUpRight,
  AlertTriangle,
  Search,
  Unlink,
} from 'lucide-react';
import { Delivery, DocketGroup, UserRole } from '../types/delivery';
import { getPartVerificationState } from '../utils/storage';
import {
  apiCreateGroup,
  apiUpdateGroup,
  apiDeleteGroup,
  apiAddDocketsToGroup,
  apiRemoveDocketFromGroup,
} from '../services/palletTrackApi';
import { exportGroupPdf } from '../utils/pdfExport';

interface DocketGroupsViewProps {
  groups: DocketGroup[];
  deliveries: Delivery[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
  onGroupsChanged: (nextGroups: DocketGroup[]) => void;
  onOpenDelivery: (delivery: Delivery) => void;
  onScanGroup: (groupId: string) => void;
  userRole?: UserRole;
}

export const DocketGroupsView: React.FC<DocketGroupsViewProps> = ({
  groups,
  deliveries,
  selectedGroupId,
  onSelectGroup,
  onGroupsChanged,
  onOpenDelivery,
  onScanGroup,
}) => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSelectedIds, setNewGroupSelectedIds] = useState<string[]>([]);
  const [createDocketSearch, setCreateDocketSearch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Detail state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [isAddDocketsModalOpen, setIsAddDocketsModalOpen] = useState(false);
  const [addSelectedIds, setAddSelectedIds] = useState<string[]>([]);
  const [addSearch, setAddSearch] = useState('');
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<DocketGroup | null>(null);

  const deliveryMap = useMemo(() => {
    const map = new Map<string, Delivery>();
    deliveries.forEach((d) => map.set(d.id, d));
    return map;
  }, [deliveries]);

  const computeGroupStats = (group: DocketGroup) => {
    const memberDeliveries = (group.deliveryIds || [])
      .map((id) => deliveryMap.get(id))
      .filter((d): d is Delivery => Boolean(d));

    let totalParts = 0;
    let receivedParts = 0;
    let requiredUnits = 0;
    let receivedUnits = 0;
    let completedDockets = 0;

    memberDeliveries.forEach((del) => {
      const parts = del.parts || [];
      let delReceived = 0;
      parts.forEach((p) => {
        totalParts += 1;
        const vState = getPartVerificationState(p);
        requiredUnits += vState.requiredQty;
        receivedUnits += vState.receivedQty;
        if (p.status === 'received' || vState.receivedQty >= vState.requiredQty) {
          receivedParts += 1;
          delReceived += 1;
        }
      });
      if (del.status === 'completed' || (parts.length > 0 && delReceived === parts.length)) {
        completedDockets += 1;
      }
    });

    const pct = totalParts > 0 ? Math.round((receivedParts / totalParts) * 100) : 0;
    return {
      memberDeliveries,
      docketCount: memberDeliveries.length,
      completedDockets,
      totalParts,
      receivedParts,
      requiredUnits,
      receivedUnits,
      pct,
    };
  };

  const selectedGroup = useMemo(
    () => (selectedGroupId ? groups.find((g) => g.id === selectedGroupId) || null : null),
    [groups, selectedGroupId]
  );

  const selectedStats = useMemo(
    () => (selectedGroup ? computeGroupStats(selectedGroup) : null),
    [selectedGroup, deliveryMap]
  );

  const availableDeliveriesForAdd = useMemo(() => {
    if (!selectedGroup) return [];
    const existingSet = new Set(selectedGroup.deliveryIds || []);
    return deliveries.filter((d) => {
      if (existingSet.has(d.id)) return false;
      if (!addSearch.trim()) return true;
      const q = addSearch.trim().toLowerCase();
      return (
        d.docketNumber.toLowerCase().includes(q) ||
        d.supplier.toLowerCase().includes(q)
      );
    });
  }, [deliveries, selectedGroup, addSearch]);

  const filteredCreateDeliveries = useMemo(() => {
    if (!createDocketSearch.trim()) return deliveries;
    const q = createDocketSearch.trim().toLowerCase();
    return deliveries.filter(
      (d) =>
        d.docketNumber.toLowerCase().includes(q) ||
        d.supplier.toLowerCase().includes(q)
    );
  }, [deliveries, createDocketSearch]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newGroupName.trim();
    if (!cleanName || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      const created = await apiCreateGroup({
        name: cleanName,
        deliveryIds: newGroupSelectedIds,
      });
      const next = [created, ...groups.filter((g) => g.id !== created.id)];
      onGroupsChanged(next);
      onSelectGroup(created.id);
      setIsCreateModalOpen(false);
      setNewGroupName('');
      setNewGroupSelectedIds([]);
      setCreateDocketSearch('');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to create docket group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveRename = async () => {
    if (!selectedGroup || !renameValue.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      const updated = await apiUpdateGroup(selectedGroup.id, { name: renameValue.trim() });
      onGroupsChanged(groups.map((g) => (g.id === updated.id ? updated : g)));
      setIsRenaming(false);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to rename docket group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDeleteGroup = async () => {
    if (!confirmDeleteGroup || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      await apiDeleteGroup(confirmDeleteGroup.id);
      const next = groups.filter((g) => g.id !== confirmDeleteGroup.id);
      onGroupsChanged(next);
      if (selectedGroupId === confirmDeleteGroup.id) {
        onSelectGroup(null);
      }
      setConfirmDeleteGroup(null);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to delete docket group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddDocketsSubmit = async () => {
    if (!selectedGroup || addSelectedIds.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      const updated = await apiAddDocketsToGroup(selectedGroup.id, addSelectedIds);
      onGroupsChanged(groups.map((g) => (g.id === updated.id ? updated : g)));
      setIsAddDocketsModalOpen(false);
      setAddSelectedIds([]);
      setAddSearch('');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to add dockets to group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveDocket = async (deliveryId: string) => {
    if (!selectedGroup || isSubmitting) return;
    setIsSubmitting(true);
    setErrorBanner(null);
    try {
      const updated = await apiRemoveDocketFromGroup(selectedGroup.id, deliveryId);
      onGroupsChanged(groups.map((g) => (g.id === updated.id ? updated : g)));
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to remove docket from group');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col pb-24">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4 sm:space-y-5">
        {errorBanner && (
          <div className="p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] text-xs font-mono flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="p-1 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* =================================================================
         * VIEW A: GROUP DETAIL VIEW
         * ================================================================= */}
        {selectedGroup && selectedStats ? (
          <>
            <header className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex items-start sm:items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setIsRenaming(false);
                      onSelectGroup(null);
                    }}
                    className="w-9 h-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                    title="Back to Docket Groups"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>

                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename();
                            if (e.key === 'Escape') setIsRenaming(false);
                          }}
                          className="h-9 px-3 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-primary,#A020F0)] text-sm font-bold text-white outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleSaveRename}
                          disabled={isSubmitting || !renameValue.trim()}
                          className="h-9 px-3 rounded-lg bg-[#00D979] text-black font-mono font-bold text-xs cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsRenaming(false)}
                          className="h-9 px-2.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-text-secondary,#A3A8BD)] text-xs font-mono cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="text-lg sm:text-xl font-extrabold text-white tracking-tight">
                          {selectedGroup.name}
                        </h1>
                        <button
                          type="button"
                          onClick={() => {
                            setRenameValue(selectedGroup.name);
                            setIsRenaming(true);
                          }}
                          className="p-1 rounded-md text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white hover:bg-white/10 cursor-pointer"
                          title="Rename group"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <span className="px-2 py-0.5 rounded-md bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[10px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)] uppercase">
                          {selectedStats.docketCount}{' '}
                          {selectedStats.docketCount === 1 ? 'Docket' : 'Dockets'}
                        </span>
                      </div>
                    )}

                    <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                      Combined: {selectedStats.receivedParts} / {selectedStats.totalParts} part lines
                      verified ({selectedStats.pct}%) · {selectedStats.receivedUnits} /{' '}
                      {selectedStats.requiredUnits} units
                    </p>
                  </div>
                </div>

                {/* Group Actions */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={selectedStats.docketCount === 0}
                    onClick={() => onScanGroup(selectedGroup.id)}
                    className="h-10 px-4 rounded-xl pt-btn-primary disabled:opacity-40 font-mono font-extrabold text-xs uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer transition-all"
                    title="Scan barcodes or QR codes across all member dockets in this group"
                  >
                    <QrCode className="w-4 h-4 stroke-[2.4]" />
                    <span>SCAN GROUP</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAddSelectedIds([]);
                      setAddSearch('');
                      setIsAddDocketsModalOpen(true);
                    }}
                    className="h-10 px-3.5 rounded-xl bg-[#00D979]/15 hover:bg-[#00D979]/25 border border-[#00D979]/40 text-[#00D979] font-mono font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    <span>Add Dockets</span>
                  </button>

                  <button
                    type="button"
                    disabled={selectedStats.docketCount === 0}
                    onClick={() => exportGroupPdf(selectedGroup, selectedStats.memberDeliveries)}
                    className="h-10 px-3.5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 disabled:opacity-40 border border-[var(--pt-border,#29243D)] text-white font-mono font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                    <span>Group PDF</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfirmDeleteGroup(selectedGroup)}
                    className="h-10 px-3 rounded-xl bg-[#EF4444]/10 hover:bg-[#EF4444]/20 border border-[#EF4444]/35 text-[#EF4444] font-mono font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    title="Delete group folder (keeps all member dockets)"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Delete Group</span>
                  </button>
                </div>
              </div>

              {/* Combined Group Progress Bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                  <span>
                    Group Completion ({selectedStats.completedDockets}/{selectedStats.docketCount}{' '}
                    dockets complete)
                  </span>
                  <span className="font-bold text-white tabular-nums">{selectedStats.pct}%</span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${selectedStats.pct}%`,
                      backgroundColor:
                        selectedStats.pct === 100 && selectedStats.totalParts > 0
                          ? '#00D979'
                          : 'var(--pt-primary, #A020F0)',
                    }}
                  />
                </div>
              </div>
            </header>

            {/* Member Dockets List */}
            <section className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] overflow-hidden">
              <div className="px-4 py-3 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                  Included Delivery Dockets ({selectedStats.docketCount})
                </span>
                <span className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)]">
                  Member dockets remain independent records
                </span>
              </div>

              {selectedStats.memberDeliveries.length > 0 ? (
                <div className="divide-y divide-[var(--pt-border,#29243D)]">
                  {selectedStats.memberDeliveries.map((del) => {
                    const parts = del.parts || [];
                    const total = parts.length;
                    const received = parts.filter((p) => p.status === 'received').length;
                    const pct = total > 0 ? Math.round((received / total) * 100) : 0;
                    const isDone =
                      del.status === 'completed' || (total > 0 && received === total);

                    return (
                      <div
                        key={del.id}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${
                              isDone
                                ? 'bg-[#00D979]/15 border-[#00D979]/40 text-[#00D979]'
                                : received > 0
                                ? 'bg-[#078BFF]/15 border-[#078BFF]/40 text-[#078BFF]'
                                : 'bg-[#F59E0B]/15 border-[#F59E0B]/40 text-[#F59E0B]'
                            }`}
                          >
                            {isDone ? (
                              <CheckCircle2 className="w-4 h-4" />
                            ) : (
                              <Clock className="w-4 h-4" />
                            )}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-extrabold text-sm text-white">
                                Docket #{del.docketNumber}
                              </span>
                              <span className="text-xs font-bold text-[var(--pt-primary-light,#C084FC)] truncate">
                                {del.supplier}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                              {del.deliveryDate} · {received} / {total} parts ({pct}%)
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => onOpenDelivery(del)}
                            className="h-9 px-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-white inline-flex items-center gap-1 cursor-pointer transition-colors"
                          >
                            <span>Open Docket</span>
                            <ArrowUpRight className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRemoveDocket(del.id)}
                            className="h-9 px-2.5 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[#EF4444]/15 border border-[var(--pt-border,#29243D)] hover:border-[#EF4444]/40 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] text-xs font-mono inline-flex items-center gap-1 cursor-pointer transition-colors"
                            title="Remove docket from group (docket itself is not deleted)"
                          >
                            <Unlink className="w-3.5 h-3.5" />
                            <span className="hidden xs:inline">Remove</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-8 text-center space-y-3">
                  <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                    No dockets in this group yet. Add one or more dockets to start scanning as a batch.
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsAddDocketsModalOpen(true)}
                    className="h-9 px-4 rounded-xl pt-btn-primary text-xs font-mono font-bold uppercase inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Dockets</span>
                  </button>
                </div>
              )}
            </section>
          </>
        ) : (
          /* =================================================================
           * VIEW B: DOCKET GROUPS LIST VIEW
           * ================================================================= */
          <>
            <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-white uppercase font-sans">
                    DOCKET GROUPS
                  </h1>
                  <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)]">
                    {groups.length} {groups.length === 1 ? 'Group' : 'Groups'}
                  </span>
                </div>
                <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                  Manually group selected dockets together for combined scanning and reporting while keeping every docket separate
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setNewGroupName('');
                  setNewGroupSelectedIds([]);
                  setCreateDocketSearch('');
                  setIsCreateModalOpen(true);
                }}
                className="h-11 px-5 rounded-xl pt-btn-primary font-mono font-extrabold text-xs tracking-wider uppercase inline-flex items-center justify-center gap-2 cursor-pointer transition-all shrink-0"
              >
                <Plus className="w-4 h-4 stroke-[2.6]" />
                <span>CREATE GROUP</span>
              </button>
            </header>

            {groups.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {groups.map((group) => {
                  const st = computeGroupStats(group);
                  return (
                    <div
                      key={group.id}
                      onClick={() => onSelectGroup(group.id)}
                      className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] cursor-pointer transition-all flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center shrink-0">
                              <FolderKanban className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                              <h3 className="font-bold text-base text-white truncate">
                                {group.name}
                              </h3>
                              <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                                {st.docketCount} {st.docketCount === 1 ? 'Docket' : 'Dockets'} ·{' '}
                                {st.receivedParts} / {st.totalParts} parts verified
                              </p>
                            </div>
                          </div>

                          <span
                            className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border shrink-0 ${
                              st.pct === 100 && st.totalParts > 0
                                ? 'bg-[#00D979]/15 border-[#00D979]/40 text-[#00D979]'
                                : st.receivedParts > 0
                                ? 'bg-[#078BFF]/15 border-[#078BFF]/40 text-[#078BFF]'
                                : 'bg-[#F59E0B]/15 border-[#F59E0B]/40 text-[#F59E0B]'
                            }`}
                          >
                            {st.pct}%
                          </span>
                        </div>

                        <div className="w-full h-2 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${st.pct}%`,
                              backgroundColor:
                                st.pct === 100 && st.totalParts > 0
                                  ? '#00D979'
                                  : 'var(--pt-primary, #A020F0)',
                            }}
                          />
                        </div>
                      </div>

                      <div
                        className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--pt-border,#29243D)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={st.docketCount === 0}
                            onClick={() => onScanGroup(group.id)}
                            className="h-8 px-3 rounded-lg pt-btn-primary disabled:opacity-40 font-mono font-bold text-[11px] uppercase inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                            <span>SCAN GROUP</span>
                          </button>
                          <button
                            type="button"
                            disabled={st.docketCount === 0}
                            onClick={() => exportGroupPdf(group, st.memberDeliveries)}
                            className="h-8 px-2.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 disabled:opacity-40 border border-[var(--pt-border,#29243D)] text-white text-[11px] font-mono inline-flex items-center gap-1 cursor-pointer"
                            title="Export Combined Group PDF"
                          >
                            <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                            <span>PDF</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteGroup(group)}
                          className="h-8 w-8 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-[#EF4444]/15 border border-[var(--pt-border,#29243D)] hover:border-[#EF4444]/40 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] flex items-center justify-center cursor-pointer transition-colors"
                          title="Delete group (keeps dockets)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-10 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center mx-auto">
                  <FolderKanban className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-white">No Docket Groups Created</h3>
                  <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] max-w-md mx-auto">
                    Create a docket group when workers want to scan multiple selected dockets in one receiving session while keeping each docket as its own independent record.
                  </p>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(true)}
                    className="h-10 px-5 rounded-xl pt-btn-primary font-mono font-bold text-xs uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    <span>CREATE GROUP</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* =================================================================
       * MODAL: CREATE DOCKET GROUP
       * ================================================================= */}
      {isCreateModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setIsCreateModalOpen(false)}
        >
          <form
            onSubmit={handleCreateGroup}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-2xl overflow-hidden flex flex-col max-h-[85dvh]"
          >
            <div className="px-5 py-4 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between">
              <h3 className="font-mono font-bold text-sm uppercase tracking-wider text-white">
                Create Docket Group
              </h3>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              <div>
                <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-bold block mb-1.5">
                  Group Name *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="e.g. Morning Steel Delivery / Truck #4"
                  className="w-full h-11 px-3.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] text-sm text-white outline-none"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-bold">
                    Select Dockets ({newGroupSelectedIds.length} selected)
                  </label>
                </div>

                {deliveries.length > 4 && (
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={createDocketSearch}
                      onChange={(e) => setCreateDocketSearch(e.target.value)}
                      placeholder="Filter dockets..."
                      className="w-full h-9 pl-8 pr-3 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-xs font-mono text-white outline-none"
                    />
                  </div>
                )}

                <div className="max-h-56 overflow-y-auto divide-y divide-[var(--pt-border,#29243D)] rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                  {filteredCreateDeliveries.length > 0 ? (
                    filteredCreateDeliveries.map((del) => {
                      const checked = newGroupSelectedIds.includes(del.id);
                      return (
                        <label
                          key={del.id}
                          className="p-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-white/[0.03]"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setNewGroupSelectedIds((prev) =>
                                  checked
                                    ? prev.filter((id) => id !== del.id)
                                    : [...prev, del.id]
                                )
                              }
                              className="w-4 h-4 accent-[var(--pt-primary,#A020F0)]"
                            />
                            <div className="min-w-0">
                              <div className="font-mono font-bold text-xs text-white truncate">
                                #{del.docketNumber} · {del.supplier}
                              </div>
                              <div className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)]">
                                {del.deliveryDate} · {del.parts?.length || 0} parts
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })
                  ) : (
                    <div className="p-4 text-center text-xs font-mono text-[var(--pt-text-muted,#737B94)]">
                      No dockets available yet. You can create the empty group and add dockets later.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 bg-[var(--pt-bg-secondary,#101321)] border-t border-[var(--pt-border,#29243D)] flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="h-10 px-4 rounded-xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !newGroupName.trim()}
                className="h-10 px-5 rounded-xl pt-btn-primary disabled:opacity-40 text-xs font-mono font-bold uppercase cursor-pointer"
              >
                {isSubmitting ? 'Creating...' : 'Create Group'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* =================================================================
       * MODAL: ADD DOCKETS TO GROUP
       * ================================================================= */}
      {isAddDocketsModalOpen && selectedGroup && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setIsAddDocketsModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-2xl overflow-hidden flex flex-col max-h-[85dvh]"
          >
            <div className="px-5 py-4 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between">
              <h3 className="font-mono font-bold text-sm uppercase tracking-wider text-white">
                Add Dockets to &ldquo;{selectedGroup.name}&rdquo;
              </h3>
              <button
                type="button"
                onClick={() => setIsAddDocketsModalOpen(false)}
                className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3 overflow-y-auto">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  placeholder="Search available dockets..."
                  className="w-full h-9 pl-8 pr-3 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-xs font-mono text-white outline-none"
                />
              </div>

              <div className="max-h-64 overflow-y-auto divide-y divide-[var(--pt-border,#29243D)] rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                {availableDeliveriesForAdd.length > 0 ? (
                  availableDeliveriesForAdd.map((del) => {
                    const checked = addSelectedIds.includes(del.id);
                    return (
                      <label
                        key={del.id}
                        className="p-3 flex items-center gap-2.5 cursor-pointer hover:bg-white/[0.03]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAddSelectedIds((prev) =>
                              checked ? prev.filter((id) => id !== del.id) : [...prev, del.id]
                            )
                          }
                          className="w-4 h-4 accent-[var(--pt-primary,#A020F0)]"
                        />
                        <div className="min-w-0">
                          <div className="font-mono font-bold text-xs text-white truncate">
                            #{del.docketNumber} · {del.supplier}
                          </div>
                          <div className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)]">
                            {del.deliveryDate} · {del.parts?.length || 0} parts
                          </div>
                        </div>
                      </label>
                    );
                  })
                ) : (
                  <div className="p-5 text-center text-xs font-mono text-[var(--pt-text-muted,#737B94)]">
                    All existing dockets are already in this group.
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3.5 bg-[var(--pt-bg-secondary,#101321)] border-t border-[var(--pt-border,#29243D)] flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAddDocketsModalOpen(false)}
                className="h-10 px-4 rounded-xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting || addSelectedIds.length === 0}
                onClick={handleAddDocketsSubmit}
                className="h-10 px-5 rounded-xl pt-btn-primary disabled:opacity-40 text-xs font-mono font-bold uppercase inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>Add {addSelectedIds.length || ''} Dockets</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================
       * MODAL: NON-DESTRUCTIVE DELETE GROUP CONFIRMATION
       * ================================================================= */}
      {confirmDeleteGroup && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setConfirmDeleteGroup(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-[var(--pt-card,#15182A)] border border-[#EF4444]/40 shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-white">
                  Delete Group &ldquo;{confirmDeleteGroup.name}&rdquo;?
                </h3>
                <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1 leading-relaxed">
                  Deleting this group only removes the group folder. All member delivery dockets, parts, and scan history remain completely intact.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteGroup(null)}
                className="h-9 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmDeleteGroup}
                className="h-9 px-4 rounded-xl bg-[#EF4444] hover:bg-red-500 text-white text-xs font-mono font-bold cursor-pointer"
              >
                {isSubmitting ? 'Deleting...' : 'Delete Group Only'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
