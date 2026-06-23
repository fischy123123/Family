'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  collection, doc, setDoc, getDoc, updateDoc, writeBatch, getDocs, query, where, deleteField,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  RefreshCw, AlertTriangle, Lightbulb, Clock,
  Calendar as CalIcon, Sparkles, Check, X, MessageCircle, Users, Bookmark, Plus, ChevronDown, ChevronRight, Bug, Send,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useCapture } from '@/contexts/CaptureContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { ConnectGooglePrompt } from '@/components/dashboard/ConnectGooglePrompt'
import { generateId, cn } from '@/lib/utils'
import { resolveMemberRef } from '@/lib/members'
import { isAiDebugEnabled } from '@/lib/aiDebug'
import { BUCKET_META } from '@/lib/types'
import { Markdown } from '@/components/ui/Markdown'
import type { PendingAction } from '@/components/copilot/ProposedActions'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  AttentionReport, AttentionItem, AttentionBucket, PotentialProblem,
  FamilyMemory, FamilyProfile, FamilyReminder, EventAssignmentSuggestion,
} from '@/lib/types'

type EventContext = {
  id: string // == event id
  eventTitle: string
  context: string
  savedAt: string
}

type EmailSuggestion = {
  type: string
  title: string
  date: string | null
  notes?: string
  confidence: number
  sourceEmailSubject: string
  messageId?: string
  forNames?: string[]
}

const BUCKET_ORDER: AttentionBucket[] = ['now', 'next', 'later', 'upcoming']
const BUCKET_PRIORITY: Record<AttentionBucket, number> = { now: 0, next: 1, later: 2, upcoming: 3 }

type ItemGroup = {
  key: string
  groupTitle: string | null  // non-null when 2+ items share a groupKey
  items: AttentionItem[]
  bucket: AttentionBucket    // most-urgent bucket across items
}

// Turn a lowercase-hyphenated groupKey slug into a readable title, as a fallback
// for older/cached reports generated before the model emitted a groupTitle.
function prettifyGroupKey(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function groupItems(items: AttentionItem[]): ItemGroup[] {
  const byKey = new Map<string, AttentionItem[]>()
  for (const item of items) {
    const k = item.groupKey ?? `__solo__${item.id}`
    byKey.set(k, [...(byKey.get(k) ?? []), item])
  }
  return Array.from(byKey.entries()).map(([key, groupedItems]) => {
    const bucket = groupedItems.reduce<AttentionBucket>((best, i) => (
      BUCKET_PRIORITY[i.bucket] < BUCKET_PRIORITY[best] ? i.bucket : best
    ), groupedItems[0].bucket)
    const isRealGroup = !!groupedItems[0].groupKey && groupedItems.length > 1
    // Prefer the model's human-readable groupTitle; fall back to prettifying the
    // slug so a raw key like "maddie-therapy-tue" never leaks into the UI.
    const titled = groupedItems.find((i) => i.groupTitle?.trim())?.groupTitle?.trim()
    const groupTitle = isRealGroup
      ? (titled || prettifyGroupKey(groupedItems[0].groupKey!))
      : null
    return { key, groupTitle, items: groupedItems, bucket }
  })
}

type BriefingSection = {
  key: string               // section name ("Maddie", "Eric", "Family")
  member: FamilyMember | null
  groups: ItemGroup[]
}

const ROLE_ORDER: Record<FamilyMember['role'], number> = { parent: 0, other: 1, child: 2, pet: 3 }

function buildSections(
  items: AttentionItem[],
  members: FamilyMember[],
  currentUserEmail: string | null | undefined,
): BriefingSection[] {
  function itemSection(item: AttentionItem): string {
    if (item.section) return item.section
    const ref = item.forEmails?.[0]
    if (ref) {
      const m = resolveMemberRef(members, ref)
      if (m) return m.name
    }
    return 'Family'
  }

  const bySection = new Map<string, AttentionItem[]>()
  for (const item of items) {
    const s = itemSection(item)
    bySection.set(s, [...(bySection.get(s) ?? []), item])
  }

  const list: BriefingSection[] = Array.from(bySection.entries()).map(([key, sItems]) => ({
    key,
    member: key === 'Family' ? null : (members.find((m) => m.name === key) ?? null),
    groups: groupItems(sItems),
  }))

  const selfMember = currentUserEmail
    ? members.find((m) => m.email?.toLowerCase() === currentUserEmail.toLowerCase())
    : null

  list.sort((a, b) => {
    if (a.key === 'Family') return 1
    if (b.key === 'Family') return -1
    if (selfMember) {
      if (a.key === selfMember.name) return -1
      if (b.key === selfMember.name) return 1
    }
    return (ROLE_ORDER[a.member?.role ?? 'other'] ?? 1) - (ROLE_ORDER[b.member?.role ?? 'other'] ?? 1)
  })

  return list
}

// ── Local cache (stale-while-revalidate) ────────────────────
// Everything that gates the page is cached per-family so returning visits
// render instantly and only update in the background.
const ATTN_PREFIX = 'fam-attn-'
const GMAIL_PREFIX = 'fam-gmail-'
const LAST_RUN_PREFIX = 'fam-lastrun-'
const CTX_SIG_PREFIX = 'fam-ctxsig-'
// The ctxSignature that was in effect when the AI last ran. Compared in the
// auto-run throttle to detect "nothing changed — skip the AI call."
const LAST_RUN_SIG_PREFIX = 'fam-lastrun-sig-'
const SKIP_EA_PREFIX = 'fam-skip-ea-'

// 15-minute minimum between AI calls. Additionally, if the data signature hasn't
// changed since the last run, we extend the effective throttle to 45 minutes:
// time-buckets (now/next/later) shift over time even without data changes, so
// a periodic re-run is still needed — just much less often than 15 min.
const ENGINE_THROTTLE_MS = 15 * 60 * 1000
// How long to reuse a cached briefing when data hasn't changed (45 min).
// After this, re-run anyway so time-buckets (now/next/later) stay fresh.
const ENGINE_DATA_UNCHANGED_TTL_MS = 45 * 60 * 1000

// On a cold load the briefing's inputs arrive from several async sources a beat
// apart — Firestore hydration first, then the server calendar sync, then the
// Gmail scan. Each arrival used to kick a fresh 60-80s engine run, so one load
// paid for three full generations. We instead wait for this quiet window after
// the LAST trigger before running, so the whole burst collapses into one run
// with the complete picture. Each new arrival resets the timer, so it adapts to
// however long the sources take to settle.
const ENGINE_COALESCE_MS = 1000

// Pull the (possibly still-streaming) greeting out of the raw JSON the attention
// engine is generating, so we can show it live before the full briefing lands.
// Returns the greeting text decoded so far, or null if it hasn't started yet.
function extractPartialGreeting(raw: string): string | null {
  const key = raw.indexOf('"greeting"')
  if (key === -1) return null
  const colon = raw.indexOf(':', key)
  if (colon === -1) return null
  const open = raw.indexOf('"', colon + 1)
  if (open === -1) return null
  let out = ''
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[i + 1]
      if (n === undefined) break // incomplete escape at the stream edge — stop here
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
      i++
      continue
    }
    if (c === '"') return out // closing quote — greeting complete
    out += c
  }
  return out // still streaming
}

// Open a Gmail message in the system browser (SFSafariViewController on iOS).
//
// The target="_blank" programmatic click is the correct mechanism — window.open()
// is silently blocked in standalone PWA mode, and window.location.href navigates
// the app's own WKWebView away. The anchor click hands the URL to iOS's in-app
// browser, which shares Safari's cookies so the user is already logged into Gmail.
//
// URL strategy: Gmail mobile web silently strips the #all/{id} hash fragment
// during its mobile redirect, landing the user on inbox. Gmail search URLs

const CACHE_TTL_MS: Partial<Record<string, number>> = {
  // Gmail signals go stale after 6 hours — refresh so the engine doesn't
  // keep reasoning about week-old inbox signals.
  'gmail': 6 * 60 * 60 * 1000,
  // Calendar event cache: 30 min (sync route writes fresh data anyway)
  'gcal': 30 * 60 * 1000,
}

function getCacheTtl(key: string): number | undefined {
  for (const [prefix, ttl] of Object.entries(CACHE_TTL_MS)) {
    if (key.includes(prefix)) return ttl
  }
}

function saveGmailCache(key: string | null, signals: EmailSuggestion[], lastScanTs: number) {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify({ signals, lastScanTs }))
  } catch { /* quota / private mode */ }
}

// Returns how old a cached value is in ms, or Infinity if absent / no timestamp.
function cacheAgeMs(key: string | null): number {
  if (!key) return Infinity
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return Infinity
    const parsed = JSON.parse(raw) as { ts?: number }
    if (typeof parsed?.ts === 'number') return Date.now() - parsed.ts
  } catch { /* ignore */ }
  return Infinity
}

function readCache<T>(key: string | null): T | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { v: T; ts: number } | T
    // Support both legacy bare values and new timestamped wrapper
    if (parsed && typeof parsed === 'object' && 'v' in (parsed as object) && 'ts' in (parsed as object)) {
      const { v, ts } = parsed as { v: T; ts: number }
      const ttl = getCacheTtl(key)
      if (ttl && Date.now() - ts > ttl) {
        localStorage.removeItem(key)
        return null
      }
      return v
    }
    return parsed as T
  } catch {
    return null
  }
}

function writeCache(key: string | null, value: unknown) {
  if (!key) return
  try {
    const ttl = getCacheTtl(key)
    // Only wrap in timestamped envelope for keys that have a TTL
    const entry = ttl ? { v: value, ts: Date.now() } : value
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    /* quota / private mode — ignore */
  }
}

