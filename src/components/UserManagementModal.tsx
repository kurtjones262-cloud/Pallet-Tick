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
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-amber-950/80 border border-amber-500/40 text-amber-300">
            <ShieldAlert className="w-3 h-3 text-amber-400" />
            Super Admin
          </span>
        );
      case 'admin':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-indigo-950/80 border border-indigo-500/40 text-indigo-300">
            <Shield className="w-3 h-3 text-indigo-400" />
            Admin
          </span>
        );
      case 'supervisor':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-cyan-950/80 border border-cyan-500/40 text-cyan-300">
            <UserCheck className="w-3 h-3 text-cyan-400" />
            Supervisor
          </span>
        );
      case 'employee':
      case 'operator':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-emerald-950/80 border border-emerald-500/40 text-emerald-300">
            <HardHat className="w-3 h-3 text-emerald-400" />
            Employee
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-4xl max-h-[90vh] bg-[#0E1626] border border-[#1E2D44] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 bg-[#070A0F] border-b border-[#1E2D44] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-[0_0_12px_rgba(0,168,255,0.2)]">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white font-mono uppercase tracking-wide">
                  User & Role Management
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-950 border border-indigo-500/40 text-indigo-300 font-mono font-bold">
                  MULTI-ADMIN RBAC
                </span>
              </div>
              <p className="text-xs text-slate-400 font-sans">
                Manage Super Admin, Admin, Supervisor, and Employee accounts, PINs, and audit trails.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Notifications */}
        {errorMessage && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMessage}</span>
          </div>
        )}
        {successMessage && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Toolbar: Search, Filters, Add Button */}
        <div className="p-4 sm:px-5 border-b border-[#1E2D44] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0 bg-[#0A0F1A]/50">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or identifier..."
                className="w-full pl-9 pr-3 py-1.5 bg-[#070A0F] border border-[#1E2D44] rounded-lg text-white font-sans text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 placeholder:text-slate-600"
              />
            </div>

            {/* Role Filter Tabs */}
            <div className="flex items-center gap-1 bg-[#070A0F] p-1 rounded-lg border border-[#1E2D44]">
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
                  className={`px-2 py-1 text-[10px] font-mono font-bold uppercase rounded cursor-pointer transition-colors ${
                    roleFilter === r.id
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'text-slate-400 hover:text-slate-200'
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
            className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs uppercase tracking-wider transition-all cursor-pointer shadow-[0_0_12px_rgba(0,168,255,0.3)] flex items-center justify-center gap-1.5 shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Account</span>
          </button>
        </div>

        {/* Employee Accounts Table */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
              <span className="text-xs font-mono">Loading accounts...</span>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="py-12 text-center text-slate-500 font-mono text-xs">
              No accounts found matching "{searchQuery}".
            </div>
          ) : (
            <div className="border border-[#1E2D44] rounded-xl overflow-hidden bg-[#070A0F]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#0E1626] border-b border-[#1E2D44] text-[10px] font-mono uppercase text-slate-400 tracking-wider">
                    <th className="py-3 px-3.5">Account / Identifier</th>
                    <th className="py-3 px-3">Role</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3 hidden md:table-cell">Audit & Activity</th>
                    <th className="py-3 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2D44]/60">
                  {filteredUsers.map((u) => {
                    const isSelf = u.id === currentUser.id;
                    const isTargetSuperAdmin = u.role === 'super_admin';
                    // Admins cannot edit, reset PIN, or delete a Super Admin
                    const canModifyTarget = isCurrentUserSuperAdmin || !isTargetSuperAdmin;

                    return (
                      <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 px-3.5">
                          <div className="font-semibold text-slate-100 flex items-center gap-2">
                            <span>{u.employeeName}</span>
                            {isSelf && (
                              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-500/30">
                                YOU
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-cyan-400 tracking-wider">
                            {u.employeeCode}
                          </div>
                        </td>

                        <td className="py-3 px-3 whitespace-nowrap">{getRoleBadge(u.role)}</td>

                        <td className="py-3 px-3 whitespace-nowrap">
                          {u.active ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-400 font-mono">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                              Deactivated
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-3 hidden md:table-cell text-slate-400 font-mono text-[11px]">
                          <div>
                            <span className="text-white font-bold">{u.totalScans || 0}</span> scans
                            {u.createdAt && (
                              <span className="text-slate-500 text-[10px] ml-2">
                                · Created {new Date(u.createdAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[200px]">
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
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-cyan-500/20 hover:text-cyan-300 text-slate-400 transition-colors cursor-pointer"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>

                              {/* Edit */}
                              <button
                                type="button"
                                onClick={() => handleOpenEdit(u)}
                                title="Edit account & role"
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white text-slate-400 transition-colors cursor-pointer"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>

                              {/* Delete (if not self) */}
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => setDeletingUser(u)}
                                  title="Delete account"
                                  className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 hover:text-rose-300 text-slate-400 transition-colors cursor-pointer"
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
        <div className="p-4 bg-[#070A0F] border-t border-[#1E2D44] flex items-center justify-between text-xs font-mono text-slate-500 shrink-0">
          <div>
            Total Accounts: <span className="text-slate-300 font-bold">{users.length}</span> · Admins:{' '}
            <span className="text-indigo-400 font-bold">
              {users.filter((u) => u.role === 'super_admin' || u.role === 'admin').length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer font-mono text-xs uppercase"
          >
            Close
          </button>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* SUB-MODAL: Add Account Form */}
        {/* ------------------------------------------------------------- */}
        {isAddUserOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md bg-[#0E1626] border border-[#1E2D44] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E2D44]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-cyan-400" />
                  Create User Account
                </h3>
                <button
                  onClick={() => setIsAddUserOpen(false)}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Michael Harris"
                    className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
                    Unique Employee Identifier
                  </label>
                  <input
                    type="text"
                    required
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    placeholder="e.g. EMP-105 or ADMIN-02"
                    className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-xs uppercase focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
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
                            ? 'bg-cyan-500/10 border-cyan-400 text-white'
                            : 'bg-[#070A0F] border-[#1E2D44] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <div className="text-[11px] font-mono font-bold uppercase">{r.label}</div>
                        <div className="text-[9px] text-slate-500 mt-0.5">{r.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
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
                      className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-cyan-500"
                    />
                    <Lock className="absolute left-3 top-2.5 w-4 h-4 text-slate-500 pointer-events-none" />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAddUserOpen(false)}
                    className="px-3.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting || formPin.length !== 4}
                    className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
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
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md bg-[#0E1626] border border-[#1E2D44] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E2D44]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <Edit2 className="w-4 h-4 text-cyan-400" />
                  Edit Account: {editingUser.employeeName}
                </h3>
                <button
                  onClick={() => setEditingUser(null)}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
                    Employee Identifier
                  </label>
                  <input
                    type="text"
                    required
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-xs uppercase focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
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
                            ? 'bg-cyan-500/10 border-cyan-400 text-white'
                            : 'bg-[#070A0F] border-[#1E2D44] text-slate-400 hover:text-slate-200'
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
                      className="w-4 h-4 rounded text-cyan-500 bg-[#070A0F] border-[#1E2D44]"
                    />
                    <span className="text-xs font-mono text-slate-200">
                      Account Active (Uncheck to immediately deactivate and revoke access)
                    </span>
                  </label>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="px-3.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting}
                    className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
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
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-sm bg-[#0E1626] border border-[#1E2D44] rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#1E2D44]">
                <h3 className="text-sm font-bold text-white font-mono uppercase flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-cyan-400" />
                  Reset PIN
                </h3>
                <button
                  onClick={() => setResetPinUser(null)}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleResetPinSubmit} className="space-y-4">
                <p className="text-xs text-slate-300">
                  Enter a new 4-digit PIN for{' '}
                  <strong className="text-cyan-400">{resetPinUser.employeeName}</strong> (
                  {resetPinUser.employeeCode}). Any current lockouts will be lifted and active sessions revoked.
                </p>

                <div>
                  <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">
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
                      className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-cyan-500"
                    />
                    <Lock className="absolute left-3 top-2.5 w-4 h-4 text-slate-500 pointer-events-none" />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setResetPinUser(null)}
                    className="px-3.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 font-mono text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSubmitting || newPin.length !== 4}
                    className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
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
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-sm bg-[#0E1626] border border-rose-500/40 rounded-2xl p-5 shadow-2xl">
              <div className="flex items-center gap-2.5 text-rose-400 text-sm font-bold font-mono uppercase mb-3">
                <AlertTriangle className="w-5 h-5" />
                Delete Account?
              </div>

              <p className="text-xs text-slate-300 leading-relaxed mb-4">
                Are you sure you want to delete{' '}
                <strong className="text-white">{deletingUser.employeeName}</strong> (
                {deletingUser.employeeCode})?
              </p>

              <div className="p-3 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-cyan-200 text-[11px] mb-4">
                <strong>Audit preservation notice:</strong> All historical scan events and receiving timestamps will be preserved with {deletingUser.employeeName}'s name and role snapshot intact.
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeletingUser(null)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 font-mono text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteSubmit}
                  disabled={formSubmitting}
                  className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold font-mono text-xs uppercase cursor-pointer disabled:opacity-40"
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
