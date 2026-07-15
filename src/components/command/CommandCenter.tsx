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
import { Markdown } from '@/components/ui/Markdown'
import { DayPlanner } from '@/components/coach/DayPlanner'
import { KnowMeCard } from '@/components/command/KnowMeCard'
import type { PendingAction } from '@/components/copilot/ProposedActions'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  AttentionReport, AttentionItem, AttentionBucket, PotentialProblem, Recommendation,
  FamilyMemory, FamilyProfile, FamilyReminder, DayPlan, DayPlanItem,
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

const BUCKET_PRIORITY: Record<AttentionBucket, number> = { now: 0, next: 1, later: 2, upcoming: 3 }

type ItemGroup = {
  key: string
  groupTitle: string | null  // non-null when 2+ items share a groupKey
  items: AttentionItem[]
  bucket: AttentionBucket    // most-urgent bucket across items
}

// A single scoped call to the attention engine. Reads the NDJSON stream,
// forwarding the first-token signal (used for cache-warming) and each completed
// item card, and resolves with the authoritative final payload. Throws on a
// server/stream error so the caller can fall back to its cached report.
type EngineScope =
  | { kind: 'items'; sections?: string[]; greeting?: boolean; maxItems?: number }
  | { kind: 'plate'; owner: 'self' | 'others'; maxItems?: number }
  | { kind: 'problems' }
  | { kind: 'recommendations' }

interface EngineFinal {
  greeting?: string
  items?: AttentionItem[]
  problems?: PotentialProblem[]
  recommendations?: Recommendation[]
}