export function CommandCenter() {
  const router = useRouter()
  const { user } = useAuth()
  const { open: openCapture } = useCapture()
  const { isConnected, loading: tokensLoading, getFreshTokens } = useGoogleTokens()
  const { familyId } = useFamily()
  const { toast } = useToast()

  const { data: members, update: updateMember } = useFirestore<FamilyMember>('members')
  const { data: localEvents } = useFirestore<CalendarEvent>('events')
  const { data: tasks, update: updateTask, create: createTask } = useFirestore<Task>('tasks')
  const { data: reminders, update: updateReminder } = useFirestore<FamilyReminder>('reminders')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: plans } = useFirestore<Plan>('plans')
  const { data: lists } = useFirestore<SmartList>('lists')
  const { data: memories, create: createMemory, update: updateMemory } = useFirestore<FamilyMemory>('memories')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')
  const { data: eventContexts, create: createEventContext } = useFirestore<EventContext>('eventContext')

  const profile = profiles[0] ?? null

  const attnKey = familyId ? ATTN_PREFIX + familyId : null
  const gmailKey = familyId ? GMAIL_PREFIX + familyId : null
  const lastRunKey = familyId ? LAST_RUN_PREFIX + familyId : null
  const ctxSigKey = familyId ? CTX_SIG_PREFIX + familyId : null
  const lastRunSigKey = familyId ? LAST_RUN_SIG_PREFIX + familyId : null

  const [report, setReport] = useState<AttentionReport | null>(null)
  // Buffered result from a background run. Applied only when the user taps the
  // "Briefing updated" banner — prevents content jumping mid-scroll.
  const [pendingReport, setPendingReport] = useState<AttentionReport | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)        // true cold start only (no report yet)
  const [refreshing, setRefreshing] = useState(false)  // silent background update
  const [calendarFetching, setCalendarFetching] = useState(false) // Google Calendar fetch in progress
  // Greeting text as it streams in during a cold start, shown in place of the
  // skeleton so the user reads the headline ~2s in rather than waiting ~20s.
  const [streamingGreeting, setStreamingGreeting] = useState('')
  // Cards as they stream in during a cold start — each appears the instant the
  // model finishes writing it, so the briefing fills in like Copilot's prose
  // instead of all cards popping in at once when the full JSON parses.
  const [streamingItems, setStreamingItems] = useState<AttentionItem[]>([])
  const [googleLoaded, setGoogleLoaded] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const lastRun = useRef<number>(0)
  // ctxSignature that was active when the AI last actually ran. Compared in the
  // periodic auto-run to detect unchanged data so we can skip the AI call.
  const lastRunSig = useRef<string>('')
  // When true, the next engine run writes directly to report (not pendingReport),
  // even when called silently. Used after cache reset or when the cached report
  // is stale, so the fresh result appears immediately without a "tap to see" step.
  const forceDirectRef = useRef(false)
  const deepToken = useRef<number>(0)
  const engineAbortRef = useRef<AbortController | null>(null)
  // Pending debounced engine run (see scheduleEngine + ENGINE_COALESCE_MS).
  const engineDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Each runEngine call gets a monotonically-increasing token. The finally block
  // only clears loading state if it's still the current run — prevents an aborted
  // run's finally from clearing state owned by the newer run that aborted it.
  const runTokenRef = useRef(0)
  // Refs so the visibilitychange handler can read current state without stale closures.
  const engineErrorRef = useRef<string | null>(null)
  const reportRef = useRef<AttentionReport | null>(null)
  useEffect(() => { engineErrorRef.current = engineError }, [engineError])
  useEffect(() => { reportRef.current = report }, [report])
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [selfLinkDismissed, setSelfLinkDismissed] = useState(false)
  const [emailSuggestions, setEmailSuggestions] = useState<EmailSuggestion[]>([])
  const emailFetched = useRef(false)
  // Incrementing this forces the Google Calendar fetch effect to re-run, even
  // when its other deps (isConnected, familyId) haven't changed.
  const [calSyncKey, setCalSyncKey] = useState(0)
  // Titles of items the user has dismissed this session. Persisted to localStorage
  // so they survive a page refresh (cleared when a fresh briefing arrives).
  const DISMISS_PREFIX = 'fam-dismissed-'
  const dismissKey = familyId ? DISMISS_PREFIX + familyId : null
  const [dismissedTitles, setDismissedTitles] = useState<Set<string>>(new Set())
  // Titles of recommendations the user has acted on (tapped "Add"). Persisted so
  // the card stays gone across page refreshes and the AI doesn't re-surface them.
  const COMPLETED_PREFIX = 'fam-completed-'
  const completedKey = familyId ? COMPLETED_PREFIX + familyId : null
  const [completedTitles, setCompletedTitles] = useState<Set<string>>(new Set())
  // Event assignment suggestions the user has skipped. Key = "title|YYYY-MM-DD".
  const skipEaKey = familyId ? SKIP_EA_PREFIX + familyId : null
  const [skippedAssignments, setSkippedAssignments] = useState<Set<string>>(new Set())
  // Person sections that the user has collapsed — stored by section key (person name or "Family").
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  // When a user dismisses something, offer to teach the assistant once.
  const [teachPrompt, setTeachPrompt] = useState<{ title: string; reason: string } | null>(null)
  // Optimistic assignment overrides keyed by item title, so the "for" / responsible
  // chips update instantly on assign without waiting for the engine to re-run.
  // Keyed by member ID (not email) because kids/pets often have no email — emails
  // collide on '' and would select multiple members at once.
  const [assignmentOverrides, setAssignmentOverrides] = useState<
    Record<string, { responsibleId?: string; forIds?: string[] }>
  >({})
  const REPORT_TTL_MS = 4 * 60 * 60 * 1000

  // Clear all per-family localStorage caches and trigger a fresh Google Calendar
  // sync + engine run — WITHOUT wiping the current report from the screen.
  const clearCaches = useCallback(() => {
    if (!familyId) return
    // Include the dismissed-items list so "Reset cached data" also brings back
    // any cards the user dismissed (e.g. an accidental tap on the X).
    const prefixes = [ATTN_PREFIX, GMAIL_PREFIX, LAST_RUN_PREFIX, CTX_SIG_PREFIX, LAST_RUN_SIG_PREFIX, DISMISS_PREFIX, COMPLETED_PREFIX, SKIP_EA_PREFIX]
    prefixes.forEach((p) => {
      try { localStorage.removeItem(p + familyId) } catch { /* ignore */ }
    })
    setDismissedTitles(new Set())
    setCompletedTitles(new Set())
    lastRun.current = 0
    lastCtxSig.current = ''
    lastRunSig.current = ''
    setEngineError(null)
    setPendingReport(null)
    // Next run bypasses the pendingReport buffer so the corrected data appears
    // immediately instead of waiting for a "tap to see" interaction.
    forceDirectRef.current = true
    // Re-trigger the Google Calendar fetch, which will overwrite Firestore with
    // the current Google Calendar state (removing any phantom deleted events).
    setCalSyncKey((k) => k + 1)
  }, [familyId])

  // Hydrate everything from cache the moment the family id is known, so a
  // returning visit paints a complete page on the first frame.
  useEffect(() => {
    if (!familyId) return
    const savedLastRun = readCache<number>(lastRunKey)
    if (savedLastRun) lastRun.current = savedLastRun
    // Always restore the cached report so the user sees content immediately.
    // If it's older than the TTL, mark the next engine run as direct (not buffered)
    // so fresh content replaces it immediately instead of sitting in pendingReport.
    const reportAge = savedLastRun ? Date.now() - savedLastRun : Infinity
    const r = readCache<AttentionReport>(attnKey)
    if (r) {
      setReport(r)
      if (reportAge > REPORT_TTL_MS) forceDirectRef.current = true
    }
    const em = readCache<EmailSuggestion[]>(gmailKey)
    if (em?.length) setEmailSuggestions(em)
    const dism = readCache<string[]>(dismissKey)
    if (dism?.length) setDismissedTitles(new Set(dism))
    const comp = readCache<string[]>(completedKey)
    if (comp?.length) setCompletedTitles(new Set(comp))
    const skipEa = readCache<string[]>(skipEaKey)
    if (skipEa?.length) setSkippedAssignments(new Set(skipEa))
    // Restore the last context signature so Firestore delivering the same data
    // on remount doesn't look like "new context" and trigger an immediate re-run.
    const savedCtxSig = readCache<string>(ctxSigKey)
    if (savedCtxSig) lastCtxSig.current = savedCtxSig
    const savedRunSig = readCache<string>(lastRunSigKey)
    if (savedRunSig) lastRunSig.current = savedRunSig
    setHydrated(true)
  }, [familyId, attnKey, gmailKey, dismissKey, lastRunKey, ctxSigKey, lastRunSigKey, skipEaKey])

  // ── Firestore cold-start cache ──────────────────────────────────────────────
  // localStorage only survives on the same device + browser. On a new device,
  // private browsing session, or after the user clears storage, there is no
  // cached briefing and the cold-start generation takes 30-60s. We solve this by
  // also caching the last good briefing in Firestore (per user). This effect reads
  // that cache once on mount so cold starts show content in ~300ms regardless of
  // device or storage state. It only runs when localStorage had nothing.
  useEffect(() => {
    if (!hydrated || report || !familyId || !user?.email) return
    const emailKey = user.email.replace(/[@.]/g, '_')
    getDoc(doc(db, 'families', familyId, 'briefings', emailKey))
      .then((snap) => {
        if (!snap.exists()) return
        const cached = snap.data() as { report: AttentionReport; generatedAt: string }
        if (!cached?.report || !cached?.generatedAt) return
        const ageMs = Date.now() - new Date(cached.generatedAt).getTime()
        // If the Firestore briefing is too stale, still show it but flag the next
        // engine run as direct (not buffered) so fresh content replaces it immediately.
        if (ageMs > REPORT_TTL_MS) { forceDirectRef.current = true }
        setReport((prev) => {
          if (prev) return prev  // localStorage won the race — keep it
          lastRun.current = new Date(cached.generatedAt).getTime()
          if (lastRunKey) writeCache(lastRunKey, lastRun.current)
          return cached.report
        })
      })
      .catch(() => { /* non-fatal — continue without Firestore cache */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, familyId, user?.email])

  // Persist every fresh briefing to Firestore (fire-and-forget) so the cold-start
  // read above always has an up-to-date result, even on new devices. Keyed by
  // generatedAt so this only fires when a genuinely new report arrives.
  useEffect(() => {
    if (!report?.generatedAt || !familyId || !user?.email) return
    const emailKey = user.email.replace(/[@.]/g, '_')
    setDoc(
      doc(db, 'families', familyId, 'briefings', emailKey),
      { forEmail: user.email, generatedAt: report.generatedAt, report },
    ).catch(() => { /* non-fatal */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.generatedAt, familyId, user?.email])

  // Scan Gmail incrementally — only emails newer than the last scan.
  // Cache stores { signals, lastScanTs } so we never re-process seen emails.
  // Haiku is skipped entirely when Gmail reports no new messages.
  const GMAIL_CHECK_INTERVAL = 2 * 60 * 60 * 1000 // re-check every 2 h
  useEffect(() => {
    if (!isConnected || emailFetched.current) return
    emailFetched.current = true

    // Read structured cache (backward-compat: old cache may be a bare array)
    let existingSignals: EmailSuggestion[] = []
    let lastScanTs = 0
    if (gmailKey) {
      try {
        const raw = localStorage.getItem(gmailKey)
        if (raw) {
          const parsed = JSON.parse(raw) as
            | { v: { signals: EmailSuggestion[]; lastScanTs: number }; ts: number }
            | { signals: EmailSuggestion[]; lastScanTs: number }
            | EmailSuggestion[]
          // Unwrap timestamped envelope from the previous TTL implementation
          const inner = 'v' in parsed ? (parsed as { v: unknown }).v : parsed
          if (Array.isArray(inner)) {
            // Legacy bare array — treat as signals with unknown scan time
            existingSignals = inner as EmailSuggestion[]
          } else {
            const typed = inner as { signals: EmailSuggestion[]; lastScanTs: number }
            existingSignals = typed.signals ?? []
            lastScanTs = typed.lastScanTs ?? 0
          }
        }
      } catch { /* corrupt cache — start fresh */ }
    }

    // Hydrate state immediately with what we already have
    if (existingSignals.length > 0) setEmailSuggestions(existingSignals)

    // Skip the network call if we checked recently
    if (lastScanTs && Date.now() - lastScanTs < GMAIL_CHECK_INTERVAL) return

    let cancelled = false
    ;(async () => {
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return
      try {
        const res = await fetch('/api/gmail-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            members: members.map((m) => ({ name: m.name, role: m.role })),
            // Tell the server to only fetch emails newer than our last scan
            afterEpochMs: lastScanTs || undefined,
          }),
        })
        const data = await res.json()
        if (cancelled || !res.ok) return

        const nowTs = Date.now()
        const today = new Date().toISOString().split('T')[0]

        if (data.noNewEmails) {
          // Nothing new — just update the scan timestamp so we don't re-check too soon
          saveGmailCache(gmailKey, existingSignals, nowTs)
          return
        }

        if (Array.isArray(data.suggestions)) {
          const newSignals: EmailSuggestion[] = data.suggestions.filter(
            (s: EmailSuggestion) => s && s.title && (s.confidence ?? 1) >= 0.6,
          )
          // Merge: keep existing future-dated signals + add new ones (dedup by messageId)
          const existingIds = new Set(existingSignals.map((s) => s.messageId).filter(Boolean))
          const kept = existingSignals.filter((s) => !s.date || s.date >= today)
          const merged = [
            ...kept,
            ...newSignals.filter((s) => !s.messageId || !existingIds.has(s.messageId)),
          ]
          setEmailSuggestions(merged)
          saveGmailCache(gmailKey, merged, nowTs)
        }
      } catch { /* keep existing signals */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, gmailKey])

  // Sync Google Calendar events via the server-side incremental endpoint.
  // Deleted events arrive as status:'cancelled' in the delta — no full wipe needed.
  // The Firestore realtime listener (localEvents) picks up results automatically.
  useEffect(() => {
    let cancelled = false
    async function sync() {
      if (!familyId) { setGoogleLoaded(true); return }
      setGoogleLoaded(false)
      setCalendarFetching(true)
      try {
        if (isConnected) await getFreshTokens()
        if (cancelled) return
        const idToken = await user?.getIdToken()
        if (!idToken || cancelled) return
        await fetch('/api/calendar/sync', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        })
      } catch { /* keep existing Firestore data */ } finally {
        if (!cancelled) { setGoogleLoaded(true); setCalendarFetching(false) }
      }
    }
    sync()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId, calSyncKey])

  const events = localEvents

  // Build the request body shared by both the fast and deep passes.
  const buildEngineBody = useCallback((
    eventContext: { eventTitle: string; context: string }[],
    tier: 'fast' | 'deep',
  ) => {
    const inbox = emailSuggestions.map((s) => ({
      title: s.title,
      date: s.date,
      notes: s.notes,
      sourceEmailSubject: s.sourceEmailSubject,
      messageId: s.messageId,
      forNames: s.forNames,
    }))
    // Merge Copilot-created reminders (legacy collection) with Capture tasks
    // so the attention engine sees everything regardless of how it was added.
    const reminderAsTask: Task[] = reminders.map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes,
      isCompleted: r.isCompleted,
      completedAt: r.completedAt,
      dueDate: r.dueDate,
      assigneeEmail: r.assigneeEmail,
      priority: r.priority,
      recurrence: r.recurrence,
      relatedEventId: r.relatedEventId,
      source: 'ai' as const,
      createdAt: r.dueDate ?? new Date().toISOString(),
    }))
    const allTasks = [
      ...tasks,
      ...reminderAsTask.filter((r) => !tasks.some((t) => t.id === r.id)),
    ]
    // Only send events that are upcoming or still ongoing. Events that ended
    // more than 30 minutes ago are irrelevant to the briefing, and excluding
    // them prevents phantom deleted events (which linger in Firestore until the
    // next Google Calendar sync) from being flagged as upcoming appointments.
    // Use getTime() for comparison — ISO string comparison is unreliable when
    // mixed timezone formats are present (e.g. "-07:00" vs "Z" suffixes).
    const relevantCutoff = Date.now() - 30 * 60 * 1000
    const upcomingEvents = events.filter(
      (e) => new Date(e.end ?? e.start).getTime() >= relevantCutoff
    )

    // ── CLIENT-STAGE FILTERING (browser console) ─────────────────────────────
    // What the client ships to /api/ai/attention, and what it dropped/merged
    // first. The server then applies its own horizon + cap filters (see the
    // [ctx/*] logs in the Vercel function logs). Together these two log groups
    // give a complete picture of the pipeline from Firestore → model prompt.
    const dedupedReminders = reminderAsTask.filter((r) => !tasks.some((t) => t.id === r.id))
    console.log(
      `[client/engine] tier=${tier}` +
      ` | events: firestore=${events.length} dropped_ended=${events.length - upcomingEvents.length} shipped=${upcomingEvents.length}` +
      ` | tasks: firestore=${tasks.length} reminders=${reminders.length} merged_in=${dedupedReminders.length} shipped=${allTasks.length}` +
      ` | members=${members.length} memories=${memories.length} inbox=${inbox.length}` +
      ` chores=${chores.length} plans=${plans.length} lists=${lists.length}` +
      ` eventContext=${eventContext.length} suppressed=${dismissedTitles.size + completedTitles.size}`
    )

    return {
      members, events: upcomingEvents, tasks: allTasks, chores, plans, lists, eventContext,
      profile, memories, inbox, tier,
      currentUserEmail: user?.email ?? undefined,
      currentUserName: user?.displayName ?? undefined,
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Titles dismissed or already acted on — the engine must not re-surface them.
      suppressedTitles: [...Array.from(dismissedTitles), ...Array.from(completedTitles)],
    }
  }, [members, events, tasks, reminders, chores, plans, lists, profile, memories, emailSuggestions, user, dismissedTitles, completedTitles])

  const runEngine = useCallback(async (overrideContext?: { eventTitle: string; context: string }[], silent?: boolean) => {
    // Cancel any previous in-flight request before starting a new one.
    engineAbortRef.current?.abort()
    const controller = new AbortController()
    engineAbortRef.current = controller
    const myRunToken = ++runTokenRef.current

    // isPending: result goes into pendingReport (shows "Briefing updated" banner).
    // isForced: bypasses pendingReport so the result writes directly to report
    // (used by manual refresh and clearCaches so the update appears immediately
    // without requiring a banner tap).
    const isForced = forceDirectRef.current
    const isPending = !!(silent && report) && !isForced
    forceDirectRef.current = false

    // Never show the streaming skeleton when a cached report is on screen.
    // Streaming only appears on cold starts (no report at all).
    if (!silent || !report) setLoading(true)
    else setRefreshing(true)

    const runAt = Date.now()
    lastRun.current = runAt
    const engineStart = performance.now()
    let engineTTFT = -1
    console.log(`[perf:engine] start events=${events.length} tasks=${tasks.length + reminders.length} members=${members.length}`)
    const myToken = ++deepToken.current

    try {
      const eventContext = overrideContext ??
        eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))

      const body = JSON.stringify(buildEngineBody(eventContext, 'fast'))
      console.log(`[perf:engine] request payload=${(body.length / 1024).toFixed(1)}KB`)
      const fetchStart = performance.now()
      const res = await fetch('/api/ai/attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
      console.log(`[perf:engine] response headers in ${Math.round(performance.now() - fetchStart)}ms (network + server start)`)

      // Pre-stream failures (bad request, missing key) still come back as JSON.
      if (!res.ok || !res.body) {
        let msg = 'Something went wrong. Tap refresh to try again.'
        try { const d = await res.json(); msg = d.error ?? msg } catch { /* keep default */ }
        setEngineError(msg)
        lastRun.current = 0
        return
      }

      // Streaming skeleton only on cold starts — never when a report already exists.
      const progressive = !silent || !report
      if (progressive) setStreamingItems([])
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let rawText = ''
      let finalReport: (AttentionReport & { error?: string }) | null = null
      let streamError: string | null = null

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let evt: { t?: string; d?: string; error?: string; item?: AttentionItem } & Partial<AttentionReport>
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.t === 'open') {
            // Server sends this right after context is built, before the AI call.
            const preAi = Math.round(performance.now() - engineStart)
            console.log(`[perf:engine] server_open=${preAi}ms — request arrived + context built, AI call starting now`)
          } else if (evt.t === 'delta') {
            if (engineTTFT === -1 && evt.d) {
              engineTTFT = Math.round(performance.now() - engineStart)
              console.log(`[perf:engine] ttft=${engineTTFT}ms — first token from Anthropic reached browser`)
            }
            if (progressive && evt.d) {
              rawText += evt.d
              const g = extractPartialGreeting(rawText)
              if (g) setStreamingGreeting(g)
            }
          } else if (evt.t === 'item') {
            const itemMs = Math.round(performance.now() - engineStart)
            const itemEvt = evt as { t: string; index?: number; item?: AttentionItem }
            console.log(`[perf:engine] item[${itemEvt.index ?? '?'}] at ${itemMs}ms — "${itemEvt.item?.title?.slice(0, 40) ?? '?'}"`)
            if (progressive && itemEvt.item) {
              const card = itemEvt.item
              setStreamingItems((prev) =>
                prev.some((p) => p.id === card.id) ? prev : [...prev, card]
              )
            }
          } else if (evt.t === 'final') {
            const total = Math.round(performance.now() - engineStart)
            const stream = engineTTFT > 0 ? total - engineTTFT : total
            console.log(
              `[perf:engine] DONE total=${total}ms` +
              ` | breakdown: ttft=${engineTTFT}ms (prompt-read + first-token)` +
              ` + stream=${stream}ms (output generation)` +
              ` | items=${(evt as unknown as AttentionReport).items?.length ?? 0}`
            )
            finalReport = evt as AttentionReport
          } else if (evt.t === 'error') {
            streamError = evt.error ?? 'Something went wrong. Tap refresh to try again.'
          }
        }
      }

      if (streamError) {
        // Keep the last good report on screen; just surface the retry affordance.
        setEngineError(streamError)
        lastRun.current = 0
      } else if (finalReport) {
        const data = finalReport
        if (isPending) {
          setPendingReport(data)
        } else {
          setReport(data)
          setPendingReport(null)
        }
        setEngineError(null)
        writeCache(attnKey, data)
        writeCache(lastRunKey, runAt)
        // Record which data snapshot produced this briefing. If the same
        // snapshot is still current when the next throttle fires, skip the AI.
        lastRunSig.current = lastCtxSig.current
        if (lastRunSigKey) writeCache(lastRunSigKey, lastRunSig.current)
      } else {
        // Stream ended without a final payload — treat as a soft failure.
        setEngineError('Could not load your briefing. Tap refresh to try again.')
        lastRun.current = 0
      }
    } catch (err) {
      // iOS Safari aborts in-flight fetches when the app goes to the background.
      // Don't show an error for intentional aborts — the visibilitychange handler
      // will retry automatically when the user returns.
      if (err instanceof Error && err.name === 'AbortError') return
      setEngineError('Could not reach the server. Check your connection and tap refresh.')
      lastRun.current = 0
    } finally {
      // Only clear loading state if this is still the active run. An aborted
      // run must not clear the state set by the newer run that replaced it.
      if (myRunToken === runTokenRef.current) {
        setLoading(false)
        setRefreshing(false)
        setStreamingGreeting('')
        setStreamingItems([])
      }
    }
  }, [buildEngineBody, eventContexts, attnKey, report])

  // Debounced wrapper around runEngine. Multiple triggers firing within
  // ENGINE_COALESCE_MS of each other (the cold-load cascade: hydration →
  // calendar sync → inbox scan) collapse into a single run with the latest data.
  // On a cold start (no report yet) we show the skeleton immediately so the quiet
  // window isn't a blank screen, even though the actual run starts a beat later.
  const scheduleEngine = useCallback((silent: boolean) => {
    if (!silent) setLoading(true)
    if (engineDebounceRef.current) clearTimeout(engineDebounceRef.current)
    engineDebounceRef.current = setTimeout(() => {
      engineDebounceRef.current = null
      runEngine(undefined, silent)
    }, ENGINE_COALESCE_MS)
  }, [runEngine])

  // Cancel any pending debounced run if the component unmounts.
  useEffect(() => () => {
    if (engineDebounceRef.current) clearTimeout(engineDebounceRef.current)
  }, [])

  // Auto-run once the data we expect is loaded. Always silent when a report is
  // already on screen (cached or fresh) so content updates in place, never via a
  // skeleton flash. If Firestore already has events from a previous sync we can
  // start immediately — the Google Calendar sync will trigger a silent follow-up
  // refresh when it completes and the event fingerprint changes. We only hard-block
  // when there are literally no events yet, to avoid a meaningless empty briefing.
  useEffect(() => {
    if (!hydrated) return
    if (!googleLoaded && localEvents.length === 0) return  // no events at all yet
    if (members.length === 0) return
    if (Date.now() - lastRun.current < ENGINE_THROTTLE_MS) return
    // Core data-change optimization: if the data fingerprint hasn't changed since
    // the last AI run AND the cached briefing is still fresh enough for time-bucket
    // accuracy (within ENGINE_DATA_UNCHANGED_TTL_MS), skip the AI call entirely.
    // The change-detection effect below already handles the case where data *did*
    // change — this guard only suppresses the wasteful periodic "nothing changed" runs.
    const timeSinceLastRun = Date.now() - lastRun.current
    if (
      lastRunSig.current !== '' &&
      lastRunSig.current === lastCtxSig.current &&
      timeSinceLastRun < ENGINE_DATA_UNCHANGED_TTL_MS
    ) return
    // 15+ minutes have passed — silently update in the background if a cached
    // report is already on screen. Only run in foreground on cold starts.
    scheduleEngine(!!reportRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, googleLoaded, members.length, events.length > 0, tasks.length, reminders.length])

  // The inbox scan, durable memory, and profile often arrive a beat after the
  // first render. When they change, weave them into the briefing right away —
  // bypassing the throttle — so the assistant stays current without a flash.
  const completedCount = tasks.filter((t) => t.isCompleted).length + reminders.filter((r) => r.isCompleted).length
  // Include a fingerprint of the events so calendar data that syncs in AFTER the
  // first render (e.g. another family member's Google events arriving via the
  // server sync) immediately refreshes the briefing instead of waiting out the
  // 60s throttle. Using ids+starts catches replacements, not just count changes.
  const eventsFingerprint = events.map((e) => e.id).sort().join(',')
  const ctxSignature = `${emailSuggestions.length}|${memories.length}|${profile?.updatedAt ?? ''}|${completedCount}|${eventsFingerprint}`
  const lastCtxSig = useRef<string>('')
  const lastEmailCount = useRef<number>(0)
  const lastEventCount = useRef<number>(0)
  useEffect(() => {
    if (!hydrated) return
    if (lastCtxSig.current === ctxSignature) return
    const prev = lastCtxSig.current
    const prevEmailCount = lastEmailCount.current
    const prevEventCount = lastEventCount.current
    lastCtxSig.current = ctxSignature
    lastEmailCount.current = emailSuggestions.length
    lastEventCount.current = events.length
    writeCache(ctxSigKey, ctxSignature)
    // Skip on the very first hydration pass (prev was '' or the cached value).
    if (prev === '') return
    // Bypass the throttle when high-value data arrives for the first time after
    // the initial run. Both inbox signals and calendar events make the difference
    // between a shallow and a complete briefing, so we re-run immediately rather
    // than making the user wait up to 60 seconds or manually refresh.
    const inboxJustArrived = prevEmailCount === 0 && emailSuggestions.length > 0
    const eventsJustArrived = prevEventCount === 0 && events.length > 0
    if (!inboxJustArrived && !eventsJustArrived && Date.now() - lastRun.current < ENGINE_THROTTLE_MS) return
    // Data arrived mid-session — stay silent (buffered) so content doesn't jump
    // while the user is reading. Only inbox/event first-arrivals bypass the throttle.
    scheduleEngine(!!report)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxSignature, hydrated])

  // Poll Google Calendar every 5 minutes so new events show up without a
  // manual refresh. Also refresh immediately whenever the app returns to the
  // foreground — common on mobile when switching between apps.
  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(() => setCalSyncKey((k) => k + 1), 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [isConnected])

  // Auto-retry when the user returns to the app. iOS Safari aborts in-flight
  // fetches when a PWA is backgrounded; when the user comes back we want a
  // seamless retry rather than a stale error screen. Also kick a calendar
  // refresh on every foreground return so events are always up to date.
  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState !== 'visible') return
      // Always refresh calendar data when foregrounded.
      if (isConnected) setCalSyncKey((k) => k + 1)
      // If Copilot (or voice) made a calendar change, force a briefing re-run
      // so stale events don't linger. The flag is set by CopilotChat after any
      // confirmed action and by useRealtimeVoice after any tool execution.
      const calChanged = sessionStorage.getItem('cal-changed')
      if (calChanged) {
        try { sessionStorage.removeItem('cal-changed') } catch { /* non-fatal */ }
        lastRun.current = 0
      }
      const hasError = !!engineErrorRef.current
      const hasNoReport = !reportRef.current
      // Run briefing on foreground if: Copilot changed something, error needs
      // retry, no report yet, OR the cached briefing is older than REPORT_TTL_MS.
      // Simple foregrounding (switching apps briefly) does NOT trigger a run —
      // that's handled by the throttle and ctxSignature paths.
      const isStale = Date.now() - lastRun.current > REPORT_TTL_MS
      if (hasError || hasNoReport || calChanged || isStale) {
        setEngineError(null)
        // Only bypass the throttle for forced cases — stale checks respect it.
        if (calChanged || hasError || hasNoReport) lastRun.current = 0
        // Silent when a valid report is showing — don't replace it with a skeleton.
        const shouldBeSilent = !!(reportRef.current && !hasError && !hasNoReport)
        runEngine(undefined, shouldBeSilent)
      }
    }
    document.addEventListener('visibilitychange', handleVisible)
    return () => document.removeEventListener('visibilitychange', handleVisible)
  }, [isConnected, runEngine])

  // Assign an item to people. Two-sided: `forIds` is who it concerns (e.g. the
  // kids); `responsibleId` is who handles it (e.g. a parent). Keyed by member ID
  // because kids/pets often have no email. Persists in two ways:
  //  1. Optimistic on-screen override so the chips update instantly.
  //  2. For entity-backed items: write directly to the Firestore entity (event,
  //     task, or reminder) so the context includes [for:]/[responsible:] on next
  //     AI run without needing a family memory.
  //  3. For truly inferred items (no backing entity): write a family memory as
  //     the only available durable store.
  async function assignItem(item: AttentionItem, forIds: string[], responsibleId?: string) {
    setAssignmentOverrides((prev) => ({
      ...prev,
      [item.title]: { responsibleId, forIds },
    }))

    const memberById = (id?: string) => members.find((m) => m.id === id)
    const forMembers = forIds.map(memberById).filter(Boolean) as FamilyMember[]
    const responsible = memberById(responsibleId)
    const forNames = forMembers.map((m) => m.name).join(', ')
    const respName = responsible?.name ?? ''

    let wroteToEntity = false

    if (item.sourceType === 'event' && familyId) {
      // Write forIds + assigneeId directly to the calendar event doc and fan out
      // to all occurrences of a recurring event so the calendar list stays in sync.
      // merge:true on Google Calendar sync means these fields are never overwritten.
      try {
        const eventsCol = collection(db, 'families', familyId, 'events')
        const targetEvent = item.sourceId
          ? localEvents.find((e) => e.id === item.sourceId)
          : localEvents.find((e) => e.title.toLowerCase() === item.title.toLowerCase())
        if (targetEvent) {
          const eventUpdate = {
            forIds,
            ...(responsibleId ? { assigneeId: responsibleId } : { assigneeId: deleteField() }),
          }
          if (targetEvent.recurringEventId) {
            // forIds (who the event is FOR) is stable across all occurrences — fan out.
            // assigneeId (who's RESPONSIBLE this week) is per-occurrence — only this one.
            const siblingsSnap = await getDocs(
              query(eventsCol, where('recurringEventId', '==', targetEvent.recurringEventId))
            )
            const evBatch = writeBatch(db)
            siblingsSnap.docs.forEach((d) => evBatch.update(d.ref, { forIds }))
            await evBatch.commit()
            await updateDoc(doc(eventsCol, targetEvent.id), {
              ...(responsibleId ? { assigneeId: responsibleId } : { assigneeId: deleteField() }),
            })
          } else {
            await updateDoc(doc(eventsCol, targetEvent.id), eventUpdate)
          }
          wroteToEntity = true
        }
      } catch { /* non-fatal */ }
    } else if (item.sourceType === 'task' || item.sourceType === 'reminder') {
      // Store forIds and assigneeId on the entity so resolveItem can read them
      // directly and the context includes [for:]/[assigned:] on the next AI run.
      const assigneeFields = responsible ? { assigneeId: responsible.id, assigneeEmail: responsible.email || undefined } : {}
      const t = item.sourceId
        ? tasks.find((x) => x.id === item.sourceId)
        : tasks.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      // Task has forIds; store both the subjects and the responsible person.
      if (t) { await updateTask({ ...t, forIds, ...assigneeFields }); wroteToEntity = true }
      const r = item.sourceId
        ? reminders.find((x) => x.id === item.sourceId)
        : reminders.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      // FamilyReminder doesn't have forIds — only persist the responsible person.
      if (r) { await updateReminder({ ...r, ...assigneeFields }); wroteToEntity = true }
    }

    // Only write a family memory for truly inferred items — ones with no backing
    // entity (or where the entity write failed). For entity-backed items the
    // entity itself is the durable store; the context already exposes assignments
    // as [for:]/[responsible:] so the AI picks them up on the next run.
    if (!wroteToEntity) {
      const marker = `Assignment · "${item.title}":`
      const parts: string[] = []
      if (forNames) parts.push(`it concerns ${forNames}`)
      if (respName) parts.push(`${respName} is responsible for handling it`)
      const text = `${marker} ${parts.join('; ')}.`
      const subjectEmails = Array.from(
        new Set([...forMembers, ...(responsible ? [responsible] : [])].map((m) => m.email || m.id))
      )
      try {
        const existing = memories.find((m) => m.text.startsWith(marker))
        if (existing) {
          await updateMemory({ ...existing, text, subjectEmails, createdAt: new Date().toISOString() })
        } else {
          await createMemory({
            id: generateId(),
            text,
            category: 'logistics',
            source: 'manual',
            subjectEmails,
            createdAt: new Date().toISOString(),
          } as FamilyMemory)
        }
      } catch { /* non-fatal */ }
    }

    const who = respName ? `${respName} (for ${forNames || 'the family'})` : forNames || 'the family'
    toast(`Assigned "${item.title}" — ${who}`, 'success')
    await runEngine(undefined, true)
  }

  async function completeTaskFromItem(item: AttentionItem) {
    // Hide it from view right away.
    setCompletedTitles((prev) => new Set(prev).add(item.title))
    const now = new Date().toISOString()
    const titleLower = item.title.toLowerCase()

    // 1. Try exact match by sourceId (most reliable — AI embeds the Firestore id)
    if (item.sourceId) {
      const t = tasks.find((x) => x.id === item.sourceId)
      if (t) { await updateTask({ ...t, isCompleted: true, completedAt: now }); return }
      const r = reminders.find((x) => x.id === item.sourceId)
      if (r) { await updateReminder({ ...r, isCompleted: true, completedAt: now }); return }
    }

    // 2. Exact title match across both collections
    const tExact = tasks.find((x) => x.title.toLowerCase() === titleLower)
    if (tExact) { await updateTask({ ...tExact, isCompleted: true, completedAt: now }); return }
    const rExact = reminders.find((x) => x.title.toLowerCase() === titleLower)
    if (rExact) { await updateReminder({ ...rExact, isCompleted: true, completedAt: now }); return }

    // 3. Fuzzy title match (AI may rephrase task titles)
    const tFuzzy = tasks.find((x) => titleLower.includes(x.title.toLowerCase()) || x.title.toLowerCase().includes(titleLower))
    if (tFuzzy) { await updateTask({ ...tFuzzy, isCompleted: true, completedAt: now }); return }
    const rFuzzy = reminders.find((x) => titleLower.includes(x.title.toLowerCase()) || x.title.toLowerCase().includes(titleLower))
    if (rFuzzy) { await updateReminder({ ...rFuzzy, isCompleted: true, completedAt: now }); return }

    // 4. Nothing matched — create a completed task so the check-off is never silently lost
    await createTask({
      id: generateId(),
      title: item.title,
      notes: item.reason,
      isCompleted: true,
      completedAt: now,
      priority: 'none',
      source: 'ai',
      createdAt: now,
    } as Task)
  }

  // Resolve a list of names to member ids, used when turning AI suggestions into tasks.
  function resolveForIds(names?: string[]): string[] {
    if (!names?.length) return []
    return names
      .map((n) => resolveMemberRef(members, n))
      .filter(Boolean)
      .map((m) => m!.id)
  }

  async function saveItemAsTask(title: string, detail?: string, forNames?: string[]) {
    if (!familyId) return
    const forIds = resolveForIds(forNames)
    const self = user?.email ? members.find((m) => m.email?.toLowerCase() === user.email!.toLowerCase()) : undefined
    await createTask({
      id: generateId(),
      title,
      notes: detail,
      isCompleted: false,
      priority: 'high',
      source: 'ai',
      // Signed-in user is responsible; forIds tracks who it's about
      ...(self ? { assigneeId: self.id, assigneeEmail: self.email ?? undefined } : {}),
      ...(forIds.length ? { forIds } : {}),
      createdAt: new Date().toISOString(),
    } as Task)
    toast(`Saved "${title}" as a task`, 'success')
  }

  // Acting on a recommendation creates the to-do directly and clears the card,
  // rather than popping the Capture sheet or handing off to Copilot. One tap,
  // a confirmation toast, done — the recommendation is "nice to do", so it
  // lands at medium priority instead of high.
  async function addRecommendationAsTask(title: string, rationale: string, forNames?: string[]) {
    if (!familyId) return
    // Suppress the card immediately regardless — don't ask twice.
    setCompletedTitles((prev) => {
      const next = new Set(prev).add(title)
      writeCache(completedKey, Array.from(next))
      return next
    })
    // Dedup: if an open task with the same title already exists, skip creation.
    const titleLower = title.toLowerCase()
    const alreadyExists = [...tasks, ...reminders].some(
      (t) => !t.isCompleted && t.title.toLowerCase() === titleLower,
    )
    if (alreadyExists) {
      toast(`"${title}" is already in your tasks`, 'info')
      return
    }
    const forIds = resolveForIds(forNames)
    const self = user?.email ? members.find((m) => m.email?.toLowerCase() === user.email!.toLowerCase()) : undefined
    await createTask({
      id: generateId(),
      title,
      notes: rationale,
      isCompleted: false,
      priority: 'medium',
      source: 'ai',
      ...(self ? { assigneeId: self.id, assigneeEmail: self.email ?? undefined } : {}),
      ...(forIds.length ? { forIds } : {}),
      createdAt: new Date().toISOString(),
    } as Task)
    toast(`Added "${title}" to your tasks`, 'success')
  }

  // If the signed-in user isn't linked to a family-member profile, the AI can't
  // tell which person "you" are. Offer a one-tap link.
  const selfLinked = !!user?.email &&
    members.some((m) => m.email?.toLowerCase() === user.email!.toLowerCase())

  async function linkSelf(m: FamilyMember) {
    if (!user?.email) return
    await updateMember({ ...m, email: user.email })
    runEngine(undefined, true)
  }

  // Tapping the briefing carries it into Copilot as the opening message so the
  // user can ask follow-ups or have the assistant act on what it just told them.
  function openBriefingInCopilot(greetingText: string) {
    try { sessionStorage.setItem('copilot-seed', greetingText) } catch { /* non-fatal */ }
    router.push('/copilot')
  }

  // Debug mode (set in Settings) surfaces a "trace" affordance on cards so the
  // user can ask the AI exactly where a piece of info came from.
  const [debugMode, setDebugMode] = useState(false)
  useEffect(() => {
    const sync = () => setDebugMode(isAiDebugEnabled())
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])

  // Hand a card off to Copilot with an auto-sent question asking it to trace the
  // sources of this exact item. Copilot answers with citations (debug mode is on).
  function traceInCopilot(question: string) {
    try { sessionStorage.setItem('copilot-ask', question) } catch { /* non-fatal */ }
    router.push('/copilot')
  }

  function traceItem(item: AttentionItem) {
    const lines = [
      'Debug: trace where this briefing card came from. Cite every source.',
      `Card title: "${item.title}"`,
      `Reason shown: "${item.reason}"`,
      `Source type: ${item.sourceType}${item.sourceId ? ` (id: ${item.sourceId})` : ''}`,
      item.dueAt ? `Due at: ${item.dueAt}` : '',
      item.startBy ? `Start by: ${item.startBy}` : '',
      'Tell me exactly where each fact came from (which memory id, member profile field, calendar event, or tool), show how any dates or day-names were derived from the reference table, and flag anything uncertain or contradictory.',
    ].filter(Boolean)
    traceInCopilot(lines.join('\n'))
  }

  function traceProblem(p: PotentialProblem) {
    const lines = [
      'Debug: trace where this flagged problem came from. Cite every source.',
      `Problem: "${p.title}"`,
      `Detail shown: "${p.detail}"`,
      p.relatedDate ? `Related date: ${p.relatedDate}` : '',
      'Tell me exactly where each fact came from (which memory id, member profile field, calendar event, or tool), show how any dates were derived, and flag anything uncertain or contradictory.',
    ].filter(Boolean)
    traceInCopilot(lines.join('\n'))
  }

  // Merge a card-level patch (from CardChat context) into the live report without
  // triggering a full briefing regeneration. Only the cards the user chatted about
  // are updated; everything else is untouched.
  const patchReport = useCallback((
    updatedCards: AttentionItem[],
    removedIds: string[],
    newGreeting?: string,
  ) => {
    setReport((prev) => {
      if (!prev) return prev
      const items = prev.items
        .filter((i) => !removedIds.includes(i.id))
        .map((i) => updatedCards.find((u) => u.id === i.id) ?? i)
      return { ...prev, items, greeting: newGreeting ?? prev.greeting }
    })
  }, [])

  function dismissItem(title: string) {
    setDismissedTitles((prev) => {
      const next = new Set(prev).add(title)
      writeCache(dismissKey, Array.from(next))
      return next
    })
    // Surface the teach prompt briefly so they can give feedback
    setTeachPrompt({ title, reason: '' })
  }

  // Reverse a dismissal (e.g. an accidental X tap): un-hide the card and stop
  // suppressing it so it returns to the briefing on the next run.
  function undoDismiss(title: string) {
    setDismissedTitles((prev) => {
      const next = new Set(prev)
      next.delete(title)
      writeCache(dismissKey, Array.from(next))
      return next
    })
    setTeachPrompt(null)
  }

  // An item stays in its list slot while its teach prompt is open, so the
  // feedback box appears exactly where the dismissed card was — not at the top.
  function showInList(title: string) {
    if (teachPrompt?.title === title) return true
    return !dismissedTitles.has(title) && !completedTitles.has(title)
  }

  async function teachAssistant(title: string, feedback: string) {
    if (!feedback.trim()) { setTeachPrompt(null); return }
    try {
      // Tag this to the current user — it is their personal preference,
      // not a family-wide one. The attention engine reads these separately
      // and filters each person's briefing through their own learned model.
      await createMemory({
        id: generateId(),
        text: `Don't surface "${title}" type of thing — ${feedback}`,
        category: 'preference',
        subjectEmail: user?.email ?? undefined,
        source: 'manual',
        createdAt: new Date().toISOString(),
      } as FamilyMemory)
    } catch { /* non-fatal */ }
    setTeachPrompt(null)
  }

  const firstName = user?.displayName?.split(' ')[0] ?? 'there'
  const todayEvents = events
    .filter((e) => new Date(e.start).toDateString() === new Date().toDateString())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  const itemsByBucket = (b: AttentionBucket) => (report?.items ?? []).filter((i) => i.bucket === b)

  // Resolve per-item display props (members, task backing) once, then reuse for
  // both grouped and solo AttentionCard rendering.
  type ResolvedItem = {
    item: AttentionItem
    responsible?: FamilyMember
    forMembers: FamilyMember[]
    backedByRealItem: boolean
    isRecurring: boolean
  }
  function resolveItem(item: AttentionItem): ResolvedItem {
    const ov = assignmentOverrides[item.title]
    const byId = (id?: string) => members.find((m) => m.id === id)

    // Find the backing calendar event (if any) once, so we can derive both
    // backedByRealItem and isRecurring from the same lookup.
    const backedEvent = item.sourceType === 'event' && item.sourceId
      ? localEvents.find((e) => e.id === item.sourceId)
      : undefined
    const backedByRealItem = !!item.sourceId && (
      backedEvent !== undefined
      || tasks.some((t) => t.id === item.sourceId)
      || reminders.some((r) => r.id === item.sourceId)
    )
    const isRecurring = !!backedEvent?.recurringEventId

    // Priority 1: optimistic override set immediately when the user assigns
    if (ov) {
      return {
        item,
        responsible: byId(ov.responsibleId),
        forMembers: (ov.forIds ?? []).map(byId).filter(Boolean) as FamilyMember[],
        backedByRealItem,
        isRecurring,
      }
    }

    // Priority 2: read from Firestore entity when sourceId links us to one
    if (item.sourceId) {
      if (item.sourceType === 'event') {
        if (backedEvent && ((backedEvent.forIds?.length ?? 0) > 0 || backedEvent.assigneeId)) {
          return {
            item,
            responsible: byId(backedEvent.assigneeId),
            forMembers: (backedEvent.forIds ?? []).map((id) => byId(id)).filter(Boolean) as FamilyMember[],
            backedByRealItem: true,
            isRecurring,
          }
        }
      } else {
        // Keep task and reminder as separate typed variables — forIds only exists on Task
        const t = tasks.find((x) => x.id === item.sourceId)
        const r = !t ? reminders.find((x) => x.id === item.sourceId) : undefined
        const entity = t ?? r
        if (entity && (entity.assigneeId || entity.assigneeEmail || t?.forIds?.length)) {
          return {
            item,
            responsible: entity.assigneeId ? byId(entity.assigneeId) : (resolveMemberRef(members, entity.assigneeEmail) ?? undefined),
            forMembers: (t?.forIds ?? []).map((id: string) => byId(id)).filter(Boolean) as FamilyMember[],
            backedByRealItem: true,
            isRecurring,
          }
        }
      }
    }

    // Priority 3/4: fall back to AI output (hint when entity has no assignment yet; sole source for inferred items)
    return {
      item,
      responsible: resolveMemberRef(members, item.assigneeEmail) ?? undefined,
      forMembers: (item.forEmails ?? []).map((ref) => resolveMemberRef(members, ref)).filter(Boolean) as FamilyMember[],
      backedByRealItem,
      isRecurring,
    }
  }

  // Render a single ItemGroup as either a GroupedAttentionCard or a solo AttentionCard/TeachPrompt.
  function renderGroup(group: ItemGroup, color: string) {
    if (group.groupTitle) {
      const resolvedItems = group.items.map(resolveItem)
      return (
        <GroupedAttentionCard
          key={group.key}
          groupTitle={group.groupTitle}
          resolvedItems={resolvedItems}
          accent={color}
          allMembers={members}
          onCompleteItem={(item) => completeTaskFromItem(item)}
          onDismissItem={(title) => dismissItem(title)}
          onSaveTaskItem={(title, reason) => saveItemAsTask(title, reason)}
          onAssignItem={(item, f, r) => assignItem(item, f, r)}
          debugMode={debugMode}
          onTraceItem={traceItem}
          currentGreeting={report?.greeting ?? ''}
          allGroupItems={group.items}
          cardMembers={members}
          onPatch={patchReport}
        />
      )
    }
    const item = group.items[0]
    if (teachPrompt?.title === item.title) {
      return (
        <TeachPrompt
          key={item.id}
          title={item.title}
          onTeach={(feedback) => teachAssistant(item.title, feedback)}
          onDismiss={() => setTeachPrompt(null)}
          onUndo={() => undoDismiss(item.title)}
        />
      )
    }
    const { responsible, forMembers, backedByRealItem, isRecurring } = resolveItem(item)
    return (
      <AttentionCard
        key={item.id}
        item={item}
        accent={color}
        allMembers={members}
        responsible={responsible}
        forMembers={forMembers}
        backedByRealItem={backedByRealItem}
        isRecurring={isRecurring}
        onComplete={() => completeTaskFromItem(item)}
        onDismiss={() => dismissItem(item.title)}
        onSaveTask={() => saveItemAsTask(item.title, item.reason)}
        onAssign={(f, r) => assignItem(item, f, r)}
        debugMode={debugMode}
        onTrace={() => traceItem(item)}
        currentGreeting={report?.greeting ?? ''}
        cardMembers={members}
        onPatch={patchReport}
      />
    )
  }

  // Render the Family section with a "Needs Attention" / "Logistics" split when both kinds exist.
  function renderFamilySectionContent(groups: ItemGroup[], color: string) {
    const actionGroups = groups.filter((g) => g.items.some((i) => i.kind === 'action'))
    const logisticsGroups = groups.filter((g) => g.items.every((i) => i.kind !== 'action'))
    const hasBothKinds = actionGroups.length > 0 && logisticsGroups.length > 0

    function renderBucketedGroups(grps: ItemGroup[]) {
      return BUCKET_ORDER.map((bucket) => {
        const filtered = grps.filter((g) => g.bucket === bucket)
        if (!filtered.length) return null
        const meta = BUCKET_META[bucket]
        return (
          <div key={bucket}>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: meta.color }}>
                {meta.label}
              </span>
            </div>
            <div className="space-y-2 stagger-children">
              {filtered.map((g) => renderGroup(g, color))}
            </div>
          </div>
        )
      })
    }

    return (
      <>
        {actionGroups.length > 0 && (
          <div className="space-y-4">
            {hasBothKinds && (
              <p className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Needs Attention</p>
            )}
            {renderBucketedGroups(actionGroups)}
          </div>
        )}
        {logisticsGroups.length > 0 && (
          <div className={`space-y-4 ${hasBothKinds ? 'mt-5' : ''}`}>
            {hasBothKinds && (
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Logistics</p>
            )}
            {renderBucketedGroups(logisticsGroups)}
          </div>
        )}
      </>
    )
  }

  // Visible items partitioned into person-first sections, each section internally grouped by groupKey.
  const sections = useMemo(() => {
    const visible = (report?.items ?? []).filter((i) => showInList(i.title))
    return buildSections(visible, members, user?.email)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.items, dismissedTitles, completedTitles, members, user?.email])

  const busy = loading || refreshing

  // Which assignment card is showing the "pick the right person" member picker.
  const [correctingKey, setCorrectingKey] = useState<string | null>(null)

  // Event assignment suggestions: filter out already-skipped and already-assigned ones.
  const pendingAssignments = useMemo<EventAssignmentSuggestion[]>(() => {
    if (!report?.eventAssignments?.length) return []
    return report.eventAssignments.filter((s) => {
      // Only show suggestions where the AI named a specific person
      if (!s.forNames?.length) return false
      if (skippedAssignments.has(`${s.eventTitle}|${s.eventDate}`)) return false
      const event = events.find(
        (e) => e.title === s.eventTitle && e.start.startsWith(s.eventDate)
      )
      return !event?.forIds?.length
    })
  }, [report?.eventAssignments, skippedAssignments, events])

  // Fuzzy-match a calendar event by title + date. The AI's generated title rarely
  // exactly matches the real event title (spaces, casing, truncation). We try
  // progressively looser matches before giving up.
  function findMatchingCalendarEvent(title: string, date: string): CalendarEvent | undefined {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const normTitle = norm(title)
    const sameDay = events.filter((e) => e.start.startsWith(date))
    if (!sameDay.length) return undefined
    // 1. Exact title
    const exact = sameDay.find((e) => e.title === title)
    if (exact) return exact
    // 2. Normalized ("Hair cut" → "haircut" vs "Haircut" → "haircut")
    const byNorm = sameDay.find((e) => norm(e.title) === normTitle)
    if (byNorm) return byNorm
    // 3. One normalized title contains the other
    const byContains = sameDay.find((e) => {
      const et = norm(e.title)
      return et.includes(normTitle) || normTitle.includes(et)
    })
    if (byContains) return byContains
    // 4. Word overlap — ≥60% of the AI's significant words appear in the event title
    const sigWords = (s: string) => s.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
    const aiWords = sigWords(title)
    if (!aiWords.length) return undefined
    return sameDay.find((e) => {
      const evWords = new Set(sigWords(e.title))
      return aiWords.filter((w) => evWords.has(w)).length / aiWords.length >= 0.6
    })
  }

  // Confirm an event assignment — optionally with different names than the AI suggested.
  // Applies optimistic removal immediately so the card disappears on tap.
  const confirmEventAssignment = useCallback(async (s: EventAssignmentSuggestion, overrideNames?: string[]) => {
    if (!familyId) return
    const forNames = overrideNames ?? s.forNames
    const event = findMatchingCalendarEvent(s.eventTitle, s.eventDate)
    if (!event) {
      toast(`Couldn't find "${s.eventTitle}" in calendar — it may have been removed`, 'error')
      return
    }
    const resolvedIds = forNames
      .map((name) => resolveMemberRef(members, name)?.id)
      .filter((id): id is string => Boolean(id))
    if (!resolvedIds.length) {
      toast(`Couldn't match that name to a family member — tap "Pick someone else" to choose manually`, 'error')
      return
    }
    // Optimistic: remove the card immediately without waiting for Firestore.
    const key = `${s.eventTitle}|${s.eventDate}`
    const next = new Set(Array.from(skippedAssignments).concat(key))
    setSkippedAssignments(next)
    setCorrectingKey(null)
    try {
      await updateDoc(doc(db, 'families', familyId, 'events', event.id), { forIds: resolvedIds })
      toast(`"${event.title}" assigned to ${forNames.join(' & ')}`, 'success')
      writeCache(skipEaKey, Array.from(next))
    } catch (err) {
      console.error('Failed to assign event:', err)
      toast('Could not save — check your connection and try again', 'error')
      // Reverse the optimistic removal so the card comes back.
      setSkippedAssignments(skippedAssignments)
    }
  }, [familyId, events, members, skippedAssignments, skipEaKey])

  // Permanently dismiss a suggestion (X button). Persists across sessions.
  const dismissEventAssignment = useCallback((s: EventAssignmentSuggestion) => {
    const key = `${s.eventTitle}|${s.eventDate}`
    const next = new Set(Array.from(skippedAssignments).concat(key))
    setSkippedAssignments(next)
    writeCache(skipEaKey, Array.from(next))
    setCorrectingKey(null)
  }, [skippedAssignments, skipEaKey])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <TopProgressBar active={busy || calendarFetching} />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400 flex items-center gap-2 flex-wrap">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            {refreshing && (
              <span className="inline-flex items-center gap-1.5 text-xs text-blue-500 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Updating…
              </span>
            )}
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Good {greeting()}, {firstName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setPendingReport(null); forceDirectRef.current = true; runEngine(undefined, !!report) }}
            disabled={loading || calendarFetching}
            title={loading || calendarFetching ? 'Loading calendar…' : refreshing ? 'Updating — tap to refresh now' : 'Refresh briefing'}
            className={`mt-1 p-2.5 rounded-xl border shadow-card transition-all disabled:opacity-60 ${
              refreshing
                ? 'bg-blue-50 border-blue-200 text-blue-500 hover:bg-blue-100'
                : 'bg-white border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200'
            }`}
            aria-label="Refresh"
          >
            <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Pending briefing banner — appears when a background run finishes.
          Content stays frozen until the user explicitly taps to apply it. */}
      {pendingReport && !busy && (
        <button
          onClick={() => { setReport(pendingReport); setPendingReport(null) }}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-2xl bg-blue-600 text-white text-sm font-medium shadow-md active:opacity-80 transition-opacity animate-slide-down"
        >
          <Sparkles size={14} />
          Briefing updated — tap to see
        </button>
      )}

      {!tokensLoading && !isConnected && <ConnectGooglePrompt onConnect={() => router.push(`/api/auth/google?email=${user?.email ?? ''}`)} />}

      {/* Self-link: tell the assistant which member you are */}
      {members.length > 0 && !selfLinked && !selfLinkDismissed && user?.email && (
        <section className="rounded-2xl p-5 bg-blue-50 border border-blue-200 animate-slide-up">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
              <Sparkles size={16} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-blue-900">Which one is you?</h3>
              <p className="text-xs text-blue-700 mt-0.5">
                Link your profile so I know who &quot;you&quot; are and can personalize everything.
              </p>
            </div>
            <button
              onClick={() => setSelfLinkDismissed(true)}
              className="ml-auto text-blue-400 hover:text-blue-600"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <button
                key={m.id}
                onClick={() => linkSelf(m)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-blue-100 hover:border-blue-300 text-sm text-slate-700 transition-colors"
              >
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
                  style={{ background: `${m.colorHex}25` }}
                >
                  {m.emoji}
                </span>
                {m.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* AI greeting / briefing line */}
      {/* Engine error — shown instead of a blank screen when something goes wrong */}
      {engineError && !loading && (
        <div className="rounded-2xl p-4 bg-red-50 border border-red-200 flex items-start gap-3 animate-slide-up">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-800">Couldn't load your briefing</p>
            <p className="text-xs text-red-600 mt-0.5">{engineError}</p>
          </div>
          <button
            onClick={() => { setEngineError(null); runEngine(undefined, false) }}
            className="shrink-0 text-xs font-semibold text-red-700 hover:text-red-900 px-3 py-1.5 rounded-lg hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}


      {/* Empty state — shown when the engine ran but found nothing for this person */}
      {report && !loading &&
        (report.items ?? []).filter((i) => !dismissedTitles.has(i.title) && !completedTitles.has(i.title)).length === 0 &&
        (report.problems ?? []).filter((p) => !dismissedTitles.has(p.title)).length === 0 &&
        (report.recommendations ?? []).length === 0 && (
        <div className="rounded-2xl p-5 bg-slate-50 border border-slate-200 text-center animate-slide-up">
          <p className="text-2xl mb-2">✓</p>
          <p className="text-sm font-semibold text-slate-700">All clear</p>
          <p className="text-xs text-slate-500 mt-1">Nothing urgent for you right now. Have a great day!</p>
        </div>
      )}

      {/* Streaming view — shown for all foreground (loading=true) runs, which
          covers cold starts, manual refreshes, and stale-report auto-runs.
          Silent background refreshes use refreshing=true instead so the
          existing report never jumps while the user is scrolling. */}
      {loading && (
        <div className="space-y-6 animate-fade-in">
          {streamingGreeting ? (
            <div className="rounded-2xl p-5 bg-gradient-to-br from-blue-600 to-purple-700 text-white shadow-elevated animate-scale-in">
              <div className="flex items-start gap-3">
                <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
                <p className="text-[15px] leading-relaxed font-medium">{streamingGreeting}</p>
              </div>
            </div>
          ) : (
            <div className="skeleton h-20 w-full rounded-2xl" />
          )}
          {streamingItems.length > 0 ? (
            // Cards stream in one-by-one as the model writes them. These are slim
            // previews (title + reason); the full grouped/assignable cards render
            // once the authoritative 'final' report replaces this block.
            <div className="space-y-2 stagger-children">
              {streamingItems.map((it) => (
                <div
                  key={it.id}
                  className="rounded-2xl bg-white shadow-card p-4 animate-slide-up"
                  style={{ borderLeft: '3px solid #94a3b8' }}
                >
                  <p className="text-sm font-semibold text-slate-900">{it.title}</p>
                  {it.reason && (
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{it.reason}</p>
                  )}
                </div>
              ))}
              {/* A trailing shimmer hints more cards are still arriving. */}
              <div className="skeleton h-16 w-full rounded-2xl opacity-60" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-20 w-full rounded-2xl" />
              <div className="skeleton h-20 w-full rounded-2xl" />
            </div>
          )}
        </div>
      )}

      {/* GREETING — shown once briefing finishes loading. Tap to open in Copilot. */}
      {!loading && report?.greeting && (
        <button
          onClick={() => openBriefingInCopilot(report.greeting)}
          className="w-full rounded-2xl p-5 bg-gradient-to-br from-blue-600 to-purple-700 text-white shadow-elevated text-left hover:opacity-95 active:opacity-90 transition-opacity animate-scale-in"
        >
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium">{report.greeting}</p>
          </div>
        </button>
      )}

      {/* PERSON SECTIONS — hidden while streaming is active (loading=true). */}
      {!loading && report && sections.length > 0 && (
        <div className="space-y-6">
          {sections.map((section) => {
            const collapsed = collapsedSections.has(section.key)
            const color = section.member?.colorHex ?? '#64748B'
            const totalItems = section.groups.reduce((n, g) => n + g.items.length, 0)

            return (
              <section key={section.key}>
                {/* Section header — tap to collapse/expand */}
                <button
                  onClick={() =>
                    setCollapsedSections((prev) => {
                      const next = new Set(prev)
                      if (next.has(section.key)) next.delete(section.key)
                      else next.add(section.key)
                      return next
                    })
                  }
                  className="w-full flex items-center gap-3 mb-3"
                >
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0"
                    style={{ background: `${color}20` }}
                  >
                    {section.member?.emoji ?? '👨‍👩‍👧'}
                  </div>
                  <h2 className="flex-1 text-base font-bold text-slate-900 text-left">{section.key}</h2>
                  <span className="text-[11px] font-medium text-slate-400 shrink-0 mr-0.5">{totalItems}</span>
                  <ChevronDown
                    size={15}
                    className="text-slate-400 shrink-0 transition-transform duration-200"
                    style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                  />
                </button>

                {!collapsed && (
                  <div className="space-y-4">
                    {section.key === 'Family'
                      ? renderFamilySectionContent(section.groups, color)
                      : BUCKET_ORDER.map((bucket) => {
                          const groups = section.groups.filter((g) => g.bucket === bucket)
                          if (groups.length === 0) return null
                          const meta = BUCKET_META[bucket]
                          return (
                            <div key={bucket}>
                              <div className="flex items-center gap-2 mb-2">
                                <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: meta.color }}>
                                  {meta.label}
                                </span>
                              </div>
                              <div className="space-y-2 stagger-children">
                                {groups.map((group) => renderGroup(group, color))}
                              </div>
                            </div>
                          )
                        })
                    }
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {/* POTENTIAL PROBLEMS */}
      {!loading && report && (report.problems?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={AlertTriangle} color="#dc2626">Potential Problems</SectionLabel>
          <div className="space-y-2 stagger-children">
            {report.problems
              .filter((p) => showInList(p.title))
              .map((p) =>
                teachPrompt?.title === p.title ? (
                  <TeachPrompt
                    key={p.id}
                    title={p.title}
                    onTeach={(feedback) => teachAssistant(p.title, feedback)}
                    onDismiss={() => setTeachPrompt(null)}
                    onUndo={() => undoDismiss(p.title)}
                  />
                ) : (
                  <ProblemCard
                    key={p.id}
                    problem={p}
                    onSaveTask={() => saveItemAsTask(p.title, p.detail)}
                    onDismiss={() => dismissItem(p.title)}
                    onCopilot={(text) => openBriefingInCopilot(text)}
                    onCapture={(text) => openCapture({ text, autoAnalyze: true })}
                    debugMode={debugMode}
                    onTrace={() => traceProblem(p)}
                  />
                ),
              )}
          </div>
        </section>
      )}

      {/* COPILOT RECOMMENDATIONS */}
      {!loading && report && (report.recommendations?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={Lightbulb} color="#7c3aed">Copilot Recommendations</SectionLabel>
          <div className="space-y-2 stagger-children">
            {report.recommendations
              .filter((r) => showInList(r.title))
              .map((r) =>
                teachPrompt?.title === r.title ? (
                  <TeachPrompt
                    key={r.id}
                    title={r.title}
                    onTeach={(feedback) => teachAssistant(r.title, feedback)}
                    onDismiss={() => setTeachPrompt(null)}
                    onUndo={() => undoDismiss(r.title)}
                  />
                ) : (
                <div key={r.id} className="rounded-2xl p-4 bg-white shadow-card animate-slide-up flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                    <Lightbulb size={15} className="text-purple-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900">{r.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{r.rationale}</p>
                    {r.actionLabel && (() => {
                      // Most recommendations are a concrete to-do — tapping the
                      // action creates it directly with a confirmation toast and
                      // clears the card. Only genuinely conversational ones
                      // (actionType 'copilot') hand off to Copilot.
                      const toCopilot = r.actionType === 'copilot'
                      const Icon = toCopilot ? MessageCircle : Plus
                      return (
                        <button
                          onClick={() => toCopilot
                            ? openBriefingInCopilot(`${r.actionLabel}: ${r.title}. ${r.rationale}`)
                            : addRecommendationAsTask(r.title, r.rationale, r.forNames)}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-purple-600 hover:text-purple-800"
                        >
                          <Icon size={11} />
                          {r.actionLabel} →
                        </button>
                      )
                    })()}
                  </div>
                  <div className="flex items-start gap-1 shrink-0">
                    <button
                      onClick={() => dismissItem(r.title)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors"
                      title="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                ),
              )}
          </div>
        </section>
      )}

      {/* EVENT ASSIGNMENT CONFIRMATIONS */}
      {!loading && pendingAssignments.length > 0 && (
        <section>
          <SectionLabel icon={Users} color="#7c3aed">Confirm Event Assignments</SectionLabel>
          <div className="space-y-2 stagger-children">
            {pendingAssignments.map((s) => {
              const key = `${s.eventTitle}|${s.eventDate}`
              const isPicking = correctingKey === key
              const displayDate = (() => {
                try {
                  return new Date(s.eventDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
                } catch { return s.eventDate }
              })()
              return (
                <div key={key} className="rounded-2xl px-4 py-3 bg-white shadow-card animate-slide-up flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center shrink-0 mt-0.5">
                    <Users size={13} className="text-violet-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">"{s.eventTitle}"</p>
                    {!isPicking && (
                      <p className="text-xs text-slate-500 mt-0.5">{displayDate} · {s.reason}</p>
                    )}

                    {isPicking ? (
                      // Member picker — shown after tapping "Not quite"
                      <div>
                        <p className="text-xs text-slate-500 mt-1 mb-2">Who is this event for?</p>
                        <div className="flex flex-wrap gap-1.5">
                          {members.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => confirmEventAssignment(s, [m.name])}
                              className="text-xs font-medium text-slate-700 bg-slate-100 hover:bg-violet-100 hover:text-violet-700 px-2.5 py-1 rounded-lg transition-colors"
                            >
                              {m.name}
                            </button>
                          ))}
                          <button
                            onClick={() => dismissEventAssignment(s)}
                            className="text-xs text-slate-400 hover:text-slate-600 px-2.5 py-1 rounded-lg transition-colors"
                          >
                            No one specific
                          </button>
                        </div>
                      </div>
                    ) : (
                      // Default: confirm AI suggestion or open the picker
                      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                        <button
                          onClick={() => confirmEventAssignment(s)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 active:bg-violet-800 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          <Check size={11} /> Yes, for {s.forNames.join(' & ')}
                        </button>
                        <button
                          onClick={() => setCorrectingKey(key)}
                          className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
                        >
                          Pick someone else →
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => dismissEventAssignment(s)}
                    className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors shrink-0"
                    title="Dismiss — won't suggest this again"
                  >
                    <X size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* TODAY */}
      <section>
        <SectionLabel icon={CalIcon} color="#0f172a">Today</SectionLabel>
        {todayEvents.length === 0 ? (
          <div className="rounded-2xl p-6 bg-white shadow-card text-center">
            <p className="text-sm text-slate-400">Nothing scheduled today.</p>
            <button onClick={() => openCapture()} className="text-xs text-blue-600 font-medium mt-1">Capture something →</button>
          </div>
        ) : (
          <div className="rounded-2xl bg-white shadow-card divide-y divide-slate-50 overflow-hidden">
            {todayEvents.map((e) => (
              <div key={e.id} className="flex items-center gap-3 p-4">
                <div className="text-center w-12 shrink-0">
                  {e.isAllDay ? (
                    <span className="text-[10px] text-slate-400 font-medium uppercase">All day</span>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-slate-700">
                        {new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '')}
                      </p>
                    </>
                  )}
                </div>
                <span className="w-1 self-stretch rounded-full" style={{ background: e.color || '#3B82F6' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{e.title}</p>
                  {e.location && <p className="text-xs text-slate-400 truncate">{e.location}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Calendar link */}
      <div className="text-center -mt-1">
        <button
          onClick={() => router.push('/calendar')}
          className="text-xs text-slate-400 hover:text-slate-700 transition-colors"
        >
          Open full calendar →
        </button>
      </div>

      {/* Empty-state nudge */}
      {report && (report.items?.length ?? 0) === 0 && (report.problems?.length ?? 0) === 0 && (
        <div className="rounded-2xl p-8 bg-white shadow-card text-center">
          <div className="text-4xl mb-3">🌤️</div>
          <p className="text-sm font-medium text-slate-700">You&apos;re all clear.</p>
          <p className="text-xs text-slate-400 mt-1">Nothing needs your attention right now.</p>
        </div>
      )}

    </div>
  )
}

function ProblemCard({
  problem: p,
  onSaveTask,
  onDismiss,
  onCopilot,
  onCapture,
  debugMode,
  onTrace,
}: {
  problem: PotentialProblem
  onSaveTask: () => void
  onDismiss: () => void
  onCopilot: (text: string) => void
  // Opens the Capture dialog (which has a per-calendar event picker) pre-filled
  // with this problem, for "add to calendar" style actions.
  onCapture: (text: string) => void
  debugMode?: boolean
  onTrace?: () => void
}) {
  const [saved, setSaved] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (chatOpen && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [chatOpen])
  const severityBg = p.severity === 'high' ? '#fee2e2' : p.severity === 'medium' ? '#ffedd5' : '#fef9c3'
  const severityColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#ea580c' : '#a16207'
  const borderColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#f97316' : '#eab308'

  return (
    <div
      className="rounded-2xl p-4 bg-white shadow-card animate-slide-up"
      style={{ borderLeft: `3px solid ${borderColor}` }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900">{p.title}</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{p.detail}</p>
          {p.suggestedAction && (() => {
            // "capture" / "calendar" actions (e.g. "Add to calendar") open the
            // Capture dialog, which gives a real event view with a per-calendar
            // picker. Everything else is conversational → Copilot.
            const toCalendar = p.actionType === 'capture' || p.actionType === 'calendar'
            const captureText = [
              p.title,
              p.detail,
              p.relatedDate ? `Date: ${new Date(p.relatedDate).toLocaleDateString()}` : '',
            ].filter(Boolean).join('. ')
            return (
              <button
                onClick={() => toCalendar ? onCapture(captureText) : onCopilot(`${p.title}. ${p.detail} — ${p.suggestedAction}`)}
                className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 mt-2 font-medium"
              >
                {toCalendar
                  ? <CalIcon size={11} className="shrink-0" />
                  : <MessageCircle size={11} className="shrink-0" />}
                {p.suggestedAction} →
              </button>
            )
          })()}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full"
            style={{ background: severityBg, color: severityColor }}
          >
            {p.severity}
          </span>
          {debugMode && onTrace && (
            <button
              onClick={onTrace}
              className="p-1.5 rounded-lg text-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="Trace sources (debug)"
            >
              <Bug size={14} />
            </button>
          )}
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={cn(
              'p-1.5 rounded-lg transition-colors',
              chatOpen ? 'text-blue-600 bg-blue-50' : 'text-slate-300 hover:text-blue-500 hover:bg-blue-50',
            )}
            title="Ask AI"
          >
            <MessageCircle size={14} />
          </button>
          <button
            onClick={() => { setSaved(true); onSaveTask() }}
            disabled={saved}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: saved ? '#22c55e' : '#cbd5e1' }}
            title={saved ? 'Saved as task' : 'Save as task'}
          >
            <Bookmark size={14} fill={saved ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={onDismiss}
            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-colors"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {chatOpen && (
        <div ref={panelRef}>
          <CardChat
            cardContext={[
              `Flagged problem: "${p.title}"`,
              `Detail: "${p.detail}"`,
              `Severity: ${p.severity}`,
              p.relatedDate ? `Related date: ${p.relatedDate}` : '',
            ].filter(Boolean).join('\n')}
            quickPrompts={['Why is this flagged?', 'How do I fix this?', 'Is this actually a problem?']}
          />
        </div>
      )}
    </div>
  )
}

// A thin indeterminate bar pinned to the very top of the viewport. It signals
// background activity without occupying layout space or shifting any content.
function TopProgressBar({ active }: { active: boolean }) {
  if (!active) return null
  return (
    // Positioned below the iPhone safe-area inset so it's visible in standalone PWA mode.
    // solid 3px bar is much more visible than the original 0.5px gradient.
    <div
      className="fixed inset-x-0 z-50 h-[3px] bg-blue-100 overflow-hidden pointer-events-none"
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="h-full w-2/5 bg-blue-500 animate-progress-slide" />
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function SectionLabel({ icon: Icon, color, children }: { icon: typeof Clock; color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={16} style={{ color }} />
      <h2 className="text-base font-bold text-slate-900">{children}</h2>
    </div>
  )
}

// ── Grouped attention card ───────────────────────────────────
// Collapses 2+ related items into a single card. Compact rows when closed;
// full individual AttentionCards when expanded.

type ResolvedItemForGroup = {
  item: AttentionItem
  responsible?: FamilyMember
  forMembers: FamilyMember[]
  backedByRealItem: boolean
  isRecurring: boolean
}

function GroupedAttentionCard({
  groupTitle, resolvedItems, accent, allMembers,
  onCompleteItem, onDismissItem, onSaveTaskItem, onAssignItem, debugMode, onTraceItem,
  currentGreeting, allGroupItems, cardMembers, onPatch,
}: {
  groupTitle: string
  resolvedItems: ResolvedItemForGroup[]
  accent: string
  allMembers: FamilyMember[]
  onCompleteItem: (item: AttentionItem) => void
  onDismissItem: (title: string) => void
  onSaveTaskItem: (title: string, reason: string) => void
  onAssignItem: (item: AttentionItem, forIds: string[], responsibleId?: string) => void
  debugMode?: boolean
  onTraceItem?: (item: AttentionItem) => void
  currentGreeting?: string
  allGroupItems?: AttentionItem[]
  cardMembers?: FamilyMember[]
  onPatch?: (updated: AttentionItem[], removed: string[], greeting?: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  // Unique members across all items for the header avatars
  const headerMembers = (() => {
    const seen = new Set<string>()
    const result: FamilyMember[] = []
    for (const { forMembers, responsible } of resolvedItems) {
      for (const m of [...forMembers, ...(responsible ? [responsible] : [])]) {
        if (!seen.has(m.id)) { seen.add(m.id); result.push(m) }
      }
    }
    return result
  })()

  return (
    <div className="rounded-2xl bg-white shadow-card animate-slide-up" style={{ borderLeft: `3px solid ${accent}` }}>
      {/* Header row — tap to expand/collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 pt-4 pb-3 text-left"
      >
        {headerMembers.length > 0 && (
          <div className="flex -space-x-1 shrink-0">
            {headerMembers.slice(0, 4).map((m) => (
              <div
                key={m.id}
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] ring-1 ring-white"
                style={{ background: `${m.colorHex}35` }}
              >
                {m.emoji}
              </div>
            ))}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900 leading-snug">{groupTitle}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{resolvedItems.length} items · tap to {expanded ? 'collapse' : 'expand'}</p>
        </div>
        <ChevronDown
          size={15}
          className="text-slate-300 shrink-0 transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      {/* Collapsed: compact rows */}
      {!expanded && (
        <div className="px-4 pb-3 space-y-2 border-t border-slate-50 pt-2">
          {resolvedItems.map(({ item, backedByRealItem }) => (
            <CompactItemRow
              key={item.id}
              item={item}
              accent={accent}
              backedByRealItem={backedByRealItem}
              onComplete={() => onCompleteItem(item)}
            />
          ))}
        </div>
      )}

      {/* Expanded: full individual AttentionCards */}
      {expanded && (
        <div className="border-t border-slate-100 divide-y divide-slate-50">
          {resolvedItems.map(({ item, responsible, forMembers, backedByRealItem, isRecurring }) => (
            <AttentionCard
              key={item.id}
              item={item}
              accent={accent}
              allMembers={allMembers}
              responsible={responsible}
              forMembers={forMembers}
              backedByRealItem={backedByRealItem}
              isRecurring={isRecurring}
              onComplete={() => onCompleteItem(item)}
              onDismiss={() => onDismissItem(item.title)}
              onSaveTask={() => onSaveTaskItem(item.title, item.reason)}
              onAssign={(f, r) => onAssignItem(item, f, r)}
              debugMode={debugMode}
              onTrace={onTraceItem ? () => onTraceItem(item) : undefined}
              currentGreeting={currentGreeting}
              cardMembers={cardMembers}
              onPatch={onPatch}
              groupItems={allGroupItems}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CompactItemRow({
  item, accent, backedByRealItem, onComplete,
}: {
  item: AttentionItem
  accent: string
  backedByRealItem: boolean
  onComplete: () => void
}) {
  const [done, setDone] = useState(false)
  const isTask = backedByRealItem && (item.sourceType === 'task' || item.sourceType === 'reminder')
  const startStr = item.startBy
    ? new Date(item.startBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className="flex items-center gap-2 min-w-0">
      {/* Always a dot — tasks get a tappable one, events a static one. Same visual width either way. */}
      {isTask ? (
        <button
          onClick={(e) => { e.stopPropagation(); setDone(true); onComplete() }}
          className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center transition-colors"
          title="Mark done"
        >
          <span className="w-1.5 h-1.5 rounded-full transition-colors" style={{ background: done ? '#22c55e' : accent }} />
        </button>
      ) : (
        <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-px" style={{ background: accent }} />
      )}
      <p className={`text-xs flex-1 min-w-0 leading-snug ${done ? 'line-through text-slate-400' : 'text-slate-700'}`}>
        {item.title}
      </p>
      {startStr && (
        <span
          className="text-[10px] font-medium shrink-0 px-1.5 py-0.5 rounded-full"
          style={{ background: `${accent}15`, color: accent }}
        >
          {startStr}
        </span>
      )}
    </div>
  )
}

// ── Inline card chat ─────────────────────────────────────────
// A self-contained mini-Copilot that renders inside any card. It reads family
// context from hooks directly so no prop-drilling is needed from CommandCenter.

function CardChat({
  cardContext,
  quickPrompts,
  patchCards,
  currentGreeting,
  patchMembers,
  onPatch,
}: {
  cardContext: string
  quickPrompts: string[]
  patchCards?: AttentionItem[]
  currentGreeting?: string
  patchMembers?: FamilyMember[]
  onPatch?: (updated: AttentionItem[], removed: string[], greeting?: string) => void
}) {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { getFreshTokens } = useGoogleTokens()

  type ChatMsg = { role: 'user' | 'assistant'; content: string; isStreaming?: boolean }
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50) }, [])
  // Scroll ONLY inside the message container, never the whole page.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, loading])

  async function send(text?: string) {
    const content = (text ?? input).trim()
    if (!content || loading || !familyId || !user?.email) return

    const userMsg: ChatMsg = { role: 'user', content }
    setMsgs((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const freshTokens = await getFreshTokens()
      const googleTokens = freshTokens
        ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
        : null

      // Prepend card context to only the first user message so the AI knows
      // what card is being discussed, without repeating it on every follow-up.
      const history = [...msgs, userMsg].map((m, i) =>
        i === 0
          ? { role: m.role, content: `[Card context]\n${cardContext}\n\n${m.content}` }
          : { role: m.role, content: m.content }
      )

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          familyId,
          userEmail: user.email,
          googleTokens,
          context: {
            members,
            today: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
      })
      if (!res.ok || !res.body) throw new Error('Request failed')

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let started = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let ev: { type: string; token?: string; reply?: string; pendingActions?: unknown[] }
          try { ev = JSON.parse(line.slice(6)) } catch { continue }

          if (ev.type === 'token') {
            if (!started) {
              started = true
              setLoading(false)
              setMsgs((prev) => [...prev, { role: 'assistant', content: ev.token!, isStreaming: true }])
            } else {
              setMsgs((prev) => {
                const a = [...prev]
                const last = a[a.length - 1]
                if (last?.isStreaming) a[a.length - 1] = { ...last, content: last.content + ev.token! }
                return a
              })
            }
          } else if (ev.type === 'done') {
            const queued = (ev.pendingActions ?? []) as PendingAction[]
            if (queued.length) setPendingActions((prev) => [...prev, ...queued])
            setMsgs((prev) => {
              const a = [...prev]
              const last = a[a.length - 1]
              const reply = ev.reply || (last?.isStreaming ? last.content : '') || (queued.length ? "I've queued some actions." : 'Done.')
              if (last?.role === 'assistant') return [...a.slice(0, -1), { ...last, isStreaming: false, content: reply }]
              return [...a, { role: 'assistant', content: reply }]
            })
            // Background patch: update just the affected card(s) based on this
            // conversation. Fire-and-forget — never blocks the chat UI.
            if (onPatch && patchCards?.length) {
              const fullConv = [...msgs, userMsg, { role: 'assistant' as const, content: ev.reply ?? '' }]
              fetch('/api/ai/attention/patch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  cards: patchCards,
                  conversation: fullConv,
                  greeting: currentGreeting ?? '',
                  members: patchMembers ?? [],
                  now: new Date().toISOString(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
              })
                .then((r) => r.json())
                .then((d) => {
                  if (d.updatedCards?.length || d.removedIds?.length) {
                    onPatch(d.updatedCards ?? [], d.removedIds ?? [], d.greeting)
                  }
                })
                .catch(() => { /* non-fatal — patch is best-effort */ })
            }
          } else if (ev.type === 'error') {
            throw new Error(String((ev as { error?: unknown }).error ?? 'Error'))
          }
        }
      }
    } catch {
      setMsgs((prev) => {
        const a = [...prev]
        if (a[a.length - 1]?.isStreaming) a.pop()
        return [...a, { role: 'assistant', content: 'Something went wrong. Try again.' }]
      })
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  return (
    <div className="border-t border-slate-100 pt-3 pb-4 px-4 space-y-2.5">
      {/* Quick-prompt chips — visible before any messages are sent */}
      {msgs.length === 0 && !loading && (
        <div className="flex flex-wrap gap-1.5">
          {quickPrompts.map((p) => (
            <button
              key={p}
              onClick={() => send(p)}
              className="text-[11px] px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100 hover:bg-blue-100 active:scale-95 transition-all font-medium"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Message thread */}
      {msgs.length > 0 && (
        <div ref={scrollRef} className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
          {msgs.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <span className="text-[13px] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3 py-1.5 max-w-[85%] leading-relaxed">
                  {m.content}
                </span>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-1.5">
                <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles size={9} className="text-white" />
                </div>
                <div className="text-[13px] text-slate-700 leading-relaxed flex-1 min-w-0 pt-0.5">
                  <Markdown content={m.content} />
                  {m.isStreaming && (
                    <span className="inline-block w-0.5 h-3 bg-blue-400 ml-0.5 animate-pulse align-middle" />
                  )}
                </div>
              </div>
            )
          )}
          {loading && !msgs.some((m) => m.isStreaming) && (
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0">
                <Sparkles size={9} className="text-white" />
              </div>
              <div className="flex gap-1">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          )}
          {pendingActions.length > 0 && (
            <div className="pl-6 flex items-center gap-2">
              <p className="text-[11px] text-amber-700">
                {pendingActions.length} action{pendingActions.length > 1 ? 's' : ''} ready to apply.
              </p>
              <button
                onClick={() => {
                  // Serialize the conversation + pending actions into sessionStorage so
                  // CopilotChat can restore them as a live message with a confirm card.
                  try {
                    const restore = {
                      messages: msgs
                        .filter((m) => !m.isStreaming)
                        .map((m) => ({ role: m.role, content: m.content })),
                      pendingActions,
                    }
                    sessionStorage.setItem('copilot-restore', JSON.stringify(restore))
                  } catch { /* non-fatal */ }
                  router.push('/copilot')
                }}
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 underline underline-offset-2 shrink-0"
              >
                Review in Copilot →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
          placeholder="Ask about this…"
          disabled={loading}
          className="flex-1 text-[13px] rounded-full border border-slate-200 bg-white px-3 py-1.5 focus:outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-100 disabled:opacity-50 transition-all"
        />
        {input.trim() && (
          <button
            onClick={() => send()}
            disabled={loading}
            className="shrink-0 w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 active:scale-95 transition-all"
          >
            <Send size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Individual attention card ────────────────────────────────
// Tapping a card opens a bottom sheet with all actions.

function AttentionCard({
  item, accent, allMembers, responsible, forMembers, backedByRealItem, isRecurring, onComplete, onDismiss, onSaveTask, onAssign, debugMode, onTrace,
  currentGreeting, cardMembers, onPatch, groupItems,
}: {
  item: AttentionItem
  accent: string
  allMembers: FamilyMember[]
  responsible?: FamilyMember
  forMembers: FamilyMember[]
  backedByRealItem: boolean
  isRecurring?: boolean
  onComplete: () => void
  onDismiss: () => void
  onSaveTask: () => void
  onAssign: (forIds: string[], responsibleId?: string) => void
  debugMode?: boolean
  onTrace?: () => void
  currentGreeting?: string
  cardMembers?: FamilyMember[]
  onPatch?: (updated: AttentionItem[], removed: string[], greeting?: string) => void
  groupItems?: AttentionItem[]
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [done, setDone] = useState(false)
  const startStr = item.startBy
    ? new Date(item.startBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <>
      <button
        onClick={() => setSheetOpen(true)}
        className="w-full rounded-2xl bg-white shadow-card animate-slide-up text-left active:scale-[0.99] transition-all"
        style={{ borderLeft: `3px solid ${accent}`, opacity: done ? 0.4 : 1 }}
      >
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900">{item.title}</p>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.reason}</p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {startStr && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: `${accent}15`, color: accent }}
                >
                  <Clock size={10} /> {startStr}
                </span>
              )}
              {forMembers.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
                    style={{ background: `${m.colorHex}25` }}
                  >{m.emoji}</span>
                  {m.name}
                </span>
              ))}
              {responsible && (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                  <span>·</span>
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
                    style={{ background: `${responsible.colorHex}25` }}
                  >{responsible.emoji}</span>
                  {responsible.name}
                </span>
              )}
            </div>
          </div>
          <ChevronRight size={16} className="text-slate-200 shrink-0 mt-0.5" />
        </div>
      </button>

      {sheetOpen && (
        <CardActionSheet
          item={item}
          accent={accent}
          allMembers={allMembers}
          responsible={responsible}
          forMembers={forMembers}
          backedByRealItem={backedByRealItem}
          isRecurring={isRecurring}
          onClose={() => setSheetOpen(false)}
          onComplete={() => { setDone(true); setSheetOpen(false); onComplete() }}
          onDismiss={() => { setSheetOpen(false); onDismiss() }}
          onSaveTask={() => { setSheetOpen(false); onSaveTask() }}
          onAssign={(f, r) => { setSheetOpen(false); onAssign(f, r) }}
          debugMode={debugMode}
          onTrace={onTrace}
          currentGreeting={currentGreeting}
          cardMembers={cardMembers}
          onPatch={onPatch}
          groupItems={groupItems}
        />
      )}
    </>
  )
}

// Two-sided assignment: pick who it's FOR (often the kids — multi-select) and
// optionally who's RESPONSIBLE for handling it (one parent). Keeping these
// separate captures the real nuance: a kid's appointment is "for" the kid but a
// parent does the driving.
function AssignPanel({
  allMembers, initialFor, initialResponsible, isRecurring, onCancel, onSave,
}: {
  allMembers: FamilyMember[]
  initialFor: string[]
  initialResponsible?: string
  isRecurring?: boolean
  onCancel: () => void
  onSave: (forIds: string[], responsibleId?: string) => void
}) {
  const [forIds, setForIds] = useState<string[]>(initialFor)
  const [responsible, setResponsible] = useState<string | undefined>(initialResponsible)

  const toggleFor = (id: string) =>
    setForIds((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]))

  const Chip = ({ m, selected, onClick }: { m: FamilyMember; selected: boolean; onClick: () => void }) => (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all border"
      style={{
        background: selected ? `${m.colorHex}20` : 'white',
        borderColor: selected ? m.colorHex : '#e2e8f0',
        color: selected ? '#0f172a' : '#64748b',
        fontWeight: selected ? 600 : 400,
      }}
    >
      <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${m.colorHex}25` }}>
        {m.emoji}
      </span>
      {m.name}
      {selected && <Check size={11} />}
    </button>
  )

  return (
    <div className="px-4 pb-4 border-t border-slate-50 pt-3 space-y-3">
      <div>
        <p className="text-xs font-medium text-slate-600 mb-1.5">Who&apos;s this for?</p>
        <div className="flex flex-wrap gap-1.5">
          {allMembers.map((m) => (
            <Chip key={m.id} m={m} selected={forIds.includes(m.id)} onClick={() => toggleFor(m.id)} />
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-slate-600 mb-1.5">
          {isRecurring ? 'Who\'s handling this occurrence?' : 'Who\'s responsible?'}
          {' '}<span className="text-slate-400 font-normal">{isRecurring ? '(this week only — "for" applies to all)' : '(optional)'}</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {allMembers
            .filter((m) => m.role !== 'pet')
            .map((m) => (
              <Chip
                key={m.id}
                m={m}
                selected={responsible === m.id}
                onClick={() => setResponsible((prev) => (prev === m.id ? undefined : m.id))}
              />
            ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(forIds, responsible)}
          disabled={forIds.length === 0 && !responsible}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          Save assignment
        </button>
      </div>
    </div>
  )
}

// ── Card action modal ────────────────────────────────────────
// Opens as a centered dialog when the user taps an AttentionCard.
// Contains card summary + all per-card actions + inline assign / chat sub-views.

function CardActionSheet({
  item, accent, allMembers, responsible, forMembers, backedByRealItem, isRecurring,
  onClose, onComplete, onDismiss, onSaveTask, onAssign, debugMode, onTrace,
  currentGreeting, cardMembers, onPatch, groupItems,
}: {
  item: AttentionItem
  accent: string
  allMembers: FamilyMember[]
  responsible?: FamilyMember
  forMembers: FamilyMember[]
  backedByRealItem: boolean
  isRecurring?: boolean
  onClose: () => void
  onComplete: () => void
  onDismiss: () => void
  onSaveTask: () => void
  onAssign: (forIds: string[], responsibleId?: string) => void
  debugMode?: boolean
  onTrace?: () => void
  currentGreeting?: string
  cardMembers?: FamilyMember[]
  onPatch?: (updated: AttentionItem[], removed: string[], greeting?: string) => void
  groupItems?: AttentionItem[]
}) {
  const [view, setView] = useState<'actions' | 'assign' | 'chat'>('actions')
  const isTask = backedByRealItem && (item.sourceType === 'task' || item.sourceType === 'reminder')
  const startStr = item.startBy
    ? new Date(item.startBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-5 animate-fade-in"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white rounded-2xl shadow-elevated w-full max-w-sm flex flex-col animate-scale-in overflow-hidden"
        style={{ maxHeight: '80vh' }}
      >
        {/* Back nav for sub-views */}
        {view !== 'actions' && (
          <button
            onClick={() => setView('actions')}
            className="flex items-center gap-1.5 px-4 py-3 text-sm text-blue-600 font-medium border-b border-slate-100 shrink-0"
          >
            ← Back
          </button>
        )}

        {/* Card summary (actions view only) */}
        {view === 'actions' && (
          <div className="p-4 border-b border-slate-100 shrink-0">
            <div className="flex items-start gap-3">
              <div className="w-1 self-stretch rounded-full shrink-0 mt-0.5" style={{ background: accent }} />
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-slate-900 leading-snug">{item.title}</p>
                <p className="text-sm text-slate-500 mt-1 leading-relaxed">{item.reason}</p>
                {item.detail && (
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.detail}</p>
                )}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {startStr && (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                      style={{ background: `${accent}15`, color: accent }}
                    >
                      <Clock size={11} /> Start by {startStr}
                    </span>
                  )}
                  {forMembers.map((m) => (
                    <span key={m.id} className="inline-flex items-center gap-1 text-xs text-slate-500">
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
                        style={{ background: `${m.colorHex}25` }}
                      >{m.emoji}</span>
                      {m.name}
                    </span>
                  ))}
                  {responsible && (
                    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                      <span>·</span>
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
                        style={{ background: `${responsible.colorHex}25` }}
                      >{responsible.emoji}</span>
                      {responsible.name} handling it
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {view === 'actions' && (
            <div className="py-1.5">
              {isTask && (
                <SheetAction
                  icon={<Check size={18} className="text-green-600" />}
                  label="Mark as done"
                  onClick={onComplete}
                />
              )}
              <SheetAction
                icon={<Users size={18} className="text-slate-600" />}
                label="Change assignment"
                sub="Who's handling this and who it's for"
                onClick={() => setView('assign')}
                showChevron
              />
              <SheetAction
                icon={<MessageCircle size={18} className="text-blue-500" />}
                label="Ask about this…"
                sub="Chat with your assistant about this card"
                onClick={() => setView('chat')}
                showChevron
              />
              <div className="mx-4 my-1 border-t border-slate-100" />
              <SheetAction
                icon={<X size={18} className="text-slate-400" />}
                label="Hide from briefing"
                sub="Removes this card — you can teach the assistant why"
                onClick={onDismiss}
              />
              {debugMode && onTrace && (
                <SheetAction
                  icon={<Bug size={18} className="text-blue-400" />}
                  label="Trace sources (debug)"
                  onClick={() => { onClose(); onTrace() }}
                />
              )}
            </div>
          )}

          {view === 'assign' && (
            <AssignPanel
              allMembers={allMembers}
              initialFor={forMembers.map((m) => m.id)}
              initialResponsible={responsible?.id}
              isRecurring={isRecurring}
              onCancel={() => setView('actions')}
              onSave={(f, r) => { onAssign(f, r) }}
            />
          )}

          {view === 'chat' && (
            <div className="min-h-[300px]">
              <CardChat
                cardContext={[
                  `Title: "${item.title}"`,
                  `Reason: "${item.reason}"`,
                  `Source type: ${item.sourceType}`,
                  item.dueAt ? `Due/scheduled: ${item.dueAt}` : '',
                  item.startBy ? `Start by: ${item.startBy}` : '',
                  item.sourceId ? `Source id: ${item.sourceId}` : '',
                ].filter(Boolean).join('\n')}
                quickPrompts={['Why is this showing up?', 'What should I do?', 'Where does this come from?']}
                patchCards={groupItems ?? [item]}
                currentGreeting={currentGreeting}
                patchMembers={cardMembers}
                onPatch={onPatch}
              />
            </div>
          )}
        </div>

        {/* Close button */}
        {view === 'actions' && (
          <div className="px-4 pb-4 pt-2 shrink-0 border-t border-slate-50">
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-slate-100 text-sm font-medium text-slate-600 hover:bg-slate-200 active:bg-slate-300 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SheetAction({
  icon, label, sub, onClick, disabled, showChevron,
}: {
  icon: React.ReactNode
  label: string
  sub?: string
  onClick: () => void
  disabled?: boolean
  showChevron?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3.5 px-4 py-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors disabled:opacity-40"
    >
      <span className="shrink-0 w-7 flex justify-center">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {sub && <span className="block text-xs text-slate-400 mt-0.5 leading-snug">{sub}</span>}
      </span>
      {showChevron && <ChevronRight size={15} className="text-slate-300 shrink-0" />}
    </button>
  )
}

function TeachPrompt({
  title, onTeach, onDismiss, onUndo,
}: {
  title: string
  onTeach: (feedback: string) => void
  onDismiss: () => void
  onUndo: () => void
}) {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="rounded-2xl p-4 bg-slate-50 border border-slate-200 animate-slide-up">
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-xs font-medium text-slate-700">
          Dismissed. Want to teach your assistant not to show things like this?
        </p>
        <button
          onClick={onUndo}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800"
        >
          <RefreshCw size={11} /> Undo
        </button>
      </div>
      <div className="flex gap-2 mb-2">
        {["It's work-related, not family", "Not relevant to us", "Already handled"].map((opt) => (
          <button
            key={opt}
            onClick={() => onTeach(opt)}
            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors"
          >
            {opt}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onTeach(feedback) }}
          placeholder="Or type your own reason…"
          className="flex-1 text-xs rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white"
        />
        <button onClick={() => onTeach(feedback)} className="text-xs px-3 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors" disabled={!feedback.trim()}>Save</button>
        <button onClick={onDismiss} className="text-xs px-3 py-2 rounded-lg text-slate-400 hover:text-slate-600 transition-colors">Skip</button>
      </div>
    </div>
  )
}
