'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  collection, doc, setDoc, writeBatch, getDocs, query, where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  RefreshCw, AlertTriangle, Lightbulb, Clock,
  Calendar as CalIcon, Sparkles, Check, HelpCircle, X, MessageCircle, Users, Bookmark, Plus,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useCapture } from '@/contexts/CaptureContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { ConnectGooglePrompt } from '@/components/dashboard/ConnectGooglePrompt'
import { generateId } from '@/lib/utils'
import { resolveMemberRef } from '@/lib/members'
import { BUCKET_META } from '@/lib/types'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  AttentionReport, AttentionItem, AttentionBucket, PotentialProblem,
  FamilyMemory, FamilyProfile, FamilyReminder,
} from '@/lib/types'

type CalendarClarification = {
  id: string
  eventId: string
  eventTitle: string
  eventDate: string
  question: string
  hint: string
}

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
}

const BUCKET_ORDER: AttentionBucket[] = ['now', 'next', 'later', 'upcoming']

// ── Local cache (stale-while-revalidate) ────────────────────
// Everything that gates the page is cached per-family so returning visits
// render instantly and only update in the background.
const ATTN_PREFIX = 'fam-attn-'
const GCAL_PREFIX = 'fam-gcal-'
const CLAR_PREFIX = 'fam-clar-'
const GMAIL_PREFIX = 'fam-gmail-'
const LAST_RUN_PREFIX = 'fam-lastrun-'
const CTX_SIG_PREFIX = 'fam-ctxsig-'
// The ctxSignature that was in effect when the AI last ran. Compared in the
// auto-run throttle to detect "nothing changed — skip the AI call."
const LAST_RUN_SIG_PREFIX = 'fam-lastrun-sig-'

// 15-minute minimum between AI calls. Additionally, if the data signature hasn't
// changed since the last run, we extend the effective throttle to 45 minutes:
// time-buckets (now/next/later) shift over time even without data changes, so
// a periodic re-run is still needed — just much less often than 15 min.
const ENGINE_THROTTLE_MS = 15 * 60 * 1000
// How long to reuse a cached briefing when data hasn't changed (45 min).
// After this, re-run anyway so time-buckets (now/next/later) stay fresh.
const ENGINE_DATA_UNCHANGED_TTL_MS = 45 * 60 * 1000

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

// Open a specific Gmail message in the system browser (Safari), NOT inside the
// app's own webview. We use #all/<id> rather than #inbox/<id> so the message is
// found even after it's been archived out of the inbox.
//
// The key insight for iOS standalone PWAs: window.open() is silently blocked and
// setting window.location.href just navigates the chrome-less PWA webview — which
// is NOT signed into Gmail, so the deep link never resolves to the actual email
// (the tap appears to "open in the app" and go nowhere). A programmatic click on
// an <a target="_blank"> element DOES hand the URL off to Safari, where the user
// is already signed into Gmail and #all/<id> opens the real message.
function openGmailMessage(messageId: string) {
  const url = `https://mail.google.com/mail/u/0/#all/${messageId}`
  try {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } catch {
    // Last resort if DOM manipulation is unavailable.
    window.open(url, '_blank', 'noopener,noreferrer') || (window.location.href = url)
  }
}

