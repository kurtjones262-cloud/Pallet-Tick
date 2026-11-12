import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  ShieldAlert,
  UserCheck,
  HardHat,
  Search,
  KeyRound,
  Edit2,
  Trash2,
  X,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Lock,
  Building2,
} from 'lucide-react';
import {
  apiGetUsers,
  apiCreateUser,
  apiUpdateUser,
  apiResetUserPin,
  apiDeleteUser,
} from '../services/palletTrackApi';
import { UserAccount, UserRole } from '../types/delivery';

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserAccount;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({
  isOpen,
  onClose,
  currentUser,
}) => {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sub-modal states
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [resetPinUser, setResetPinUser] = useState<UserAccount | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserAccount | null>(null);

  // Form states for Add / Edit
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('employee');
  const [formPin, setFormPin] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Form state for Reset PIN
  const [newPin, setNewPin] = useState('');

  const isCurrentUserSuperAdmin = currentUser.role === 'super_admin';

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await apiGetUsers();
      setUsers(data);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to load user accounts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadUsers();
    }
  }, [isOpen, loadUsers]);

  if (!isOpen) return null;

  // Filtered users
  const filteredUsers = users.filter((u) => {
    const matchesQuery =
      u.employeeName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.employeeCode.toLowerCase().includes(searchQuery.toLowerCase());
    const normalizedRole = u.role === 'operator' ? 'employee' : u.role;
    const matchesRole = roleFilter === 'all' || normalizedRole === roleFilter;
    return matchesQuery && matchesRole;
  });

  const handleOpenAdd = () => {
    setFormName('');
    setFormCode(`EMP-${Math.floor(100 + Math.random() * 900)}`);
    setFormRole('employee');
    setFormPin('');
    setFormActive(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsAddUserOpen(true);
  };

  const handleOpenEdit = (user: UserAccount) => {
    setEditingUser(user);
    setFormName(user.employeeName);
    setFormCode(user.employeeCode);
    setFormRole(user.role === 'operator' ? 'employee' : user.role);
    setFormActive(user.active);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleOpenResetPin = (user: UserAccount) => {
    setResetPinUser(user);
    setNewPin('');
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitting(true);
    setErrorMessage(null);

    try {
      if (!/^\d{4}$/.test(formPin.trim())) {
        throw new Error('PIN must be exactly 4 numeric digits');
      }

      await apiCreateUser({
        employeeName: formName.trim(),
        employeeCode: formCode.trim().toUpperCase(),
        role: formRole,
        pin: formPin.trim(),
      });

      setSuccessMessage(`Account ${formName} (${formCode.toUpperCase()}) created with role ${formRole.toUpperCase()}.`);
      setIsAddUserOpen(false);
      await loadUsers();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to create account.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setFormSubmitting(true);
    setErrorMessage(null);

    try {
      await apiUpdateUser(editingUser.id, {
        employeeName: formName.trim(),
        employeeCode: formCode.trim().toUpperCase(),
        role: formRole,
        active: formActive,
      });

      setSuccessMessage(`Updated account ${formName}.`);
      setEditingUser(null);
      await loadUsers();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update account.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleResetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPinUser) return;

    setFormSubmitting(true);
    setErrorMessage(null);

    try {
      if (!/^\d{4}$/.test(newPin.trim())) {
        throw new Error('PIN must be exactly 4 numeric digits');
      }

      await apiResetUserPin(resetPinUser.id, newPin.trim());
      setSuccessMessage(`PIN reset successfully for ${resetPinUser.employeeName}. Active sessions revoked.`);
      setResetPinUser(null);
      await loadUsers();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to reset PIN.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDeleteSubmit = async () => {
    if (!deletingUser) return;
    setFormSubmitting(true);
    setErrorMessage(null);

    try {
      await apiDeleteUser(deletingUser.id);
      setSuccessMessage(`Account deleted while preserving all historical scan records.`);
      setDeletingUser(null);
      await loadUsers();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to delete account.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const getRoleBadge = (role: UserRole) => {
    switch (role) {
      case 'super_admin':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-amber-950/80 border border-amber-500/40 text-amber-300">
            <ShieldAlert className="w-3 h-3 text-amber-400" />
            SUPER ADMIN
          </span>
        );
      case 'admin':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-[rgba(var(--pt-accent-rgb),0.16)] border border-[var(--pt-accent)] text-[var(--pt-accent-bright)]">
            <Shield className="w-3 h-3 text-[var(--pt-accent-bright)]" />
            ADMIN
          </span>
        );
      case 'supervisor':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-[#078BFF]/15 border border-[#078BFF]/40 text-[#38BDF8]">
            <UserCheck className="w-3 h-3 text-[#38BDF8]" />
            SUPERVISOR
          </span>
        );
      case 'employee':
      case 'operator':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979]">
            <HardHat className="w-3 h-3 text-[#00D979]" />
            EMPLOYEE
          </span>
        );
    }
  };

  const availableRolesForAssignment: Array<{ role: UserRole; label: string; desc: string }> = [
    { role: 'employee', label: 'Employee', desc: 'Scanning & workshop' },
    { role: 'supervisor', label: 'Supervisor', desc: 'Orders & operations' },
    { role: 'admin', label: 'Admin', desc: 'Manage users & orders' },
    ...(isCurrentUserSuperAdmin
      ? [{ role: 'super_admin' as UserRole, label: 'Super Admin', desc: 'Unrestricted access' }]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-4xl max-h-[90vh] bg-[var(--pt-surface)] border border-[var(--pt-border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 bg-[var(--pt-bg)] border-b border-[var(--pt-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[rgba(var(--pt-accent-rgb),0.14)] border border-[var(--pt-accent)] flex items-center justify-center text-[var(--pt-accent-bright)] shadow-[0_0_16px_rgba(var(--pt-accent-rgb),0.25)]">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-white font-mono uppercase tracking-wide">
                  User & Role Management
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded-lg bg-[rgba(var(--pt-accent-rgb),0.16)] border border-[var(--pt-accent)] text-[var(--pt-accent-bright)] font-mono font-bold">
                  4-TIER RBAC
                </span>
              </div>
              <p className="text-xs text-[#9E97B8] font-sans">
                Manage Super Admin, Admin, Supervisor, and Employee accounts, PINs, and audit trails.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-[#9E97B8] hover:text-white hover:bg-white/5 flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Notifications */}
        {errorMessage && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-red-200 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-[#EF4444]" />
            <span>{errorMessage}</span>
          </div>
        )}
        {successMessage && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-[#00D979]/15 border border-[#00D979]/40 text-emerald-200 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-[#00D979]" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Toolbar: Search, Filters, Add Button */}
        <div className="p-4 sm:px-5 border-b border-[var(--pt-border)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0 bg-[var(--pt-card)]/60">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-[#6B6485]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or identifier..."
                className="w-full pl-9 pr-3 py-1.5 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-[var(--pt-accent)] placeholder:text-[#6B6485]"
              />
            </div>

            {/* Role Filter Tabs */}
            <div className="flex items-center gap-1 bg-[var(--pt-bg)] p-1 rounded-xl border border-[var(--pt-border)]">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'super_admin', label: 'Super Admin' },
                  { id: 'admin', label: 'Admin' },
                  { id: 'supervisor', label: 'Supervisor' },
                  { id: 'employee', label: 'Employee' },
                ] as const
              ).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRoleFilter(r.id as 'all' | UserRole)}
                  className={`px-2 py-1 text-[10px] font-mono font-bold uppercase rounded-lg cursor-pointer transition-colors ${
                    roleFilter === r.id
                      ? 'bg-[rgba(var(--pt-accent-rgb),0.2)] text-[var(--pt-accent-bright)] border border-[var(--pt-accent)]'
                      : 'text-[#9E97B8] hover:text-white'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={handleOpenAdd}
            className="px-4 py-2 rounded-xl pt-btn-primary font-bold font-mono text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5 shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Account</span>
          </button>
        </div>

        {/* Employee Accounts Table */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center text-[#9E97B8] gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--pt-accent-bright)]" />
              <span className="text-xs font-mono">Loading accounts...</span>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="py-12 text-center text-[#6B6485] font-mono text-xs">
              No accounts found matching "{searchQuery}".
            </div>
          ) : (
            <div className="border border-[var(--pt-border)] rounded-2xl overflow-hidden bg-[var(--pt-bg)]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[var(--pt-card)] border-b border-[var(--pt-border)] text-[10px] font-mono uppercase text-[#9E97B8] tracking-wider">
                    <th className="py-3 px-3.5">Account / Identifier</th>
                    <th className="py-3 px-3">Role</th>
                    <th className="py-3 px-3 hidden sm:table-cell">Company / Site</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3 hidden md:table-cell">Audit & Activity</th>
                    <th className="py-3 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--pt-border)]/60">
                  {filteredUsers.map((u) => {
                    const isSelf = u.id === currentUser.id;
                    const isTargetSuperAdmin = u.role === 'super_admin';
                    // Admins cannot edit, reset PIN, or delete a Super Admin
                    const canModifyTarget = isCurrentUserSuperAdmin || !isTargetSuperAdmin;

                    return (
                      <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 px-3.5">
                          <div className="font-bold text-white flex items-center gap-2">
                            <span>{u.employeeName}</span>
                            {isSelf && (
                              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(var(--pt-accent-rgb),0.2)] text-[var(--pt-accent-bright)] border border-[var(--pt-accent)]">
                                YOU
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-[var(--pt-accent-bright)] tracking-wider">
                            {u.employeeCode}
                          </div>
                        </td>

                        <td className="py-3 px-3 whitespace-nowrap">{getRoleBadge(u.role)}</td>

                        <td className="py-3 px-3 hidden sm:table-cell whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5 text-[11px] text-[#9E97B8] font-mono">
                            <Building2 className="w-3.5 h-3.5 text-[var(--pt-accent-bright)]" />
                            <span>Main Manufacturing Facility · WH-01</span>
                          </div>
                        </td>

                        <td className="py-3 px-3 whitespace-nowrap">
                          {u.active ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#00D979] font-mono font-bold">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#00D979]" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#EF4444] font-mono font-bold">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444]" />
                              Deactivated
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-3 hidden md:table-cell text-[#9E97B8] font-mono text-[11px]">
                          <div>
                            <span className="text-white font-bold">{u.totalScans || 0}</span> scans
                            {u.createdAt && (
                              <span className="text-[#6B6485] text-[10px] ml-2">
                                · Created {new Date(u.createdAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[#6B6485] truncate max-w-[200px]">
                            {u.lastLoginAt
                              ? `Last login: ${new Date(u.lastLoginAt).toLocaleDateString()}`
                              : 'Never logged in'}
                          </div>
                        </td>

                        <td className="py-3 px-3 text-right whitespace-nowrap">
                          {canModifyTarget ? (
                            <div className="flex items-center justify-end gap-1.5">
                              {/* Reset PIN */}
                              <button
                                type="button"
                                onClick={() => handleOpenResetPin(u)}
                                title="Reset 4-digit PIN"
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-[rgba(var(--pt-accent-rgb),0.2)] hover:text-[var(--pt-accent-bright)] text-[#9E97B8] transition-colors cursor-pointer"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>

                              {/* Edit */}
                              <button
                                type="button"
                                onClick={() => handleOpenEdit(u)}
                                title="Edit account & role"
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white text-[#9E97B8] transition-colors cursor-pointer"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>

                              {/* Delete (if not self) */}
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => setDeletingUser(u)}
                                  title="Delete account"
                                  className="p-1.5 rounded-lg bg-white/5 hover:bg-[#EF4444]/20 hover:text-[#EF4444] text-[#9E97B8] transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] font-mono text-amber-400/70">
                              Protected Super Admin
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-[var(--pt-bg)] border-t border-[var(--pt-border)] flex items-center justify-between text-xs font-mono text-[#9E97B8] shrink-0">
          <div>
            Total Accounts: <span className="text-white font-bold">{users.length}</span> · Admins:{' '}
            <span className="text-[var(--pt-accent-bright)] font-bold">
              {users.filter((u) => u.role === 'super_admin' || u.role === 'admin').length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-[var(--pt-card)] hover:bg-white/10 border border-[var(--pt-border)] text-white cursor-pointer font-mono text-xs uppercase font-bold"
          >
            Close
          </button>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* SUB-MODAL: Add Account Form */}
        {/* ------------------------------------------------------------- */}
        {isAddUserOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md bg-[var(--pt-surface)] border border-[var(--pt-border)] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[var(--pt-border)]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-[var(--pt-accent-bright)]" />
                  Create User Account
                </h3>
                <button
                  onClick={() => setIsAddUserOpen(false)}
                  className="text-[#9E97B8] hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Michael Harris"
                    className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-[var(--pt-accent)]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Unique Employee Identifier
                  </label>
                  <input
                    type="text"
                    required
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    placeholder="e.g. EMP-105 or ADMIN-02"
                    className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-mono text-xs uppercase focus:outline-none focus:border-[var(--pt-accent)]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Role & Permissions
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {availableRolesForAssignment.map((r) => (
                      <button
                        key={r.role}
                        type="button"
                        onClick={() => setFormRole(r.role)}
                        className={`p-2 rounded-xl text-left border cursor-pointer transition-all ${
                          formRole === r.role
                            ? 'bg-[rgba(var(--pt-accent-rgb),0.16)] border-[var(--pt-accent)] text-white'
                            : 'bg-[var(--pt-bg)] border-[var(--pt-border)] text-[#9E97B8] hover:text-white'
                        }`}
                      >
                        <div className="text-[11px] font-mono font-bold uppercase">{r.label}</div>
                        <div className="text-[9px] text-[#6B6485] mt-0.5">{r.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    4-Digit Security PIN
                  </label>
                  <div className="relative">
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      required
                      value={formPin}
                      onChange={(e) => setFormPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="••••"
                      className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-[var(--pt-accent)]"
                    />
                    <Lock className="absolute left-3 top-2.5 w-4 h-4 text-[#6B6485] pointer-events-none" />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAddUserOpen(false)}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--pt-border)] text-[#9E97B8] hover:text-white font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting || formPin.length !== 4}
                    className="px-4 py-1.5 rounded-xl pt-btn-primary font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
                  >
                    {formSubmitting ? 'Creating...' : 'Create Account'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* SUB-MODAL: Edit Account */}
        {/* ------------------------------------------------------------- */}
        {editingUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md bg-[var(--pt-surface)] border border-[var(--pt-border)] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[var(--pt-border)]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <Edit2 className="w-4 h-4 text-[var(--pt-accent-bright)]" />
                  Edit Account: {editingUser.employeeName}
                </h3>
                <button
                  onClick={() => setEditingUser(null)}
                  className="text-[#9E97B8] hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-[var(--pt-accent)]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Employee Identifier
                  </label>
                  <input
                    type="text"
                    required
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-mono text-xs uppercase focus:outline-none focus:border-[var(--pt-accent)]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    Role & Permissions
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {availableRolesForAssignment.map((r) => (
                      <button
                        key={r.role}
                        type="button"
                        onClick={() => setFormRole(r.role)}
                        className={`p-2 rounded-xl text-left border cursor-pointer transition-all ${
                          formRole === r.role
                            ? 'bg-[rgba(var(--pt-accent-rgb),0.16)] border-[var(--pt-accent)] text-white'
                            : 'bg-[var(--pt-bg)] border-[var(--pt-border)] text-[#9E97B8] hover:text-white'
                        }`}
                      >
                        <div className="text-[11px] font-mono font-bold uppercase">{r.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Active switch */}
                <div className="pt-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formActive}
                      onChange={(e) => setFormActive(e.target.checked)}
                      className="w-4 h-4 rounded accent-[var(--pt-accent)] bg-[var(--pt-bg)] border-[var(--pt-border)]"
                    />
                    <span className="text-xs font-mono text-white">
                      Account Active (Uncheck to immediately deactivate and revoke access)
                    </span>
                  </label>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--pt-border)] text-[#9E97B8] hover:text-white font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting}
                    className="px-4 py-1.5 rounded-xl pt-btn-primary font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
                  >
                    {formSubmitting ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* SUB-MODAL: Reset 4-digit PIN */}
        {/* ------------------------------------------------------------- */}
        {resetPinUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-sm bg-[var(--pt-surface)] border border-[var(--pt-border)] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[var(--pt-border)]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[var(--pt-accent-bright)]" />
                  Reset PIN
                </h3>
                <button
                  onClick={() => setResetPinUser(null)}
                  className="text-[#9E97B8] hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleResetPinSubmit} className="space-y-4">
                <p className="text-xs text-[#9E97B8]">
                  Enter a new 4-digit PIN for{' '}
                  <strong className="text-[var(--pt-accent-bright)]">{resetPinUser.employeeName}</strong> (
                  {resetPinUser.employeeCode}). Any current lockouts will be lifted and active sessions revoked.
                </p>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-[#9E97B8] mb-1">
                    New 4-Digit Security PIN
                  </label>
                  <div className="relative">
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      required
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="••••"
                      className="w-full px-3 py-2 bg-[var(--pt-bg)] border border-[var(--pt-border)] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-[var(--pt-accent)]"
                    />
                    <Lock className="absolute left-3 top-2.5 w-4 h-4 text-[#6B6485] pointer-events-none" />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setResetPinUser(null)}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--pt-border)] text-[#9E97B8] hover:text-white font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting || newPin.length !== 4}
                    className="px-4 py-1.5 rounded-xl pt-btn-primary font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
                  >
                    {formSubmitting ? 'Resetting...' : 'Update PIN'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* SUB-MODAL: Delete Employee Confirmation */}
        {/* ------------------------------------------------------------- */}
        {deletingUser && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-sm bg-[var(--pt-surface)] border border-[#EF4444]/40 rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center gap-2.5 text-[#EF4444] text-sm font-bold font-mono uppercase mb-3">
                <AlertTriangle className="w-5 h-5" />
                Delete Account?
              </div>

              <p className="text-xs text-[#9E97B8] leading-relaxed mb-4">
                Are you sure you want to delete{' '}
                <strong className="text-white">{deletingUser.employeeName}</strong> (
                {deletingUser.employeeCode})?
              </p>

              <div className="p-3 rounded-xl bg-[rgba(var(--pt-accent-rgb),0.12)] border border-[var(--pt-accent)]/40 text-white text-[11px] mb-4">
                <strong>Audit preservation notice:</strong> All historical scan events and receiving timestamps will be preserved with {deletingUser.employeeName}'s name and role snapshot intact.
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeletingUser(null)}
                  className="px-3.5 py-1.5 rounded-xl border border-[var(--pt-border)] text-[#9E97B8] hover:text-white font-mono text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteSubmit}
                  disabled={formSubmitting}
                  className="px-4 py-1.5 rounded-xl bg-[#EF4444] hover:bg-red-500 text-white font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
                >
                  {formSubmitting ? 'Deleting...' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
