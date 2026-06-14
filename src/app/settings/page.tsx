'use client'

export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, Trash2, UserMinus, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { auth } from '@/lib/firebase'

export default function SettingsPage() {
  const router = useRouter()
  const { user, signOut } = useAuth()
  const { familyId, inviteCode, resetFamily } = useFamily()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')

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
      const idToken = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/admin/reset-family', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Delete failed')
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
      </div>
    </div>
  )
}
