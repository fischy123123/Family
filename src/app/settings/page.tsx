'use client'

export const dynamic = 'force-dynamic'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  LogOut, Trash2, UserMinus, ArrowLeft, ShieldAlert, RefreshCw,
  Loader2, RotateCcw, Sparkles, Brain, ChevronDown, Bug,
} from 'lucide-react'
import { isAiDebugEnabled, setAiDebugEnabled } from '@/lib/aiDebug'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { auth } from '@/lib/firebase'
import { isAdminEmail } from '@/lib/admin'
import { generateId } from '@/lib/utils'
import type { FamilyMemory, FamilyMember } from '@/lib/types'
import { memorySubjects } from '@/lib/types'

// All localStorage key prefixes used by CommandCenter — must stay in sync with
// the constants defined there.
const CACHE_PREFIXES = [
  'fam-attn-',
  'fam-gcal-',
  'fam-clar-',
  'fam-gmail-',
  'fam-lastrun-',
  'fam-ctxsig-',
  'fam-lastrun-sig-',
  'fam-dismissed-',
  'fam-completed-',
]

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
  const { data: memories, create, update, remove } = useFirestore<FamilyMemory>('memories')
  const { data: members, update: updateMember } = useFirestore<FamilyMember>('members')

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')

  const [resetting, setResetting] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [cleanResult, setCleanResult] = useState<string | null>(null)
  const [showMemories, setShowMemories] = useState(false)
  const [debugMode, setDebugMode] = useState(false)

  // Hydrate the AI-debug toggle from localStorage on mount.
  useEffect(() => {
    setDebugMode(isAiDebugEnabled())
  }, [])

  function toggleDebugMode() {
    const next = !debugMode
    setDebugMode(next)
    setAiDebugEnabled(next)
  }

  // --- Admin panel state ---
  const isAdmin = isAdminEmail(user?.email, process.env.NEXT_PUBLIC_ADMIN_EMAILS)
  const [families, setFamilies] = useState<FamilyRow[] | null>(null)
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminError, setAdminError] = useState('')
  const [purgingId, setPurgingId] = useState<string | null>(null)
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false)

  // ── Briefing reset ────────────────────────────────────────────
  function resetBriefingCache() {
    if (!familyId) return
    setResetting(true)
    CACHE_PREFIXES.forEach((prefix) => {
      try { localStorage.removeItem(prefix + familyId) } catch { /* ignore */ }
    })
    setResetDone(true)
    setResetting(false)
    // Navigate home after a beat so the user sees the fresh briefing load
    setTimeout(() => router.push('/command'), 800)
  }

  // ── Memory cleanup ────────────────────────────────────────────
  async function cleanupMemories() {
    if (memories.length === 0) return
    setCleaning(true)
    setCleanResult(null)

    const refs = members.map((m) => ({
      id: m.id, name: m.name, email: m.email || undefined, role: m.role,
    }))

    // Work from a local snapshot so Phase 2 sees Phase 1's tagging without
    // waiting for Firestore's onSnapshot to propagate.
    const snapshot = [...memories]
    let tagged = 0
    let removed = 0
    let merged = 0
    let rewritten = 0
    let errors = 0
    let lastError = ''

    try {
      // ── Phase 1: tag each unlinked memory individually ──────────
      // One classify call per memory is more reliable than asking one big
      // prompt to tag all of them at once.
      const untagged = snapshot.filter((m) => memorySubjects(m).length === 0)
      for (const memory of untagged) {
        try {
          const res = await fetch('/api/ai/classify-memory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: memory.text, members: refs }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) {
            errors++
            lastError = data.error || `HTTP ${res.status}`
            continue
          }
          const subjectIdentifiers: string[] = Array.isArray(data.subjectIdentifiers) ? data.subjectIdentifiers : []
          if (subjectIdentifiers.length) {
            await update({ ...memory, subjectEmails: subjectIdentifiers })
            const idx = snapshot.findIndex((m) => m.id === memory.id)
            if (idx >= 0) snapshot[idx] = { ...memory, subjectEmails: subjectIdentifiers }
            tagged++
          }
        } catch (e) {
          errors++
          lastError = e instanceof Error ? e.message : 'network error'
        }
      }

      // ── Phase 2: merge, delete, and rewrite using updated snapshot ──
      if (snapshot.length >= 2) {
        const res = await fetch('/api/ai/cleanup-memories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memories: snapshot, members: refs, now: new Date().toISOString() }),
        })
        const result = await res.json().catch(() => ({}))
        if (!res.ok) {
          errors++
          lastError = result.error || `HTTP ${res.status}`
        } else {
          const toDelete: string[] = result.toDelete ?? []
          const toMerge: Array<{ supersededIds: string[]; consolidatedText: string; subjectIdentifiers: string[] }> = result.toMerge ?? []
          const toRewrite: Array<{ id: string; newText: string }> = result.toRewrite ?? []

          // Rewrite single memories in place (stale relative time / transient state)
          for (const r of toRewrite) {
            const mem = snapshot.find((m) => m.id === r.id)
            if (mem) await update({ ...mem, text: r.newText })
          }

          for (const id of toDelete) {
            await remove(id)
          }
          for (const group of toMerge) {
            for (const id of group.supersededIds) {
              await remove(id)
            }
            await create({
              id: generateId(),
              text: group.consolidatedText,
              source: 'manual',
              createdAt: new Date().toISOString(),
              ...(group.subjectIdentifiers?.length ? { subjectEmails: group.subjectIdentifiers } : {}),
            } as FamilyMemory)
          }
          removed = toDelete.length + toMerge.reduce((n, g) => n + g.supersededIds.length, 0)
          merged = toMerge.length
          rewritten = toRewrite.length
        }
      }

      const parts: string[] = []
      if (tagged > 0) parts.push(`${tagged} linked to family members`)
      if (merged > 0) parts.push(`${merged} merged`)
      if (rewritten > 0) parts.push(`${rewritten} cleaned up`)
      if (removed > 0) parts.push(`${removed} removed`)

      if (parts.length === 0 && errors === 0) {
        setCleanResult('Already clean — nothing to do.')
        setShowMemories(true)
      } else if (parts.length === 0 && errors > 0) {
        // Nothing changed AND the AI calls failed — this is the real bug case.
        setCleanResult(`Couldn't reach the AI (${errors} error${errors === 1 ? '' : 's'}): ${lastError}`)
      } else {
        const suffix = errors > 0 ? ` · ${errors} call${errors === 1 ? '' : 's'} failed (${lastError})` : ''
        setCleanResult(`Done: ${parts.join(', ')}.${suffix}`)
        setShowMemories(false)
        setTimeout(() => setShowMemories(true), 150)
      }
    } catch (e) {
      setCleanResult(`Cleanup failed — ${e instanceof Error ? e.message : 'try again'}.`)
    } finally {
      setCleaning(false)
    }
  }

  // ── Admin helpers ─────────────────────────────────────────────
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
      let serverOk = false
      try {
        const idToken = await auth.currentUser?.getIdToken()
        const res = await fetch('/api/admin/reset-family', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        })
        const text = await res.text()
        let data: { error?: string } = {}
        try { data = text ? JSON.parse(text) : {} } catch { /* */ }
        if (res.ok) serverOk = true
        else if (res.status === 401 || res.status === 403) {
          throw new Error(data.error ?? 'Not authorized to delete this family')
        }
      } catch (serverErr) {
        console.warn('Admin reset unavailable, using client-side wipe:', serverErr)
      }

      if (!serverOk) await deleteFamily()

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
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Account</p>
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

        {/* Briefing */}
        <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
          <div className="px-5 py-4 flex items-center gap-2">
            <RotateCcw size={15} className="text-slate-400" />
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Briefing Data</p>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-slate-700 mb-1">Force re-sync from Google</p>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              The briefing's refresh button (top of the home screen) re-runs the AI using data it already has. This
              goes further: it discards that cached data and pulls everything fresh from Google Calendar and your
              inbox before re-running. Use this when something is factually wrong — a deleted event that keeps
              showing up, last week's appointments still appearing, or the briefing not loading at all.
            </p>
            <button
              onClick={resetBriefingCache}
              disabled={resetting || resetDone}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 disabled:opacity-50 transition-all"
            >
              {resetting ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <RotateCcw size={15} />
              )}
              {resetDone ? 'Done — re-syncing from Google…' : resetting ? 'Clearing…' : 'Re-sync from Google'}
            </button>
          </div>
        </section>

        {/* Memories */}
        <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
          <div className="px-5 py-4 flex items-center gap-2">
            <Brain size={15} className="text-slate-400" />
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
              Memories {memories.length > 0 && <span className="normal-case font-normal text-slate-300">· {memories.length}</span>}
            </p>
          </div>

          {/* Clean up */}
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-slate-700 mb-1">Clean up memories</p>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Reviews all saved memories and consolidates duplicates, removes stale entries, and links each memory
              to the right family member so the AI uses only relevant context when building each person's briefing.
            </p>
            {memories.length < 2 ? (
              <p className="text-xs text-slate-400 italic">
                {memories.length === 0 ? 'No memories saved yet.' : 'Add more memories before cleaning up.'}
              </p>
            ) : (
              <button
                onClick={cleanupMemories}
                disabled={cleaning}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 disabled:opacity-50 transition-all"
              >
                {cleaning ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {cleaning ? 'Reviewing memories…' : 'Clean up memories'}
              </button>
            )}
            {cleanResult && (
              <p className="text-xs text-slate-500 mt-3">{cleanResult}</p>
            )}
          </div>

          {/* Browse all AI knowledge */}
          {(() => {
            // Count everything the AI can see
            const profileItemCount = members.reduce((n, m) =>
              n + (m.memories?.length ?? 0) + (m.routines?.length ?? 0) +
              (m.preferences?.length ?? 0) + (m.importantInfo?.length ?? 0), 0)
            const totalCount = memories.length + profileItemCount
            if (totalCount === 0) return null

            return (
              <div>
                <button
                  onClick={() => setShowMemories((v) => !v)}
                  className="w-full flex items-center justify-between px-5 py-4 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <span className="font-medium">
                    Browse all AI knowledge
                    <span className="ml-1.5 text-slate-300 font-normal text-xs">{totalCount} items</span>
                  </span>
                  <ChevronDown
                    size={16}
                    className="text-slate-400 transition-transform duration-200"
                    style={{ transform: showMemories ? 'rotate(180deg)' : 'rotate(0deg)' }}
                  />
                </button>

                {showMemories && (() => {
                  // ── Helpers ────────────────────────────────────────────────
                  function memberFor(ident: string): FamilyMember | undefined {
                    const v = ident.toLowerCase()
                    return members.find(
                      (m) => m.email?.toLowerCase() === v || m.id.toLowerCase() === v || m.name.toLowerCase() === v
                    )
                  }

                  type SourceTag = 'memory' | 'note' | 'routine' | 'preference' | 'info'
                  type UnifiedItem = {
                    id: string
                    text: string
                    tag: SourceTag
                    tagLabel: string
                    onDelete: () => void
                    extraChips?: React.ReactNode
                  }

                  const SOURCE_COLORS: Record<SourceTag, string> = {
                    memory: '#6366f1',   // indigo — family-wide memories
                    note:   '#0ea5e9',   // sky — profile notes
                    routine:'#10b981',   // emerald — routines
                    preference: '#f59e0b', // amber — preferences
                    info:   '#ef4444',   // red — important info
                  }

                  // ── Build per-person groups ────────────────────────────────
                  type PersonGroup = {
                    memberId: string
                    name: string
                    color: string
                    emoji: string
                    items: UnifiedItem[]
                  }
                  const personGroups: PersonGroup[] = []

                  // 1. Family-wide memories (no subject)
                  const byDate = [...memories].sort(
                    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                  )
                  const familyWideItems: UnifiedItem[] = []
                  const memberMemoriesMap = new Map<string, UnifiedItem[]>()

                  for (const m of byDate) {
                    const subjects = memorySubjects(m)
                    // Multi-subject chip labels
                    const chips = subjects.length > 1 ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {subjects.map((s) => {
                          const mem = memberFor(s)
                          return (
                            <span key={s} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                              style={{ backgroundColor: (mem?.colorHex ?? '#6B7280') + '20', color: mem?.colorHex ?? '#6B7280' }}>
                              {mem?.name ?? s}
                            </span>
                          )
                        })}
                      </div>
                    ) : null

                    const item: UnifiedItem = {
                      id: m.id, text: m.text,
                      tag: 'memory', tagLabel: 'memory',
                      onDelete: () => remove(m.id),
                      extraChips: chips,
                    }

                    if (subjects.length === 0) {
                      familyWideItems.push(item)
                    } else {
                      for (const s of subjects) {
                        const mem = memberFor(s)
                        const key = mem?.id ?? `unknown:${s}`
                        if (!memberMemoriesMap.has(key)) memberMemoriesMap.set(key, [])
                        memberMemoriesMap.get(key)!.push(item)
                      }
                    }
                  }

                  // 2. Per-member profile data
                  const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name))
                  for (const m of sortedMembers) {
                    const items: UnifiedItem[] = []

                    // Tagged family memories
                    for (const fi of memberMemoriesMap.get(m.id) ?? []) items.push(fi)

                    // Profile notes
                    for (const n of m.memories ?? []) {
                      items.push({
                        id: `note-${n.id}`, text: n.text,
                        tag: 'note', tagLabel: 'profile note',
                        onDelete: () => updateMember({ ...m, memories: (m.memories ?? []).filter((x) => x.id !== n.id) }),
                      })
                    }

                    // Routines
                    for (const r of m.routines ?? []) {
                      items.push({
                        id: `routine-${r.id}`, text: `${r.title}: ${r.schedule}${r.notes ? ` — ${r.notes}` : ''}`,
                        tag: 'routine', tagLabel: 'routine',
                        onDelete: () => updateMember({ ...m, routines: (m.routines ?? []).filter((x) => x.id !== r.id) }),
                      })
                    }

                    // Preferences
                    for (const p of m.preferences ?? []) {
                      items.push({
                        id: `pref-${p.id}`, text: `[${p.category}] ${p.text}`,
                        tag: 'preference', tagLabel: 'preference',
                        onDelete: () => updateMember({ ...m, preferences: (m.preferences ?? []).filter((x) => x.id !== p.id) }),
                      })
                    }

                    // Important info
                    for (const i of m.importantInfo ?? []) {
                      items.push({
                        id: `info-${i.id}`, text: `${i.label}: ${i.value}`,
                        tag: 'info', tagLabel: i.category,
                        onDelete: () => updateMember({ ...m, importantInfo: (m.importantInfo ?? []).filter((x) => x.id !== i.id) }),
                      })
                    }

                    if (items.length > 0) {
                      personGroups.push({ memberId: m.id, name: m.name, color: m.colorHex, emoji: m.emoji, items })
                    }
                  }

                  // ── Render ──────────────────────────────────────────────────
                  function KnowledgeRow({ item }: { item: UnifiedItem }) {
                    return (
                      <div className="group flex items-start gap-2 pl-4 pr-2 py-2 rounded-xl bg-slate-50 border border-slate-100">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                              style={{ backgroundColor: SOURCE_COLORS[item.tag] + '18', color: SOURCE_COLORS[item.tag] }}
                            >
                              {item.tagLabel}
                            </span>
                          </div>
                          <p className="text-sm text-slate-700 leading-relaxed">{item.text}</p>
                          {item.extraChips}
                        </div>
                        <button
                          onClick={item.onDelete}
                          className="shrink-0 p-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-white transition-colors opacity-0 group-hover:opacity-100"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )
                  }

                  return (
                    <div className="px-5 pb-5 space-y-5">
                      {/* Family-wide memories */}
                      {familyWideItems.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 bg-slate-400" />
                            <p className="text-xs font-semibold text-slate-500">Family-wide</p>
                            <span className="text-xs text-slate-300">{familyWideItems.length}</span>
                          </div>
                          <div className="space-y-1.5">
                            {familyWideItems.map((item) => <KnowledgeRow key={item.id} item={item} />)}
                          </div>
                        </div>
                      )}
                      {/* Per-person groups */}
                      {personGroups.map((g) => (
                        <div key={g.memberId}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                            <p className="text-xs font-semibold text-slate-500">{g.emoji} {g.name}</p>
                            <span className="text-xs text-slate-300">{g.items.length}</span>
                          </div>
                          <div className="space-y-1.5">
                            {g.items.map((item) => <KnowledgeRow key={item.id} item={item} />)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            )
          })()}
        </section>

        {/* AI Diagnostics */}
        <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
          <div className="px-5 py-4 flex items-center gap-2">
            <Bug size={15} className="text-slate-400" />
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">AI Diagnostics</p>
          </div>
          <div className="px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 mb-1">AI debugging mode</p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  When something looks wrong, turn this on and ask Copilot about it. It will show its work — citing
                  exactly where each fact came from (a specific memory, a member&apos;s profile, a calendar event, or a
                  tool it called) and flagging anything uncertain or contradictory. Turn it off for normal,
                  conversational replies.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={debugMode}
                onClick={toggleDebugMode}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 ${
                  debugMode ? 'bg-blue-600' : 'bg-slate-200'
                }`}
                aria-label="Toggle AI debugging mode"
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    debugMode ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            {debugMode && (
              <p className="text-xs text-blue-600 mt-3 flex items-center gap-1.5">
                <Bug size={12} /> Debugging mode is on — Copilot will cite its sources.
              </p>
            )}
          </div>
        </section>

        {/* Family */}
        {familyId && (
          <section className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 mb-4">
            <div className="px-5 py-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Family</p>
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

        {error && <p className="text-sm text-red-500 text-center mt-2">{error}</p>}

        {/* Admin */}
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
