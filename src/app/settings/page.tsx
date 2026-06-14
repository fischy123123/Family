'use client'

export const dynamic = 'force-dynamic'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, Trash2, UserMinus, ArrowLeft, ShieldAlert, RefreshCw, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { auth } from '@/lib/firebase'
import { isAdminEmail } from '@/lib/admin'

interface FamilyRow {
  id: string
  memberCount: number
  members: string[]
  createdBy: string | null
  createdAt: string | null
  inviteCode: string | null
}

export default function SettingsPage() {
  const router = useRouter()
  const { user, signOut } = useAuth()
  const { familyId, inviteCode, resetFamily, deleteFamily } = useFamily()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')

  // --- Admin panel state ---
  const isAdmin = isAdminEmail(user?.email, process.env.NEXT_PUBLIC_ADMIN_EMAILS)
  const [families, setFamilies] = useState<FamilyRow[] | null>(null)
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminError, setAdminError] = useState('')
  const [purgingId, setPurgingId] = useState<string | null>(null)
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false)

  const loadFamilies = useCallback(async () => {
    setAdminLoading(true)
    setAdminError('')
    try {
      const idToken = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/admin/families', {
        headers: { Authorization: `Bearer ${idToken}` },
      })
      const text = await res.text()
      let data: { families?: FamilyRow[]; error?: string } = {}
      try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON */ }
      if (!res.ok) throw new Error(data.error ?? `Failed to load (${res.status})`)
      setFamilies(data.families ?? [])
    } catch (e) {
      setAdminError(e instanceof Error ? e.message : 'Could not load families')
    } finally {
      setAdminLoading(false)
    }
  }, [])

  async function purge(opts: { familyId?: string; all?: boolean }) {
    setAdminError('')
    setPurgingId(opts.all ? '__all__' : opts.familyId ?? null)
    try {
      const idToken = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/admin/families', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(opts),
      })
      const text = await res.text()
      let data: { error?: string } = {}
      try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON */ }
      if (!res.ok) throw new Error(data.error ?? `Purge failed (${res.status})`)

      // If we purged our own family, drop our local pointer and head to setup
      const ownPurged = opts.all || opts.familyId === familyId
      if (ownPurged && familyId) {
        Object.keys(localStorage).forEach((k) => {
          if (k.startsWith('attn:') || k.startsWith('gcal:') || k.startsWith('clar:')) {
            localStorage.removeItem(k)
          }
        })
        await resetFamily()
      }
      await loadFamilies()
    } catch (e) {
      setAdminError(e instanceof Error ? e.message : 'Could not purge')
    } finally {
      setPurgingId(null)
      setConfirmPurgeAll(false)
    }
  }

  async function handleLeaveFamily() {
    setLeaving(true)
    setError('')
    try {
      await resetFamily()
      router.replace('/setup')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not leave family')
      setLeaving(false)
    }
  }

  async function handleDeleteFamily() {
    if (!user) return
    setDeleting(true)
    setError('')
    try {
      // Prefer the server-side admin endpoint (clears every member's pointer),
      // but tolerate it being unavailable or returning a non-JSON error page.
      let serverOk = false
      try {
        const idToken = await auth.currentUser?.getIdToken()
        const res = await fetch('/api/admin/reset-family', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        })
        const text = await res.text()
        let data: { error?: string } = {}
        try {
          data = text ? JSON.parse(text) : {}
        } catch {
          // Non-JSON response (e.g. an HTML error page) — treat as server failure
        }
        if (res.ok) serverOk = true
        else if (res.status === 401 || res.status === 403) {
          throw new Error(data.error ?? 'Not authorized to delete this family')
        }
        // Other failures fall through to the client-side wipe below
      } catch (serverErr) {
        // Network or auth error — fall back to client-side deletion
        console.warn('Admin reset unavailable, using client-side wipe:', serverErr)
      }

      // Always ensure the data is gone via the client SDK (idempotent if the
      // server already deleted it). Guarantees we never leave the user stuck.
      if (!serverOk) {
        await deleteFamily()
      }

      // Clear localStorage caches
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('attn:') || k.startsWith('gcal:') || k.startsWith('clar:')) {
          localStorage.removeItem(k)
        }
      })
      router.replace('/setup')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete family')
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-lg mx-auto">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={16} /> Back
        </button>

        <h1 className="text-2xl font-bold text-slate-800 mb-6">Settings</h1>

        {/* Account */}
        <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-0.5">Account</p>
          </div>
          <div className="px-5 py-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm shrink-0">
              {user?.email?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">{user?.email}</p>
              <p className="text-xs text-slate-400">Signed in with Google</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 px-5 py-4 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <LogOut size={16} className="text-slate-400" />
            Sign Out
          </button>
        </section>

        {/* Family */}
        {familyId && (
          <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
            <div className="px-5 py-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-0.5">Family</p>
            </div>
            {inviteCode && (
              <div className="px-5 py-4">
                <p className="text-xs text-slate-400 mb-1">Invite Code</p>
                <p className="text-xl font-mono font-bold tracking-widest text-slate-800">{inviteCode}</p>
                <p className="text-xs text-slate-400 mt-1">Share this with family members so they can join</p>
              </div>
            )}
            <button
              onClick={handleLeaveFamily}
              disabled={leaving}
              className="w-full flex items-center gap-3 px-5 py-4 text-sm text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50"
            >
              <UserMinus size={16} />
              {leaving ? 'Leaving…' : 'Leave Family (keeps family data)'}
            </button>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center gap-3 px-5 py-4 text-sm text-red-500 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={16} />
                Delete All Family Data
              </button>
            ) : (
              <div className="px-5 py-4 space-y-3">
                <p className="text-sm text-red-600 font-medium">
                  This permanently deletes all members, events, tasks, lists, and plans. This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 py-2 rounded-xl text-sm font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteFamily}
                    disabled={deleting}
                    className="flex-1 py-2 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Yes, Delete Everything'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {error && (
          <p className="text-sm text-red-500 text-center mt-2">{error}</p>
        )}

        {/* Admin — purge any/all families (gated to admin accounts) */}
        {isAdmin && (
          <section className="bg-white rounded-2xl border border-red-200 mb-4 overflow-hidden">
            <div className="px-5 py-4 flex items-center gap-2 border-b border-slate-100">
              <ShieldAlert size={15} className="text-red-500" />
              <p className="text-xs font-semibold text-red-500 uppercase tracking-widest">Admin · Danger Zone</p>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <p className="text-sm text-slate-600">
                  {families === null
                    ? 'View every family that exists in the database.'
                    : `${families.length} famil${families.length === 1 ? 'y' : 'ies'} found`}
                </p>
                <button
                  onClick={loadFamilies}
                  disabled={adminLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  {adminLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {families === null ? 'Load families' : 'Refresh'}
                </button>
              </div>

              {adminError && <p className="text-sm text-red-500 mb-3">{adminError}</p>}

              {families && families.length > 0 && (
                <div className="space-y-2">
                  {families.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">
                          {f.inviteCode ? <span className="font-mono">{f.inviteCode}</span> : f.id}
                          {f.id === familyId && (
                            <span className="ml-2 text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">
                              YOURS
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400 truncate">
                          {f.memberCount} member{f.memberCount === 1 ? '' : 's'}
                          {f.createdAt ? ` · created ${new Date(f.createdAt).toLocaleDateString()}` : ''}
                        </p>
                        <p className="text-[10px] text-slate-300 font-mono truncate">{f.id}</p>
                      </div>
                      <button
                        onClick={() => purge({ familyId: f.id })}
                        disabled={!!purgingId}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-500 border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50 shrink-0"
                      >
                        {purgingId === f.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        Purge
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {families && families.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-3">No families in the database.</p>
              )}

              {families && families.length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  {!confirmPurgeAll ? (
                    <button
                      onClick={() => setConfirmPurgeAll(true)}
                      disabled={!!purgingId}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-50"
                    >
                      <Trash2 size={15} /> Purge ALL families
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-red-600 font-medium text-center">
                        This permanently deletes EVERY family and all their data. This cannot be undone.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setConfirmPurgeAll(false)}
                          disabled={!!purgingId}
                          className="flex-1 py-2 rounded-xl text-sm font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => purge({ all: true })}
                          disabled={!!purgingId}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50"
                        >
                          {purgingId === '__all__' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          Yes, purge everything
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