function readCache<T>(key: string | null): T | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeCache(key: string | null, value: unknown) {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
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
  const gcalKey = familyId ? GCAL_PREFIX + familyId : null
  const clarKey = familyId ? CLAR_PREFIX + familyId : null
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
  // Greeting text as it streams in during a cold start, shown in place of the
  // skeleton so the user reads the headline ~2s in rather than waiting ~20s.
  const [streamingGreeting, setStreamingGreeting] = useState('')
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
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
  // Refs so the visibilitychange handler can read current state without stale closures.
  const engineErrorRef = useRef<string | null>(null)
  const reportRef = useRef<AttentionReport | null>(null)
  useEffect(() => { engineErrorRef.current = engineError }, [engineError])
  useEffect(() => { reportRef.current = report }, [report])
  const [clarifications, setClarifications] = useState<CalendarClarification[]>([])
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [clarificationsDismissed, setClarificationsDismissed] = useState(false)
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [selfLinkDismissed, setSelfLinkDismissed] = useState(false)
  const clarificationsFetched = useRef(false)
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
  // Titles checked off this session. Hidden from view immediately so the card
  // disappears on tap, rather than waiting for the engine to re-run and drop it.
  const [completedTitles, setCompletedTitles] = useState<Set<string>>(new Set())
  // When a user dismisses something, offer to teach the assistant once.
  const [teachPrompt, setTeachPrompt] = useState<{ title: string; reason: string } | null>(null)
  // After saving calendar context, show a brief inline confirmation telling the
  // user what was saved and how the assistant will use it.
  const [contextSaved, setContextSaved] = useState<{ eventTitle: string; context: string } | null>(null)
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
  // Keeping report/googleEvents visible prevents the blank-then-reload flicker.
  const clearCaches = useCallback(() => {
    if (!familyId) return
    const prefixes = [ATTN_PREFIX, GCAL_PREFIX, CLAR_PREFIX, GMAIL_PREFIX, LAST_RUN_PREFIX, CTX_SIG_PREFIX, LAST_RUN_SIG_PREFIX]
    prefixes.forEach((p) => {
      try { localStorage.removeItem(p + familyId) } catch { /* ignore */ }
    })
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
    const g = readCache<CalendarEvent[]>(gcalKey)
    if (g?.length) setGoogleEvents(g)
    const c = readCache<CalendarClarification[]>(clarKey)
    if (c?.length) setClarifications(c)
    const em = readCache<EmailSuggestion[]>(gmailKey)
    if (em?.length) setEmailSuggestions(em)
    const dism = readCache<string[]>(dismissKey)
    if (dism?.length) setDismissedTitles(new Set(dism))
    // Restore the last context signature so Firestore delivering the same data
    // on remount doesn't look like "new context" and trigger an immediate re-run.
    const savedCtxSig = readCache<string>(ctxSigKey)
    if (savedCtxSig) lastCtxSig.current = savedCtxSig
    const savedRunSig = readCache<string>(lastRunSigKey)
    if (savedRunSig) lastRunSig.current = savedRunSig
    setHydrated(true)
  }, [familyId, attnKey, gcalKey, clarKey, gmailKey, dismissKey, lastRunKey, ctxSigKey, lastRunSigKey])

  // Scan Gmail for actionable items — once per session, using the main Google
  // connection's token (it already includes the gmail.readonly scope). Results
  // are cached so they paint instantly on return and refresh quietly.
  useEffect(() => {
    if (!isConnected || emailFetched.current) return
    emailFetched.current = true
    let cancelled = false
    ;(async () => {
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return
      try {
        const res = await fetch('/api/gmail-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: fresh.accessToken }),
        })
        const data = await res.json()
        if (!cancelled && res.ok && Array.isArray(data.suggestions)) {
          const cleaned: EmailSuggestion[] = data.suggestions.filter(
            (s: EmailSuggestion) => s && s.title && (s.confidence ?? 1) >= 0.6,
          )
          setEmailSuggestions(cleaned)
          writeCache(gmailKey, cleaned)
        }
      } catch { /* keep cached suggestions */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, gmailKey])

  // Trigger a server-side calendar sync once per session for any family member.
  // This keeps events fresh in Firestore even if the person who connected their
  // calendar hasn't opened the app recently — anyone's load triggers the refresh.
  const calSyncedRef = useRef(false)
  useEffect(() => {
    if (!familyId || calSyncedRef.current) return
    calSyncedRef.current = true
    ;(async () => {
      try {
        const { auth: firebaseAuth } = await import('@/lib/firebase')
        const idToken = await firebaseAuth.currentUser?.getIdToken()
        if (idToken) {
          await fetch('/api/calendar/sync', {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}` },
          })
        }
      } catch { /* non-fatal */ }
    })()
  }, [familyId])

  // Fetch fresh Google Calendar events when connected (updates the cache).
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!isConnected || !familyId || !user?.email) {
        setGoogleEvents([])
        setGoogleLoaded(true)
        return
      }
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return
      const timeMin = new Date().toISOString()
      const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      try {
        const res = await fetch(
          `/api/calendar/events?accessToken=${encodeURIComponent(fresh.accessToken)}&refreshToken=${encodeURIComponent(fresh.refreshToken)}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
        )
        const data = await res.json()
        if (!cancelled && res.ok) {
          const ownerEmail = user.email
          const loadedEvents: CalendarEvent[] = (data.events ?? []).map((e: CalendarEvent) => ({
            ...e,
            ownerEmail: e.ownerEmail || ownerEmail,
          }))
          setGoogleEvents(loadedEvents)
          writeCache(gcalKey, loadedEvents)

          // Sync into Firestore so all family members see this person's events.
          // Replace the owner's existing Google-sourced events with the fresh batch.
          try {
            const eventsCol = collection(db, 'families', familyId, 'events')
            const oldSnap = await getDocs(
              query(eventsCol, where('ownerEmail', '==', ownerEmail), where('source', '==', 'google'))
            )
            const batch = writeBatch(db)
            oldSnap.docs.forEach((d) => batch.delete(d.ref))
            loadedEvents.forEach((e) => {
              batch.set(doc(eventsCol, e.id), { ...e, source: 'google' })
            })
            await batch.commit()
          } catch { /* sync failure is non-fatal */ }
        }
      } catch { /* keep cached events */ } finally {
        if (!cancelled) setGoogleLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, gcalKey, familyId, calSyncKey])

  // Ask the AI which calendar events are ambiguous — once per session, skipping
  // events the family has already explained. Cached so it doesn't pop in again.
  useEffect(() => {
    const eventsForContext = googleEvents.length > 0 ? googleEvents : localEvents
    if (eventsForContext.length === 0 || clarificationsFetched.current) return
    clarificationsFetched.current = true
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/ai/calendar-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: eventsForContext,
            members,
            now: new Date().toISOString(),
            knownEventIds: eventContexts.map((e) => e.id),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        })
        const data = await res.json()
        if (!cancelled && res.ok && data.clarifications?.length > 0) {
          setClarifications(data.clarifications)
          writeCache(clarKey, data.clarifications)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleEvents.length, localEvents.length, eventContexts.length])

  // All family members read events from Firestore (which is kept in sync with
  // Google Calendar by the fetch above). This means connected members' events
  // are visible to everyone in the family, not just the person who connected.
  // Fall back to live googleEvents only if Firestore hasn't populated yet.
  const events = localEvents.length > 0 ? localEvents : googleEvents

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

    return {
      members, events: upcomingEvents, tasks: allTasks, chores, plans, lists, eventContext,
      profile, memories, inbox, tier,
      currentUserEmail: user?.email ?? undefined,
      currentUserName: user?.displayName ?? undefined,
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Titles the user has explicitly dismissed — the engine must not re-surface them.
      suppressedTitles: Array.from(dismissedTitles),
    }
  }, [members, events, tasks, reminders, chores, plans, lists, profile, memories, emailSuggestions, user, dismissedTitles])

  const runEngine = useCallback(async (overrideContext?: { eventTitle: string; context: string }[], silent?: boolean) => {
    // Cancel any previous in-flight request before starting a new one.
    engineAbortRef.current?.abort()
    const controller = new AbortController()
    engineAbortRef.current = controller

    if (silent) setRefreshing(true)
    else setLoading(true)
    // Stamp the run time immediately so manual refreshes also update the throttle.
    // Both auto-runs (which set lastRun.current before calling) and manual refreshes
    // (which call runEngine directly) will record the correct timestamp.
    const runAt = Date.now()
    lastRun.current = runAt
    // Bump the token: this fast run is now the latest, so any in-flight deep pass
    // from a previous run will be ignored when it returns.
    const myToken = ++deepToken.current
    // Background runs (silent + already have a report) are buffered into
    // pendingReport so content doesn't shift while the user is scrolling.
    // The user applies the update by tapping the "Briefing updated" banner.
    // Foreground runs (cold start or manual refresh) update report immediately.
    // forceDirectRef overrides: stale cached reports and post-reset runs bypass
    // the buffer so the corrected content appears without a "tap to see" step.
    const isPending = !!(silent && report) && !forceDirectRef.current
    forceDirectRef.current = false
    try {
      const eventContext = overrideContext ??
        eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))

      const res = await fetch('/api/ai/attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEngineBody(eventContext, 'fast')),
        signal: controller.signal,
      })

      // Pre-stream failures (bad request, missing key) still come back as JSON.
      if (!res.ok || !res.body) {
        let msg = 'Something went wrong. Tap refresh to try again.'
        try { const d = await res.json(); msg = d.error ?? msg } catch { /* keep default */ }
        setEngineError(msg)
        lastRun.current = 0
        return
      }

      // Only show the streaming greeting on a foreground cold start — background
      // refreshes must not disturb the report already on screen.
      const progressive = !silent
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
          let evt: { t?: string; d?: string; error?: string } & Partial<AttentionReport>
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.t === 'delta') {
            if (progressive && evt.d) {
              rawText += evt.d
              const g = extractPartialGreeting(rawText)
              if (g) setStreamingGreeting(g)
            }
          } else if (evt.t === 'final') {
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
      setLoading(false)
      setRefreshing(false)
      setStreamingGreeting('')
    }
  }, [buildEngineBody, eventContexts, attnKey, report])

  // Auto-run once the data we expect is loaded. Always silent when a report is
  // already on screen (cached or fresh) so content updates in place, never via a
  // skeleton flash. We wait for Google to settle first to avoid an empty run.
  useEffect(() => {
    if (!hydrated) return
    // If connected but no events at all yet, wait for Google Calendar to load
    // so we don't generate a "nothing happening" briefing that's immediately stale.
    // If we have cached events (local or google), fire immediately; a silent
    // re-run will follow when fresh Google data arrives via ctxSignature.
    if (isConnected && !googleLoaded && events.length === 0) return
    if (members.length === 0 && events.length === 0 && tasks.length === 0) return
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
    runEngine(undefined, !!report)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, googleLoaded, members.length, events.length, tasks.length, reminders.length, googleEvents.length])

  // The inbox scan, durable memory, and profile often arrive a beat after the
  // first render. When they change, weave them into the briefing right away —
  // bypassing the throttle — so the assistant stays current without a flash.
  const completedCount = tasks.filter((t) => t.isCompleted).length + reminders.filter((r) => r.isCompleted).length
  // Include a fingerprint of the events so calendar data that syncs in AFTER the
  // first render (e.g. another family member's Google events arriving via the
  // server sync) immediately refreshes the briefing instead of waiting out the
  // 60s throttle. Using ids+starts catches replacements, not just count changes.
  const eventsFingerprint = events.map((e) => `${e.id}:${e.start}`).sort().join(',')
  const ctxSignature = `${emailSuggestions.length}|${memories.length}|${profile?.updatedAt ?? ''}|${completedCount}|${eventsFingerprint}`
  const lastCtxSig = useRef<string>('')
  useEffect(() => {
    if (!hydrated) return
    if (lastCtxSig.current === ctxSignature) return
    const prev = lastCtxSig.current
    lastCtxSig.current = ctxSignature
    writeCache(ctxSigKey, ctxSignature)
    // Skip on the very first hydration pass (prev was '' or the cached value).
    // Only run when data *genuinely* changes after the initial load, and only if
    // at least 60 seconds have elapsed since the last run (prevents rapid-fire).
    if (prev === '' || Date.now() - lastRun.current < 60_000) return
    // Silent if a report exists, cold-start otherwise (so the user sees the loader).
    runEngine(undefined, !!report)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxSignature, hydrated])

  // Auto-retry when the user returns to the app. iOS Safari aborts in-flight
  // fetches when a PWA is backgrounded; when the user comes back we want a
  // seamless retry rather than a stale error screen.
  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState !== 'visible') return
      const hasError = !!engineErrorRef.current
      const hasNoReport = !reportRef.current
      if (hasError || hasNoReport) {
        setEngineError(null)
        lastRun.current = 0
        runEngine(undefined, !hasNoReport)
      }
    }
    document.addEventListener('visibilitychange', handleVisible)
    return () => document.removeEventListener('visibilitychange', handleVisible)
  }, [runEngine])

  // Auto-dismiss the "context saved" confirmation after a few seconds.
  useEffect(() => {
    if (!contextSaved) return
    const t = setTimeout(() => setContextSaved(null), 6000)
    return () => clearTimeout(t)
  }, [contextSaved])

  // Assign an item to people. Two-sided: `forIds` is who it concerns (e.g. the
  // kids); `responsibleId` is who handles it (e.g. a parent). Keyed by member ID
  // because kids/pets often have no email. We persist this three ways so it sticks
  // across engine re-runs:
  //  1. Optimistic on-screen override so the chips update instantly.
  //  2. Update the underlying task/reminder's assigneeEmail (the responsible person).
  //  3. A family-wide memory capturing the full nuance, deduped per item title,
  //     so the AI re-emits the assignment on every future briefing.
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

    // 2. Update underlying task/reminder assignee, if this item maps to one.
    //    Write the canonical id (works for emailless members) plus email for
    //    backward-compat.
    if (responsible) {
      const af = { assigneeId: responsible.id, assigneeEmail: responsible.email || undefined }
      const t = item.sourceId
        ? tasks.find((x) => x.id === item.sourceId)
        : tasks.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (t) await updateTask({ ...t, ...af })
      const r = item.sourceId
        ? reminders.find((x) => x.id === item.sourceId)
        : reminders.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (r) await updateReminder({ ...r, ...af })
    }

    // 3. Persist the nuance as a deduped family memory.
    const marker = `Assignment · "${item.title}":`
    const parts: string[] = []
    if (forNames) parts.push(`it concerns ${forNames}`)
    if (respName) parts.push(`${respName} is responsible for handling it`)
    const text = `${marker} ${parts.join('; ')}.`
    try {
      const existing = memories.find((m) => m.text.startsWith(marker))
      if (existing) {
        await updateMemory({ ...existing, text, createdAt: new Date().toISOString() })
      } else {
        await createMemory({
          id: generateId(),
          text,
          category: 'logistics',
          source: 'manual',
          createdAt: new Date().toISOString(),
        } as FamilyMemory)
      }
    } catch { /* non-fatal */ }

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

  async function saveItemAsTask(title: string, detail?: string) {
    if (!familyId) return
    await createTask({
      id: generateId(),
      title,
      notes: detail,
      isCompleted: false,
      priority: 'high',
      source: 'ai',
      createdAt: new Date().toISOString(),
    } as Task)
    toast(`Saved "${title}" as a task`, 'success')
  }

  // Acting on a recommendation creates the to-do directly and clears the card,
  // rather than popping the Capture sheet or handing off to Copilot. One tap,
  // a confirmation toast, done — the recommendation is "nice to do", so it
  // lands at medium priority instead of high.
  async function addRecommendationAsTask(title: string, rationale: string) {
    if (!familyId) return
    await createTask({
      id: generateId(),
      title,
      notes: rationale,
      isCompleted: false,
      priority: 'medium',
      source: 'ai',
      createdAt: new Date().toISOString(),
    } as Task)
    setCompletedTitles((prev) => new Set(prev).add(title))
    toast(`Added "${title}" to your tasks`, 'success')
  }

  // Save one clarification, then immediately re-run the engine with it included.
  async function saveClarification(c: CalendarClarification) {
    const answer = clarificationAnswers[c.id]?.trim()
    if (!answer || !familyId) return
    setSavingItemId(c.id)
    try {
      await createEventContext({
        id: c.eventId,
        eventTitle: c.eventTitle,
        context: answer,
        savedAt: new Date().toISOString(),
      })
      // Confirm to the user what was saved and what it means — both an inline
      // card (where the question was) and a toast.
      setContextSaved({ eventTitle: c.eventTitle, context: answer })
      toast(`Got it — I'll use that to help with "${c.eventTitle}"`, 'success')
      // Build the merged context so the just-saved answer is used right away,
      // without waiting for the Firestore snapshot to round-trip. Run SILENTLY so
      // the briefing stays on screen and updates in place (TopProgressBar shows
      // the refresh is happening) rather than blanking out.
      const merged = [
        ...eventContexts
          .filter((e) => e.id !== c.eventId)
          .map((e) => ({ eventTitle: e.eventTitle, context: e.context })),
        { eventTitle: c.eventTitle, context: answer },
      ]
      await runEngine(merged, true)
    } finally {
      setSavingItemId(null)
    }
  }

  // Hide events the family has already explained (in this or a past session).
  const answeredIds = new Set(eventContexts.map((e) => e.id))
  const visibleClarifications = clarifications.filter((c) => !answeredIds.has(c.eventId))

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

  function dismissItem(title: string) {
    setDismissedTitles((prev) => {
      const next = new Set(prev).add(title)
      writeCache(dismissKey, Array.from(next))
      return next
    })
    // Surface the teach prompt briefly so they can give feedback
    setTeachPrompt({ title, reason: '' })
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

  const busy = loading || refreshing

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <TopProgressBar active={busy} />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Good {greeting()}, {firstName}
          </h1>
        </div>
        <button
          onClick={() => { setPendingReport(null); runEngine(undefined, false) }}
          disabled={busy}
          className="mt-1 p-2.5 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shadow-card disabled:opacity-60"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
        </button>
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

      {report?.greeting && (
        <div className="rounded-2xl p-5 bg-gradient-to-br from-blue-600 to-purple-700 text-white shadow-elevated animate-scale-in">
          <button
            onClick={() => openBriefingInCopilot(report.greeting!)}
            className="flex items-start gap-3 text-left w-full"
          >
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium">{report.greeting}</p>
          </button>
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={() => openBriefingInCopilot(report.greeting!)}
              className="flex items-center gap-1.5 text-[12px] font-semibold text-white/90 hover:text-white transition-colors"
            >
              <MessageCircle size={13} className="shrink-0" />
              Ask a follow-up
            </button>
          </div>
        </div>
      )}

      {/* Context-saved confirmation — tells the user what the assistant learned
          and that it's now factoring it in (the briefing refreshes in place). */}
      {contextSaved && (
        <div className="rounded-2xl p-4 bg-green-50 border border-green-200 flex items-start gap-3 animate-slide-up">
          <Check size={16} className="text-green-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-green-800">Got it — I&apos;ll remember that</p>
            <p className="text-xs text-green-700 mt-0.5 leading-relaxed">
              For <span className="font-medium">{contextSaved.eventTitle}</span>: &ldquo;{contextSaved.context}&rdquo;.
              I&apos;m using this to understand what it needs and surface the right prep at the right time —
              updating your briefing now.
            </p>
          </div>
          <button
            onClick={() => setContextSaved(null)}
            className="shrink-0 text-green-400 hover:text-green-600"
            aria-label="Dismiss"
          >
            <X size={14} />
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

      {/* Calendar Intelligence — clarification requests (saved per item) */}
      {visibleClarifications.length > 0 && !clarificationsDismissed && (
        <section className="rounded-2xl p-5 bg-amber-50 border border-amber-200 animate-slide-up">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <HelpCircle size={16} className="text-amber-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-amber-900">Help me understand your calendar</h3>
              <p className="text-xs text-amber-700 mt-0.5">
                Answer any that are useful — each is saved on its own and your assistant uses it right away.
              </p>
            </div>
            <button
              onClick={() => setClarificationsDismissed(true)}
              className="ml-auto text-amber-400 hover:text-amber-600"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
          <div className="space-y-3">
            {visibleClarifications.map((c) => {
              const answer = clarificationAnswers[c.id] ?? ''
              const saving = savingItemId === c.id
              return (
                <div key={c.id} className="bg-white rounded-xl p-3 border border-amber-100">
                  <p className="text-xs font-medium text-slate-700 mb-1">
                    📅 {c.eventTitle} · {new Date(c.eventDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-xs text-slate-500 mb-2">{c.question}</p>
                  <div className="flex items-center gap-2">
                    <input
                      placeholder={c.hint}
                      value={answer}
                      onChange={(e) => setClarificationAnswers((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveClarification(c) }}
                      className="flex-1 text-xs rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-slate-50"
                    />
                    <button
                      onClick={() => saveClarification(c)}
                      disabled={!answer.trim() || saving}
                      className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Cold-start skeleton — only when we have nothing cached to show. Shaped
          like the real content so there is no jump when the report arrives.
          Once the greeting starts streaming in, show it live in place of the
          top skeleton block so the user reads the headline ~2s in. */}
      {loading && !report && (
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
          <div className="space-y-3">
            <div className="skeleton h-4 w-24 rounded" />
            <div className="skeleton h-20 w-full rounded-2xl" />
            <div className="skeleton h-20 w-full rounded-2xl" />
          </div>
        </div>
      )}

      {/* NEXT UP */}
      {report && (report.items ?? []).some((i) => showInList(i.title)) && (
        <section>
          <SectionLabel icon={Clock} color="#0f172a">Next Up</SectionLabel>
          <div className="space-y-4">
            {BUCKET_ORDER.map((bucket) => {
              const items = itemsByBucket(bucket).filter((i) => showInList(i.title))
              if (items.length === 0) return null
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
                    {items.map((item) => {
                      // While this item's teach prompt is open, show the feedback
                      // box right here in the card's slot instead of the card.
                      if (teachPrompt?.title === item.title) {
                        return (
                          <TeachPrompt
                            key={item.id}
                            title={item.title}
                            onTeach={(feedback) => teachAssistant(item.title, feedback)}
                            onDismiss={() => setTeachPrompt(null)}
                          />
                        )
                      }
                      // Resolve who it's for / who's responsible. A user override
                      // (keyed by member id) wins; otherwise fall back to the AI's
                      // assignment, which may reference a member by email OR name
                      // (names work for emailless children/pets).
                      const ov = assignmentOverrides[item.title]
                      const byId = (id?: string) => members.find((m) => m.id === id)
                      const responsible = ov
                        ? byId(ov.responsibleId)
                        : resolveMemberRef(members, item.assigneeEmail)
                      const forMembers = ov
                        ? (ov.forIds ?? []).map(byId).filter(Boolean) as FamilyMember[]
                        : (item.forEmails ?? []).map((ref) => resolveMemberRef(members, ref)).filter(Boolean) as FamilyMember[]
                      return (
                        <AttentionCard
                          key={item.id}
                          item={item}
                          accent={meta.color}
                          allMembers={members}
                          responsible={responsible}
                          forMembers={forMembers}
                          backedByRealItem={!!item.sourceId && (
                            tasks.some((t) => t.id === item.sourceId) ||
                            reminders.some((r) => r.id === item.sourceId)
                          )}
                          onComplete={() => completeTaskFromItem(item)}
                          onDismiss={() => dismissItem(item.title)}
                          onSaveTask={() => saveItemAsTask(item.title, item.reason)}
                          onAssign={(f, r) => assignItem(item, f, r)}
                          onAddContext={(context) => {
                            // Re-run the engine with the added context so it appears immediately
                            const merged = [
                              ...eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context })),
                              { eventTitle: item.title, context },
                            ]
                            createEventContext({
                              id: generateId(),
                              eventTitle: item.title,
                              context,
                              savedAt: new Date().toISOString(),
                            } as EventContext)
                            setContextSaved({ eventTitle: item.title, context })
                            toast(`Got it — I'll use that to help with "${item.title}"`, 'success')
                            runEngine(merged, true)
                          }}
                        />
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* POTENTIAL PROBLEMS */}
      {report && (report.problems?.length ?? 0) > 0 && (
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
                  />
                ) : (
                  <ProblemCard
                    key={p.id}
                    problem={p}
                    onSaveTask={() => saveItemAsTask(p.title, p.detail)}
                    onDismiss={() => dismissItem(p.title)}
                    onCopilot={(text) => openBriefingInCopilot(text)}
                    onCapture={(text) => openCapture({ text, autoAnalyze: true })}
                  />
                ),
              )}
          </div>
        </section>
      )}

      {/* COPILOT RECOMMENDATIONS */}
      {report && (report.recommendations?.length ?? 0) > 0 && (
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
                            : addRecommendationAsTask(r.title, r.rationale)}
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

      {/* Empty-state nudge */}
      {report && (report.items?.length ?? 0) === 0 && (report.problems?.length ?? 0) === 0 && (
        <div className="rounded-2xl p-8 bg-white shadow-card text-center">
          <div className="text-4xl mb-3">🌤️</div>
          <p className="text-sm font-medium text-slate-700">You&apos;re all clear.</p>
          <p className="text-xs text-slate-400 mt-1">Nothing needs your attention right now.</p>
        </div>
      )}

      {/* Escape hatch — if a deleted event or wrong data keeps appearing, this
          nukes all local caches and forces a fresh pull from Google + AI. */}
      {(report || engineError) && (
        <div className="text-center pb-2">
          <button
            onClick={() => clearCaches()}
            className="text-xs text-slate-300 hover:text-slate-500 transition-colors"
          >
            Seeing something wrong? Reset cached data
          </button>
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
}: {
  problem: PotentialProblem
  onSaveTask: () => void
  onDismiss: () => void
  onCopilot: (text: string) => void
  // Opens the Capture dialog (which has a per-calendar event picker) pre-filled
  // with this problem, for "add to calendar" style actions.
  onCapture: (text: string) => void
}) {
  const [saved, setSaved] = useState(false)
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
          {p.sourceEmailId && (
            <button
              onClick={() => openGmailMessage(p.sourceEmailId!)}
              className="inline-flex items-center gap-1 mt-1 text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                <path d="M20 18h-2V9.25L12 13 6 9.25V18H4V6h1.2l6.8 4.25L18.8 6H20v12z"/>
              </svg>
              View email
            </button>
          )}
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
    </div>
  )
}

// A thin indeterminate bar pinned to the very top of the viewport. It signals
// background activity without occupying layout space or shifting any content.
function TopProgressBar({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="fixed top-0 inset-x-0 z-50 h-0.5 overflow-hidden pointer-events-none">
      <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-progress-slide" />
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

function AttentionCard({
  item, accent, allMembers, responsible, forMembers, backedByRealItem, onComplete, onDismiss, onSaveTask, onAddContext, onAssign,
}: {
  item: AttentionItem
  accent: string
  allMembers: FamilyMember[]
  responsible?: FamilyMember
  forMembers: FamilyMember[]
  backedByRealItem: boolean
  onComplete: () => void
  onDismiss: () => void
  onSaveTask: () => void
  onAddContext: (context: string) => void
  onAssign: (forIds: string[], responsibleId?: string) => void
}) {
  const [done, setDone] = useState(false)
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [contextDraft, setContextDraft] = useState('')
  // When an inline panel opens, bring it into view so the user isn't left
  // staring at the same spot while the response area appears off-screen.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if ((expanded || assigning) && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [expanded, assigning])
  const startStr = item.startBy
    ? new Date(item.startBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  function submitContext() {
    const v = contextDraft.trim()
    if (!v) return
    onAddContext(v)
    setContextDraft('')
    setExpanded(false)
  }

  const hasAssignment = !!responsible || forMembers.length > 0

  return (
    <div
      className="rounded-2xl bg-white shadow-card animate-slide-up transition-opacity"
      style={{ borderLeft: `3px solid ${accent}`, opacity: done ? 0.5 : 1 }}
    >
      <div className="flex items-start gap-3 p-4">
        {/* Checkbox only when the sourceId actually matches a real Firestore
            task/reminder in the current data. The AI sometimes tags an
            awareness item (e.g. a grounding pulled from memory) as a task with
            a sourceId that doesn't exist — validating against live data here
            means no phantom checkbox appears on things that aren't real tasks. */}
        {backedByRealItem && (item.sourceType === 'task' || item.sourceType === 'reminder') && (
          <button
            onClick={() => { setDone(true); onComplete() }}
            className="mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors"
            style={{ borderColor: done ? '#22c55e' : '#cbd5e1', background: done ? '#22c55e' : 'transparent' }}
          >
            {done && <Check size={12} className="text-white" />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900">{item.title}</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.reason}</p>
          {item.sourceEmailId && (
            <button
              onClick={() => openGmailMessage(item.sourceEmailId!)}
              className="inline-flex items-center gap-1 mt-1 text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                <path d="M20 18h-2V9.25L12 13 6 9.25V18H4V6h1.2l6.8 4.25L18.8 6H20v12z"/>
              </svg>
              View email
            </button>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {startStr && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: `${accent}15`, color: accent }}>
                <Clock size={10} /> Start by {startStr}
              </span>
            )}
            {/* Who it's FOR (the kids / subject) */}
            {forMembers.length > 0 && (
              <button
                onClick={() => setAssigning((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700"
              >
                <span className="text-slate-400">For</span>
                {forMembers.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1">
                    <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${m.colorHex}25` }}>
                      {m.emoji}
                    </span>
                    {m.name}
                  </span>
                ))}
              </button>
            )}
            {/* Who's RESPONSIBLE (the parent handling it) */}
            {responsible && (
              <button
                onClick={() => setAssigning((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-600 font-medium"
              >
                <span className="text-slate-400 font-normal">·</span>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${responsible.colorHex}25` }}>
                  {responsible.emoji}
                </span>
                {responsible.name}
                <span className="text-slate-400 font-normal">on it</span>
              </button>
            )}
            {/* Assign affordance when nothing is set yet */}
            {!hasAssignment && (
              <button
                onClick={() => setAssigning((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
              >
                <Users size={11} /> Assign
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-0.5 shrink-0">
          <button
            onClick={() => setAssigning((v) => !v)}
            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-colors"
            title="Assign"
          >
            <Users size={14} />
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-colors"
            title="Add context"
          >
            <HelpCircle size={14} />
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

      {assigning && (
        <div ref={panelRef}>
          <AssignPanel
            allMembers={allMembers}
            initialFor={forMembers.map((m) => m.id)}
            initialResponsible={responsible?.id}
            onCancel={() => setAssigning(false)}
            onSave={(f, r) => { onAssign(f, r); setAssigning(false) }}
          />
        </div>
      )}

      {expanded && (
        <div ref={panelRef} className="px-4 pb-4 border-t border-slate-50 pt-3">
          <p className="text-xs text-slate-500 mb-2">Add context so the assistant understands this better:</p>
          <div className="flex gap-2">
            <input
              value={contextDraft}
              onChange={(e) => setContextDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitContext() }}
              placeholder={`e.g. "This is a work thing, not family"`}
              className="flex-1 text-xs rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-slate-50"
              autoFocus
            />
            <button
              onClick={submitContext}
              disabled={!contextDraft.trim()}
              className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Two-sided assignment: pick who it's FOR (often the kids — multi-select) and
// optionally who's RESPONSIBLE for handling it (one parent). Keeping these
// separate captures the real nuance: a kid's appointment is "for" the kid but a
// parent does the driving.
function AssignPanel({
  allMembers, initialFor, initialResponsible, onCancel, onSave,
}: {
  allMembers: FamilyMember[]
  initialFor: string[]                                  // member IDs
  initialResponsible?: string                           // member ID
  onCancel: () => void
  onSave: (forIds: string[], responsibleId?: string) => void  // member IDs
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
        <p className="text-xs font-medium text-slate-600 mb-1.5">Who&apos;s responsible? <span className="text-slate-400 font-normal">(optional)</span></p>
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

function TeachPrompt({
  title, onTeach, onDismiss,
}: {
  title: string
  onTeach: (feedback: string) => void
  onDismiss: () => void
}) {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="rounded-2xl p-4 bg-slate-50 border border-slate-200 animate-slide-up">
      <p className="text-xs font-medium text-slate-700 mb-2">
        Want to teach your assistant not to show things like this?
      </p>
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