async function streamEngine(
  body: unknown,
  opts: {
    signal: AbortSignal
    onItem?: (item: AttentionItem) => void
    onFirstToken?: () => void
    onDelta?: (text: string) => void
  },
): Promise<EngineFinal> {
  const res = await fetch('/api/ai/attention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    let msg = 'Something went wrong. Tap refresh to try again.'
    try { const d = await res.json(); msg = d.error ?? msg } catch { /* keep default */ }
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawToken = false
  let final: EngineFinal | null = null
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
      let evt: { t?: string; d?: string; error?: string; item?: AttentionItem } & Partial<EngineFinal>
      try { evt = JSON.parse(line) } catch { continue }
      if (evt.t === 'delta') {
        if (!sawToken) { sawToken = true; opts.onFirstToken?.() }
        if (evt.d) opts.onDelta?.(evt.d)
      } else if (evt.t === 'item') {
        if (evt.item) opts.onItem?.(evt.item)
      } else if (evt.t === 'final') {
        final = evt as EngineFinal
      } else if (evt.t === 'error') {
        streamError = evt.error ?? 'Something went wrong. Tap refresh to try again.'
      }
    }
  }
  if (streamError) throw new Error(streamError)
  if (!final) throw new Error('Could not load your briefing. Tap refresh to try again.')
  return final
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
// Lazily-loaded briefing sections — each fetched on demand via its own scoped
// AI request, cached separately so they persist across visits.
const PROBLEMS_PREFIX = 'fam-problems-'
const RECS_PREFIX = 'fam-recs-'

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
  // Today's day plan — so a radar insight can be dropped straight into the plan.
  const { data: homeDayPlans, update: updateHomeDayPlan } = useFirestore<DayPlan>('dayPlans')
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
  const problemsKey = familyId ? PROBLEMS_PREFIX + familyId : null
  const recsKey = familyId ? RECS_PREFIX + familyId : null

  const [report, setReport] = useState<AttentionReport | null>(null)
  // Lazily-loaded sections. `null` = never loaded this session; an array (even
  // empty) = loaded. Each has its own in-flight flag for the inline spinner.
  const [problems, setProblems] = useState<PotentialProblem[] | null>(null)
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null)
  const [problemsLoading, setProblemsLoading] = useState(false)
  const [recsLoading, setRecsLoading] = useState(false)
  // Collapse toggles for the two lazy sections (Problems / Recommendations).
  // Default expanded; the user can fold them away once loaded.
  const [problemsCollapsed, setProblemsCollapsed] = useState(false)
  const [recsCollapsed, setRecsCollapsed] = useState(false)
  // Buffered result from a background run. Applied only when the user taps the
  // "Briefing updated" banner — prevents content jumping mid-scroll.
  const [pendingReport, setPendingReport] = useState<AttentionReport | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)        // true cold start only (no report yet)
  const [refreshing, setRefreshing] = useState(false)  // silent background update
  const [calendarFetching, setCalendarFetching] = useState(false) // Google Calendar fetch in progress
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
  // Set by the manual Refresh button so the next calendar sync is a FULL
  // re-sync (catches recurring-event changes the incremental delta misses).
  const forceFullSyncRef = useRef(false)
  const deepToken = useRef<number>(0)
  const engineAbortRef = useRef<AbortController | null>(null)
  // In-flight aborts for the lazily-loaded problems / recommendations sections.
  const problemsAbortRef = useRef<AbortController | null>(null)
  const recsAbortRef = useRef<AbortController | null>(null)
  // Pending debounced engine run (see scheduleEngine + ENGINE_COALESCE_MS).
  const engineDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Each runEngine call gets a monotonically-increasing token. The finally block
  // only clears loading state if it's still the current run — prevents an aborted
  // run's finally from clearing state owned by the newer run that aborted it.
  const runTokenRef = useRef(0)
  // True while a cold-start (no report yet) engine run is mid-flight. Lets the
  // context-change effect DEFER instead of aborting it when late data (a calendar
  // sync landing a new event) arrives — aborting would throw away a run that was
  // seconds from done and restart from scratch, doubling perceived load time.
  const coldRunInFlight = useRef(false)
  // Set when a context change arrives during a cold-start run. After that run
  // finishes, runEngine reads this and schedules ONE silent refresh to fold in
  // the late data, instead of aborting mid-flight.
  const deferredRerun = useRef(false)
  // Holds the latest scheduleEngine so runEngine's finally can trigger a deferred
  // refresh without a circular useCallback dependency (scheduleEngine is declared
  // after runEngine).
  const scheduleEngineRef = useRef<((silent: boolean) => void) | null>(null)
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
    // Restore lazily-loaded sections if they were fetched in a prior visit.
    const cachedProblems = readCache<PotentialProblem[]>(problemsKey)
    if (cachedProblems) setProblems(cachedProblems)
    const cachedRecs = readCache<Recommendation[]>(recsKey)
    if (cachedRecs) setRecommendations(cachedRecs)
    const em = readCache<EmailSuggestion[]>(gmailKey)
    if (em?.length) setEmailSuggestions(em)
    const dism = readCache<string[]>(dismissKey)
    if (dism?.length) setDismissedTitles(new Set(dism))
    const comp = readCache<string[]>(completedKey)
    if (comp?.length) setCompletedTitles(new Set(comp))
    // Restore the last context signature so Firestore delivering the same data
    // on remount doesn't look like "new context" and trigger an immediate re-run.
    const savedCtxSig = readCache<string>(ctxSigKey)
    if (savedCtxSig) lastCtxSig.current = savedCtxSig
    const savedRunSig = readCache<string>(lastRunSigKey)
    if (savedRunSig) lastRunSig.current = savedRunSig
    setHydrated(true)
  }, [familyId, attnKey, gmailKey, dismissKey, lastRunKey, ctxSigKey, lastRunSigKey, problemsKey, recsKey])

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
    // Also snapshot the radar items to their own per-user doc (keyed like day
    // plans) so the Day Planner can weave surfaced blind spots into drafts and
    // suggestions — the radar → plan feedback loop.
    const planKey = user.email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    setDoc(
      doc(db, 'families', familyId, 'radar', planKey),
      {
        email: user.email,
        generatedAt: report.generatedAt,
        items: (report.items ?? []).slice(0, 5).map((i) => ({
          title: i.title, reason: i.reason ?? '', nextMove: i.nextMove ?? '',
        })),
      },
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
      // A manual refresh forces a FULL re-sync (?full=1) so recurring-event
      // changes and anything past the incremental window are pulled fresh.
      const full = forceFullSyncRef.current
      forceFullSyncRef.current = false
      try {
        if (isConnected) await getFreshTokens()
        if (cancelled) return
        const idToken = await user?.getIdToken()
        if (!idToken || cancelled) return
        await fetch(`/api/calendar/sync${full ? '?full=1' : ''}`, {
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
    if (!report) setLoading(true)
    else setRefreshing(true)

    const runAt = Date.now()
    lastRun.current = runAt
    const engineStart = performance.now()
    const myToken = ++deepToken.current

    // Mark cold-start runs so a late context change defers instead of aborting.
    const isColdRun = !report
    if (isColdRun) { coldRunInFlight.current = true; deferredRerun.current = false }

    try {
      const eventContext = overrideContext ??
        eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))

      const baseBody = buildEngineBody(eventContext, 'fast')

      // ONE radar call replaces the old two-plate briefing. The dashboard's
      // fixed sections already render every calendar/task fact deterministically,
      // so the model's only job is the blind-spot sweep: things the user is
      // probably NOT thinking about, each with a concrete next move.
      console.log(`[perf:engine] start → radar sweep`)

      // Progressive cards: show each insight the moment the model finishes it.
      const progressive = !report
      if (progressive) setStreamingItems([])
      const seenStream = new Set<string>()
      let sid = 0
      const onStreamItem = (it: AttentionItem) => {
        if (!progressive) return
        const k = `${it.section ?? ''}|${it.title ?? ''}`
        if (seenStream.has(k)) return
        seenStream.add(k)
        setStreamingItems((prev) => [...prev, { ...it, id: `sid-${sid++}` }])
      }

      const radarCall = streamEngine(
        { ...baseBody, scope: { kind: 'radar', maxItems: 5 } },
        { signal: controller.signal, onItem: onStreamItem },
      )
      const settled = await Promise.allSettled([radarCall])

      // A background abort (iOS) cancels everything mid-flight — bail quietly so
      // the visibilitychange handler can retry without surfacing an error.
      if (controller.signal.aborted) return

      const oks = settled.filter(
        (s): s is PromiseFulfilledResult<EngineFinal> => s.status === 'fulfilled',
      )
      if (oks.length === 0) {
        const firstErr = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined
        setEngineError(firstErr?.reason?.message ?? 'Could not load your briefing. Tap refresh to try again.')
        lastRun.current = 0
        return
      }
      const isPartialRun = false

      const merged = (oks[0].value.items ?? []).slice()
      merged.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      const items = merged.map((it, i) => ({ ...it, id: `att-${i}` }))

      const total = Math.round(performance.now() - engineStart)
      console.log(`[perf:engine] DONE total=${total}ms | radar items=${items.length}`)

      // Problems + recommendations are no longer part of this payload — they load
      // lazily via their own on-demand requests. Keep empty arrays so cached
      // consumers and the type contract are satisfied.
      const data: AttentionReport = {
        generatedAt: new Date().toISOString(),
        greeting: '',
        items,
        problems: [],
        recommendations: [],
      }
      if (isPending) {
        setPendingReport(data)
      } else {
        setReport(data)
        setPendingReport(null)
      }
      setEngineError(null)
      writeCache(attnKey, data)
      if (!isPartialRun) {
        // Only mark the run as complete when ALL shards finished. A partial run
        // leaves lastRunSig stale so the next foreground trigger retries.
        writeCache(lastRunKey, runAt)
        lastRunSig.current = lastCtxSig.current
        if (lastRunSigKey) writeCache(lastRunSigKey, lastRunSig.current)
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
        setStreamingItems([])
      }
      // Cold-start run finished. If late data arrived while it was in flight, do
      // ONE silent refresh now to fold it in — instead of having aborted this run
      // mid-flight and restarting from scratch. Called via a ref because
      // scheduleEngine is declared after runEngine (would be a TDZ dep here).
      if (isColdRun) {
        coldRunInFlight.current = false
        if (deferredRerun.current && myRunToken === runTokenRef.current) {
          deferredRerun.current = false
          scheduleEngineRef.current?.(true)
        }
      }
    }
  }, [buildEngineBody, eventContexts, attnKey, report])

  // On-demand load of the "Potential Problems" section. Fires its own scoped AI
  // request (sharing the cached prompt prefix) only when the user expands or
  // refreshes the section — so it never adds to the briefing's load time and is
  // only paid for when actually viewed.
  const loadProblems = useCallback(async () => {
    problemsAbortRef.current?.abort()
    const controller = new AbortController()
    problemsAbortRef.current = controller
    setProblemsLoading(true)
    try {
      const eventContext = eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))
      const body = { ...buildEngineBody(eventContext, 'fast'), scope: { kind: 'problems' as const } }
      const t0 = performance.now()
      const final = await streamEngine(body, { signal: controller.signal })
      const list = (final.problems ?? []).map((p, i) => ({ ...p, id: p.id ?? `prob-${i}` }))
      console.log(`[perf:engine] problems loaded in ${Math.round(performance.now() - t0)}ms → ${list.length}`)
      setProblems(list)
      writeCache(problemsKey, list)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      // Don't blow away an existing list on a failed refresh; show empty only if
      // nothing was loaded yet.
      setProblems((prev) => prev ?? [])
    } finally {
      setProblemsLoading(false)
    }
  }, [buildEngineBody, eventContexts, problemsKey])

  // On-demand load of the "Copilot Recommendations" section — same pattern.
  const loadRecommendations = useCallback(async () => {
    recsAbortRef.current?.abort()
    const controller = new AbortController()
    recsAbortRef.current = controller
    setRecsLoading(true)
    try {
      const eventContext = eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))
      const body = { ...buildEngineBody(eventContext, 'fast'), scope: { kind: 'recommendations' as const } }
      const t0 = performance.now()
      const final = await streamEngine(body, { signal: controller.signal })
      const list = (final.recommendations ?? []).map((r, i) => ({ ...r, id: r.id ?? `rec-${i}` }))
      console.log(`[perf:engine] recommendations loaded in ${Math.round(performance.now() - t0)}ms → ${list.length}`)
      setRecommendations(list)
      writeCache(recsKey, list)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setRecommendations((prev) => prev ?? [])
    } finally {
      setRecsLoading(false)
    }
  }, [buildEngineBody, eventContexts, recsKey])

  // Debounced wrapper around runEngine. Multiple triggers firing within
  // ENGINE_COALESCE_MS of each other (the cold-load cascade: hydration →
  // calendar sync → inbox scan) collapse into a single run with the latest data.
  // On a cold start (no report yet) we show the skeleton immediately so the quiet
  // window isn't a blank screen, even though the actual run starts a beat later.
  const scheduleEngine = useCallback((silent: boolean) => {
    if (!reportRef.current) setLoading(true)
    if (engineDebounceRef.current) clearTimeout(engineDebounceRef.current)
    engineDebounceRef.current = setTimeout(() => {
      engineDebounceRef.current = null
      runEngine(undefined, silent)
    }, ENGINE_COALESCE_MS)
  }, [runEngine])
  useEffect(() => { scheduleEngineRef.current = scheduleEngine }, [scheduleEngine])

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
    // Fully manual: the briefing NEVER regenerates on its own — not on data
    // changes, not on foreground, and not on cold start. The last briefing is
    // restored from cache (localStorage + Firestore) so there's always content
    // to show. Generation happens only when the user taps Refresh.
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
    // Track the data signature + caches so a manual refresh knows the latest
    // state — but DON'T auto-regenerate the briefing when data changes. The
    // briefing only refreshes when the user taps Refresh.
    lastCtxSig.current = ctxSignature
    lastEmailCount.current = emailSuggestions.length
    lastEventCount.current = events.length
    writeCache(ctxSigKey, ctxSignature)
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

  // Keep calendar DATA fresh when the app returns to the foreground (so events
  // are current the next time you look), but never auto-regenerate the briefing
  // — that only happens on the Refresh button now.
  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState !== 'visible') return
      if (isConnected) setCalSyncKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', handleVisible)
    return () => document.removeEventListener('visibilitychange', handleVisible)
  }, [isConnected])

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

  const selfMember = useMemo(
    () => members.find((m) => m.email?.toLowerCase() === user?.email?.toLowerCase()) ?? null,
    [members, user?.email],
  )

  // Minute ticker so Now/Next countdowns drift without a manual refresh.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // ── Fixed dashboard sections (all deterministic — no AI in the path) ──────

  // NOW / NEXT: what's happening right now and the next thing on the calendar.
  const nowNext = useMemo(() => {
    const current = todayEvents.find((e) => {
      const s = new Date(e.start).getTime()
      const en = new Date(e.end ?? e.start).getTime()
      return !e.isAllDay && s <= nowTick && en > nowTick
    })
    const next = todayEvents.find((e) => !e.isAllDay && new Date(e.start).getTime() > nowTick)
    return { current, next }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayEvents, nowTick])

  // NEEDS YOU: open tasks/reminders that are overdue, due today, or high
  // priority — straight from the database, completable in place.
  type NeedsYouEntry = { kind: 'task' | 'reminder'; id: string; title: string; dueDate?: string; priority: string; overdue: boolean; raw: Task | FamilyReminder }
  const needsYou = useMemo<NeedsYouEntry[]>(() => {
    const endOfToday = new Date()
    endOfToday.setHours(23, 59, 59, 999)
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const entries: NeedsYouEntry[] = [
      ...tasks.map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority, overdue: false, raw: t as Task | FamilyReminder, isCompleted: t.isCompleted })),
      ...reminders.filter((r) => !tasks.some((t) => t.id === r.id))
        .map((r) => ({ kind: 'reminder' as const, id: r.id, title: r.title, dueDate: r.dueDate, priority: r.priority, overdue: false, raw: r as Task | FamilyReminder, isCompleted: r.isCompleted })),
    ]
      .filter((e) => !e.isCompleted)
      .filter((e) => (e.dueDate && new Date(e.dueDate) <= endOfToday) || e.priority === 'high')
      .map((e) => ({ ...e, overdue: !!e.dueDate && new Date(e.dueDate) < startOfToday }))
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
        if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1
        return (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
      })
    return entries.slice(0, 6)
  }, [tasks, reminders])

  async function completeNeedsYou(e: NeedsYouEntry) {
    const now = new Date().toISOString()
    if (e.kind === 'task') await updateTask({ ...(e.raw as Task), isCompleted: true, completedAt: now })
    else await updateReminder({ ...(e.raw as FamilyReminder), isCompleted: true, completedAt: now })
  }

  // FAMILY RADAR: one row per family member (other than you) with their events
  // today, matched by calendar ownership / for / responsible fields.
  const familyToday = useMemo(() => {
    return members
      .filter((m) => m.id !== selfMember?.id)
      .map((m) => ({
        member: m,
        events: todayEvents.filter((e) =>
          (m.email && e.ownerEmail?.toLowerCase() === m.email.toLowerCase())
          || e.forIds?.includes(m.id)
          || e.assigneeId === m.id,
        ),
      }))
      .filter((x) => x.events.length > 0)
      .sort((a, b) => b.events.length - a.events.length)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, todayEvents, selfMember?.id])

  // ON YOUR RADAR: the one section where the model gets to talk. The radar
  // scope's contract is blind-spots only — things the user is probably NOT
  // already thinking about, each with a concrete next move.
  const radarItems = useMemo(() => {
    return (report?.items ?? []).filter((i) => showInList(i.title)).slice(0, 5)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.items, dismissedTitles, completedTitles, teachPrompt])

  // "Plan it" on a radar card: drop the insight into today's plan as a flexible
  // move (the insight is the why, the nextMove is the tiny first step). Falls
  // back to a task when there's no committed plan for today yet. Either way the
  // card is marked handled so it doesn't linger or resurface.
  async function planRadarItem(item: AttentionItem) {
    const myKey = user?.email?.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    const d = new Date()
    const todayId = `${myKey}_${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
    const plan = myKey ? homeDayPlans.find((p) => p.id === todayId && p.status !== 'done') : undefined
    if (plan) {
      const move: DayPlanItem = {
        id: generateId(),
        title: item.title,
        why: item.reason || undefined,
        firstStep: item.nextMove || undefined,
        kind: 'move',
        done: false,
      }
      await updateHomeDayPlan({ ...plan, items: [...plan.items, move], updatedAt: new Date().toISOString() })
      toast(`Added to today's plan`, 'success')
    } else {
      await saveItemAsTask(item.title, [item.reason, item.nextMove ? `Next: ${item.nextMove}` : ''].filter(Boolean).join(' — '))
    }
    setCompletedTitles((prev) => {
      const next = new Set(prev).add(item.title)
      writeCache(completedKey, Array.from(next))
      return next
    })
  }

  async function taskRadarItem(item: AttentionItem) {
    await saveItemAsTask(item.title, [item.reason, item.nextMove ? `Next: ${item.nextMove}` : ''].filter(Boolean).join(' — '))
    setCompletedTitles((prev) => {
      const next = new Set(prev).add(item.title)
      writeCache(completedKey, Array.from(next))
      return next
    })
  }

  const busy = loading || refreshing


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
            onClick={() => {
              // Refresh = pull fresh calendar (full re-sync) AND regenerate.
              setPendingReport(null)
              forceDirectRef.current = true
              forceFullSyncRef.current = true
              setCalSyncKey((k) => k + 1)
              runEngine(undefined, !!report)
            }}
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

      {/* ══ FIXED DASHBOARD — same sections, same order, every visit. Facts are
          rendered straight from the database; the AI only speaks inside the
          clearly-marked "Heads up" box at the bottom. ══ */}

      {/* NOW / NEXT — deterministic calendar math. */}
      {(nowNext.current || nowNext.next) && (
        <section className="rounded-2xl bg-white shadow-card p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center shrink-0">
              <Clock size={17} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              {nowNext.current ? (
                <>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-rose-500">Now</p>
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {nowNext.current.title}
                    <span className="font-normal text-slate-400"> · until {new Date(nowNext.current.end ?? nowNext.current.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Next up</p>
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {nowNext.next!.title}
                    <span className="font-normal text-slate-400">
                      {' '}· {new Date(nowNext.next!.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      {(() => {
                        const mins = Math.round((new Date(nowNext.next!.start).getTime() - nowTick) / 60000)
                        if (mins < 60) return ` — in ${mins} min`
                        const h = Math.floor(mins / 60)
                        return ` — in ${h}h ${mins % 60}m`
                      })()}
                    </span>
                  </p>
                  {nowNext.next!.location && (
                    <p className="text-xs text-slate-400 truncate">{nowNext.next!.location}</p>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* YOUR DAY — the plan is the backbone; draft and track it right here. */}
      <DayPlanner />

      {/* NEEDS YOU — open tasks due/overdue/high-priority, completable in place. */}
      <section className="rounded-2xl bg-white shadow-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Check size={15} className="text-slate-700" />
          <h2 className="text-sm font-bold text-slate-800">Needs you</h2>
          {needsYou.length > 0 && (
            <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{needsYou.length}</span>
          )}
          <button onClick={() => router.push('/tasks')} className="ml-auto text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors">
            All tasks →
          </button>
        </div>
        {needsYou.length === 0 ? (
          <p className="text-xs text-slate-400">Nothing due — you&apos;re caught up. ✓</p>
        ) : (
          <div className="space-y-1.5">
            {needsYou.map((e) => (
              <div key={e.id} className="flex items-center gap-2.5 py-1">
                <button
                  onClick={() => completeNeedsYou(e)}
                  aria-label="Complete"
                  className="w-5 h-5 rounded-md border border-slate-300 hover:border-green-500 hover:bg-green-50 flex items-center justify-center shrink-0 transition-colors"
                />
                <p className="flex-1 min-w-0 text-sm text-slate-800 truncate">{e.title}</p>
                {e.overdue ? (
                  <span className="text-[11px] font-semibold text-red-500 shrink-0">
                    ⚠ {e.dueDate ? new Date(e.dueDate).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'overdue'}
                  </span>
                ) : e.dueDate ? (
                  <span className="text-[11px] font-medium text-slate-400 shrink-0">today</span>
                ) : (
                  <span className="text-[11px] font-medium text-orange-400 shrink-0">high</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* FAMILY RADAR — who's doing what today, one row per person. */}
      <section className="rounded-2xl bg-white shadow-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users size={15} className="text-slate-700" />
          <h2 className="text-sm font-bold text-slate-800">Family today</h2>
        </div>
        {familyToday.length === 0 ? (
          <p className="text-xs text-slate-400">Nothing on anyone else&apos;s calendar today.</p>
        ) : (
          <div className="space-y-2.5">
            {familyToday.map(({ member: m, events: evs }) => (
              <div key={m.id} className="flex items-start gap-2.5">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5"
                  style={{ background: `${m.colorHex}25` }}
                >
                  {m.emoji}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700">{m.name}</p>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {evs.map((e, i) => (
                      <span key={e.id}>
                        {i > 0 && <span className="text-slate-300"> · </span>}
                        {!e.isAllDay && (
                          <span className="font-medium text-slate-600">
                            {new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '')}{' '}
                          </span>
                        )}
                        {e.title}
                      </span>
                    ))}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* GETTING TO KNOW YOU — the app asks ONE question a day (or re-verifies
          an aging fact) and distills the answer into structured knowledge.
          This is how the radar and planner get sharper without the user ever
          having to think about "what should I tell it". */}
      <KnowMeCard />

      {/* ON YOUR RADAR (AI) — the one box where the model speaks: blind spots
          only, each with a concrete next move. Clearly marked, easy to ignore. */}
      <section className="rounded-2xl p-4 bg-violet-50/60 border border-violet-100">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={15} className="text-violet-500" />
          <h2 className="text-sm font-bold text-slate-800">On your radar</h2>
          <span className="text-[10px] font-bold uppercase tracking-wider text-violet-400 bg-violet-100 px-1.5 py-0.5 rounded-full">AI</span>
          {report?.generatedAt && !loading && (
            <span className="ml-auto text-[10px] text-slate-400">
              {new Date(report.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-400 -mt-2 mb-3">Things you&apos;re probably not thinking about — each with a way forward.</p>

        {engineError && !loading ? (
          <div className="flex items-start gap-3">
            <AlertTriangle size={15} className="text-red-500 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-red-600">{engineError}</p>
            </div>
            <button
              onClick={() => { setEngineError(null); runEngine(undefined, false) }}
              className="shrink-0 text-xs font-semibold text-red-600 hover:text-red-800 px-2.5 py-1 rounded-lg hover:bg-red-100 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {streamingItems.slice(0, 5).map((it) => (
              <div key={it.id} className="rounded-xl bg-white/80 p-3">
                <p className="text-sm font-medium text-slate-800">{it.title}</p>
                {it.reason && <p className="text-xs text-slate-400 mt-0.5">{it.reason}</p>}
                {it.nextMove && <p className="text-xs text-violet-600 mt-1"><span className="font-semibold">Next:</span> {it.nextMove}</p>}
              </div>
            ))}
            <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
              <span className="w-3.5 h-3.5 border-2 border-violet-300 border-t-transparent rounded-full animate-spin" />
              Sweeping for blind spots…
            </div>
          </div>
        ) : !report ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">I&apos;ll sweep everything — calendar, tasks, goals, email signals — for what&apos;s slipping through.</p>
            <button
              onClick={() => { forceDirectRef.current = true; runEngine(undefined, false) }}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-semibold hover:bg-violet-700 transition-colors"
            >
              <Sparkles size={12} /> Sweep
            </button>
          </div>
        ) : radarItems.length === 0 ? (
          <p className="text-xs text-slate-400">Radar&apos;s clear — nothing slipping through that your plan doesn&apos;t already cover.</p>
        ) : (
          <div className="space-y-2 stagger-children">
            {radarItems.map((item) => (
              teachPrompt?.title === item.title ? (
                <TeachPrompt
                  key={item.id}
                  title={item.title}
                  onTeach={(feedback) => teachAssistant(item.title, feedback)}
                  onDismiss={() => setTeachPrompt(null)}
                  onUndo={() => undoDismiss(item.title)}
                />
              ) : (
                <div key={item.id} className="rounded-xl bg-white p-3.5 shadow-card">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 leading-snug">{item.title}</p>
                      {item.reason && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.reason}</p>}
                    </div>
                    <button
                      onClick={() => dismissItem(item.title)}
                      aria-label="Dismiss"
                      className="p-1 -m-1 text-slate-300 hover:text-slate-500 transition-colors shrink-0"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {item.nextMove && (
                    <div className="mt-2 rounded-lg bg-violet-50 border border-violet-100 px-2.5 py-1.5">
                      <p className="text-xs text-violet-800"><span className="font-bold text-violet-500 uppercase text-[10px] mr-1">Next</span>{item.nextMove}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-2.5">
                    <button
                      onClick={() => planRadarItem(item)}
                      className="flex-1 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-semibold hover:bg-violet-700 transition-colors"
                    >
                      Add to today&apos;s plan
                    </button>
                    <button
                      onClick={() => taskRadarItem(item)}
                      className="flex-1 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold hover:bg-slate-200 transition-colors"
                    >
                      Save as task
                    </button>
                  </div>
                </div>
              )
            ))}
          </div>
        )}
      </section>

      {/* POTENTIAL PROBLEMS — lazy on-demand section. Off the briefing's critical
          path: only generated (and only paid for) when the user taps Check/Refresh. */}
      {!loading && report && (() => {
        const visible = (problems ?? []).filter((p) => showInList(p.title))
        return (
          <section>
            <LazySectionHeader
              icon={AlertTriangle}
              color="#dc2626"
              title="Potential Problems"
              loaded={problems !== null}
              loading={problemsLoading}
              onLoad={loadProblems}
              collapsed={problemsCollapsed}
              onToggleCollapse={() => setProblemsCollapsed((v) => !v)}
            />
            {problems !== null && problemsCollapsed ? null : problems === null ? (
              <LazySectionPrompt
                loading={problemsLoading}
                onLoad={loadProblems}
                hint="Scan for conflicts, gaps, and risks"
              />
            ) : visible.length === 0 ? (
              <div className="rounded-2xl p-4 bg-white shadow-card text-sm text-slate-400">Nothing flagged right now.</div>
            ) : (
              <div className="space-y-2 stagger-children">
                {visible.map((p) =>
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
            )}
          </section>
        )
      })()}

      {/* COPILOT RECOMMENDATIONS — lazy on-demand section (same pattern). */}
      {!loading && report && (() => {
        const visible = (recommendations ?? []).filter((r) => showInList(r.title))
        return (
          <section>
            <LazySectionHeader
              icon={Lightbulb}
              color="#7c3aed"
              title="Copilot Recommendations"
              loaded={recommendations !== null}
              loading={recsLoading}
              onLoad={loadRecommendations}
              collapsed={recsCollapsed}
              onToggleCollapse={() => setRecsCollapsed((v) => !v)}
            />
            {recommendations !== null && recsCollapsed ? null : recommendations === null ? (
              <LazySectionPrompt
                loading={recsLoading}
                onLoad={loadRecommendations}
                hint="Get proactive ideas that reduce future stress"
              />
            ) : visible.length === 0 ? (
              <div className="rounded-2xl p-4 bg-white shadow-card text-sm text-slate-400">No suggestions right now.</div>
            ) : (
              <div className="space-y-2 stagger-children">
                {visible.map((r) =>
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
            )}
          </section>
        )
      })()}


      {/* Calendar link */}
      <div className="text-center -mt-1">
        <button
          onClick={() => router.push('/calendar')}
          className="text-xs text-slate-400 hover:text-slate-700 transition-colors"
        >
          Open full calendar →
        </button>
      </div>

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
  onCapture: (text: string) => void
  debugMode?: boolean
  onTrace?: () => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const borderColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#f97316' : '#eab308'
  const severityBg = p.severity === 'high' ? '#fee2e2' : p.severity === 'medium' ? '#ffedd5' : '#fef9c3'
  const severityColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#ea580c' : '#a16207'
  const toCalendar = p.actionType === 'capture' || p.actionType === 'calendar'
  const captureText = [p.title, p.detail, p.relatedDate ? `Date: ${new Date(p.relatedDate).toLocaleDateString()}` : ''].filter(Boolean).join('. ')

  return (
    <>
      <button
        onClick={() => setSheetOpen(true)}
        className="w-full rounded-2xl bg-white shadow-card animate-slide-up text-left active:scale-[0.99] transition-all"
        style={{ borderLeft: `3px solid ${borderColor}` }}
      >
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900">{p.title}</p>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{p.detail}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: severityBg, color: severityColor }}>
              {p.severity}
            </span>
            <ChevronRight size={14} className="text-slate-200" />
          </div>
        </div>
      </button>

      {sheetOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-5 animate-fade-in"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setSheetOpen(false) }}
        >
          <div
            className="bg-white rounded-2xl shadow-elevated w-full max-w-sm flex flex-col animate-scale-in overflow-hidden"
            style={{ maxHeight: '80vh' }}
          >
            {/* Header */}
            <div className="p-4 border-b border-slate-100 shrink-0">
              <div className="flex items-start gap-3">
                <div className="w-1 self-stretch rounded-full shrink-0 mt-0.5" style={{ background: borderColor }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-[15px] font-semibold text-slate-900 leading-snug">{p.title}</p>
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0 mt-0.5" style={{ background: severityBg, color: severityColor }}>{p.severity}</span>
                  </div>
                  <p className="text-sm text-slate-500 leading-relaxed">{p.detail}</p>
                </div>
              </div>
            </div>
            {/* Actions */}
            <div className="py-1.5 flex-1 overflow-y-auto">
              {p.suggestedAction && (
                <SheetAction
                  icon={toCalendar ? <CalIcon size={18} className="text-blue-600" /> : <MessageCircle size={18} className="text-blue-500" />}
                  label={p.suggestedAction}
                  onClick={() => { setSheetOpen(false); toCalendar ? onCapture(captureText) : onCopilot(`${p.title}. ${p.detail} — ${p.suggestedAction}`) }}
                />
              )}
              <SheetAction
                icon={<MessageCircle size={18} className="text-blue-500" />}
                label="Ask about this…"
                sub="Chat with your assistant"
                onClick={() => { setSheetOpen(false); onCopilot(`${p.title}. ${p.detail}`) }}
              />
              <SheetAction
                icon={<Bookmark size={18} className="text-slate-600" />}
                label="Save as task"
                onClick={() => { setSheetOpen(false); onSaveTask() }}
              />
              <div className="mx-4 my-1 border-t border-slate-100" />
              <SheetAction
                icon={<X size={18} className="text-slate-400" />}
                label="Hide from briefing"
                sub="Removes this flagged item"
                onClick={() => { setSheetOpen(false); onDismiss() }}
              />
              {debugMode && onTrace && (
                <SheetAction icon={<Bug size={18} className="text-blue-400" />} label="Trace sources (debug)" onClick={() => { setSheetOpen(false); onTrace() }} />
              )}
            </div>
            <div className="px-4 pb-4 pt-2 shrink-0 border-t border-slate-50">
              <button onClick={() => setSheetOpen(false)} className="w-full py-2.5 rounded-xl bg-slate-100 text-sm font-medium text-slate-600 hover:bg-slate-200 transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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

// Header for a lazily-loaded section: title on the left, a Check/Refresh control
// on the right that fires the section's own scoped AI request on demand.
function LazySectionHeader({ icon: Icon, color, title, loaded, loading, onLoad, collapsed, onToggleCollapse }: {
  icon: typeof Clock; color: string; title: string
  loaded: boolean; loading: boolean; onLoad: () => void
  collapsed?: boolean; onToggleCollapse?: () => void
}) {
  // Once the section is loaded, the title row becomes a collapse toggle (chevron
  // mirrors the person-section pattern). Before load there's nothing to fold, so
  // the title is static and only the Check button is interactive.
  const canCollapse = loaded && !!onToggleCollapse
  return (
    <div className="flex items-center justify-between mb-3">
      <button
        onClick={canCollapse ? onToggleCollapse : undefined}
        disabled={!canCollapse}
        className="flex items-center gap-2 text-left disabled:cursor-default"
      >
        <Icon size={16} style={{ color }} />
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        {canCollapse && (
          <ChevronDown
            size={15}
            className="text-slate-400 shrink-0 transition-transform duration-200"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          />
        )}
      </button>
      <button
        onClick={onLoad}
        disabled={loading}
        className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50 transition-colors"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Checking…' : loaded ? 'Refresh' : 'Check'}
      </button>
    </div>
  )
}

// The "tap to load" placeholder shown before a lazy section has been fetched.
function LazySectionPrompt({ loading, onLoad, hint }: { loading: boolean; onLoad: () => void; hint: string }) {
  if (loading) {
    return (
      <div className="rounded-2xl p-4 bg-white shadow-card">
        <div className="skeleton h-4 w-40 rounded mb-2.5" />
        <div className="skeleton h-3 w-full rounded" />
      </div>
    )
  }
  return (
    <button
      onClick={onLoad}
      className="w-full rounded-2xl p-4 bg-white shadow-card text-left text-sm text-slate-400 hover:text-slate-600 transition-colors"
    >
      {hint} →
    </button>
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
