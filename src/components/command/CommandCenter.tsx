'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  collection, doc, setDoc, writeBatch, getDocs, query, where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  RefreshCw, AlertTriangle, Lightbulb, Clock,
  Calendar as CalIcon, Sparkles, Check, HelpCircle, X, MessageCircle, Users,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useCapture } from '@/contexts/CaptureContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { ConnectGooglePrompt } from '@/components/dashboard/ConnectGooglePrompt'
import { MicButton } from '@/components/ui/MicButton'
import { generateId } from '@/lib/utils'
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
}

const BUCKET_ORDER: AttentionBucket[] = ['now', 'next', 'later', 'upcoming']

// ── Local cache (stale-while-revalidate) ────────────────────
// Everything that gates the page is cached per-family so returning visits
// render instantly and only update in the background.
const ATTN_PREFIX = 'fam-attn-'
const GCAL_PREFIX = 'fam-gcal-'
const CLAR_PREFIX = 'fam-clar-'
const GMAIL_PREFIX = 'fam-gmail-'

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
  const { isConnected, getFreshTokens } = useGoogleTokens()
  const { familyId } = useFamily()
  const { toast } = useToast()

  const { data: members, update: updateMember } = useFirestore<FamilyMember>('members')
  const { data: localEvents } = useFirestore<CalendarEvent>('events')
  const { data: tasks, update: updateTask } = useFirestore<Task>('tasks')
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

  const [report, setReport] = useState<AttentionReport | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)        // true cold start only (no report yet)
  const [refreshing, setRefreshing] = useState(false)  // silent background update
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [googleLoaded, setGoogleLoaded] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const lastRun = useRef<number>(0)
  // Guards the background "deep" (Opus) pass: each fast run bumps this token, and
  // a deep pass only applies its result if its token is still the latest — so a
  // newer briefing never gets clobbered by a stale deep pass finishing late.
  const deepToken = useRef<number>(0)
  const [deepening, setDeepening] = useState(false)
  const [clarifications, setClarifications] = useState<CalendarClarification[]>([])
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [clarificationsDismissed, setClarificationsDismissed] = useState(false)
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [selfLinkDismissed, setSelfLinkDismissed] = useState(false)
  const clarificationsFetched = useRef(false)
  const [emailSuggestions, setEmailSuggestions] = useState<EmailSuggestion[]>([])
  const emailFetched = useRef(false)
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

  // Hydrate everything from cache the moment the family id is known, so a
  // returning visit paints a complete page on the first frame.
  useEffect(() => {
    if (!familyId) return
    const r = readCache<AttentionReport>(attnKey)
    if (r) setReport(r)
    const g = readCache<CalendarEvent[]>(gcalKey)
    if (g?.length) setGoogleEvents(g)
    const c = readCache<CalendarClarification[]>(clarKey)
    if (c?.length) setClarifications(c)
    const em = readCache<EmailSuggestion[]>(gmailKey)
    if (em?.length) setEmailSuggestions(em)
    const dism = readCache<string[]>(dismissKey)
    if (dism?.length) setDismissedTitles(new Set(dism))
    setHydrated(true)
  }, [familyId, attnKey, gcalKey, clarKey, gmailKey, dismissKey])

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
  }, [isConnected, gcalKey, familyId])

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
    return {
      members, events, tasks: allTasks, chores, plans, lists, eventContext,
      profile, memories, inbox, tier,
      currentUserEmail: user?.email ?? undefined,
      currentUserName: user?.displayName ?? undefined,
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }, [members, events, tasks, reminders, chores, plans, lists, profile, memories, emailSuggestions, user])

  const runEngine = useCallback(async (overrideContext?: { eventTitle: string; context: string }[], silent?: boolean) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    // Bump the token: this fast run is now the latest, so any in-flight deep pass
    // from a previous run will be ignored when it returns.
    const myToken = ++deepToken.current
    try {
      const eventContext = overrideContext ??
        eventContexts.map((e) => ({ eventTitle: e.eventTitle, context: e.context }))

      // Pass 1 — FAST (Sonnet): paint the briefing quickly.
      const res = await fetch('/api/ai/attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEngineBody(eventContext, 'fast')),
      })
      const data = await res.json() as AttentionReport & { error?: string }
      if (res.ok) {
        setReport(data)
        setEngineError(null)
        writeCache(attnKey, data)

        // Pass 2 — DEEP (Opus): silently sharpen the prioritization and update in
        // place. Not awaited so the fast result shows immediately. Guarded by the
        // token so a stale deep pass never overwrites a newer briefing.
        setDeepening(true)
        ;(async () => {
          try {
            const dRes = await fetch('/api/ai/attention', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildEngineBody(eventContext, 'deep')),
            })
            const dData = await dRes.json() as AttentionReport & { error?: string }
            if (dRes.ok && deepToken.current === myToken) {
              setReport(dData)
              writeCache(attnKey, dData)
            }
          } catch {
            /* deep pass is best-effort — the fast result already stands */
          } finally {
            if (deepToken.current === myToken) setDeepening(false)
          }
        })()
      } else {
        // Surface the error so it's visible instead of silently showing nothing.
        setEngineError(data.error ?? 'Something went wrong. Tap refresh to try again.')
        // Reset the throttle so the engine retries automatically when new data arrives.
        lastRun.current = 0
      }
    } catch {
      setEngineError('Could not reach the server. Check your connection and tap refresh.')
      lastRun.current = 0
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [buildEngineBody, eventContexts, attnKey])

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
    const now = Date.now()
    if (now - lastRun.current < 60000) return
    lastRun.current = now
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
    if (lastCtxSig.current === '') { lastCtxSig.current = ctxSignature; return }
    if (lastCtxSig.current === ctxSignature) return
    lastCtxSig.current = ctxSignature
    lastRun.current = Date.now()
    // Silent if a report exists, cold-start otherwise (so the user sees the loader).
    runEngine(undefined, !!report)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxSignature, hydrated])

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
    const responsibleEmail = responsible?.email

    // 2. Update underlying task/reminder assignee, if this item maps to one.
    if (responsibleEmail) {
      const t = item.sourceId
        ? tasks.find((x) => x.id === item.sourceId)
        : tasks.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (t) await updateTask({ ...t, assigneeEmail: responsibleEmail })
      const r = item.sourceId
        ? reminders.find((x) => x.id === item.sourceId)
        : reminders.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (r) await updateReminder({ ...r, assigneeEmail: responsibleEmail })
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
    // Hide it from view right away — don't wait for the engine to re-run.
    setCompletedTitles((prev) => new Set(prev).add(item.title))
    const now = new Date().toISOString()
    if (item.sourceType === 'task' || (!item.sourceId && item.sourceType !== 'reminder')) {
      const byId = item.sourceId ? tasks.find((x) => x.id === item.sourceId) : undefined
      const t = byId ?? tasks.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (t) { await updateTask({ ...t, isCompleted: true, completedAt: now }); return }
    }
    if (item.sourceType === 'reminder' || item.sourceType === 'inferred') {
      const byId = item.sourceId ? reminders.find((x) => x.id === item.sourceId) : undefined
      const r = byId ?? reminders.find((x) => x.title.toLowerCase() === item.title.toLowerCase())
      if (r) { await updateReminder({ ...r, isCompleted: true, completedAt: now }); return }
    }
    // Last resort: try both collections by title
    const t2 = tasks.find((x) => item.title.toLowerCase().includes(x.title.toLowerCase()) || x.title.toLowerCase().includes(item.title.toLowerCase()))
    if (t2) { await updateTask({ ...t2, isCompleted: true, completedAt: now }); return }
    const r2 = reminders.find((x) => item.title.toLowerCase().includes(x.title.toLowerCase()) || x.title.toLowerCase().includes(item.title.toLowerCase()))
    if (r2) await updateReminder({ ...r2, isCompleted: true, completedAt: now })
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

  function dismissItem(title: string) {
    setDismissedTitles((prev) => {
      const next = new Set(prev).add(title)
      writeCache(dismissKey, Array.from(next))
      return next
    })
    // Surface the teach prompt briefly so they can give feedback
    setTeachPrompt({ title, reason: '' })
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
      <TopProgressBar active={busy || deepening} />

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
          onClick={() => runEngine(undefined, !!report)}
          disabled={busy}
          className="mt-1 p-2.5 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shadow-card disabled:opacity-60"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
        </button>
      </div>

      {!isConnected && <ConnectGooglePrompt onConnect={() => router.push(`/api/auth/google?email=${user?.email ?? ''}`)} />}

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
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium">{report.greeting}</p>
          </div>
          {deepening && (
            <div className="flex items-center gap-1.5 mt-3 text-[11px] text-white/70">
              <span className="w-3 h-3 border-[1.5px] border-white/40 border-t-transparent rounded-full animate-spin" />
              Sharpening priorities…
            </div>
          )}
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
                    <MicButton
                      size={34}
                      onText={(spoken) =>
                        setClarificationAnswers((prev) => ({
                          ...prev,
                          [c.id]: (prev[c.id] ? prev[c.id].trim() + ' ' : '') + spoken,
                        }))
                      }
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
          like the real content so there is no jump when the report arrives. */}
      {loading && !report && (
        <div className="space-y-6 animate-fade-in">
          <div className="skeleton h-20 w-full rounded-2xl" />
          <div className="space-y-3">
            <div className="skeleton h-4 w-24 rounded" />
            <div className="skeleton h-20 w-full rounded-2xl" />
            <div className="skeleton h-20 w-full rounded-2xl" />
          </div>
        </div>
      )}

      {/* Teach prompt — brief inline nudge when an item is dismissed */}
      {teachPrompt && (
        <TeachPrompt
          title={teachPrompt.title}
          onTeach={(feedback) => teachAssistant(teachPrompt.title, feedback)}
          onDismiss={() => setTeachPrompt(null)}
        />
      )}

      {/* NEXT UP */}
      {report && (report.items ?? []).some(
        (i) => !dismissedTitles.has(i.title) && !completedTitles.has(i.title)
      ) && (
        <section>
          <SectionLabel icon={Clock} color="#0f172a">Next Up</SectionLabel>
          <div className="space-y-4">
            {BUCKET_ORDER.map((bucket) => {
              const items = itemsByBucket(bucket).filter(
                (i) => !dismissedTitles.has(i.title) && !completedTitles.has(i.title)
              )
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
                      // Resolve who it's for / who's responsible. A user override
                      // (keyed by member id) wins; otherwise fall back to the AI's
                      // email-based assignment.
                      const ov = assignmentOverrides[item.title]
                      const byEmail = (email?: string) =>
                        email ? members.find((m) => m.email?.toLowerCase() === email.toLowerCase()) : undefined
                      const byId = (id?: string) => members.find((m) => m.id === id)
                      const responsible = ov
                        ? byId(ov.responsibleId)
                        : byEmail(item.assigneeEmail)
                      const forMembers = ov
                        ? (ov.forIds ?? []).map(byId).filter(Boolean) as FamilyMember[]
                        : (item.forEmails ?? []).map(byEmail).filter(Boolean) as FamilyMember[]
                      return (
                        <AttentionCard
                          key={item.id}
                          item={item}
                          accent={meta.color}
                          allMembers={members}
                          responsible={responsible}
                          forMembers={forMembers}
                          onComplete={() => completeTaskFromItem(item)}
                          onDismiss={() => dismissItem(item.title)}
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
              .filter((p) => !dismissedTitles.has(p.title))
              .map((p) => (
                <ProblemCard
                  key={p.id}
                  problem={p}
                  onCapture={(text) => openCapture({ text, autoAnalyze: true })}
                  onCopilot={() => router.push('/copilot')}
                  onCalendar={() => router.push('/calendar')}
                  onDismiss={() => dismissItem(p.title)}
                />
              ))}
          </div>
        </section>
      )}

      {/* COPILOT RECOMMENDATIONS */}
      {report && (report.recommendations?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={Lightbulb} color="#7c3aed">Copilot Recommendations</SectionLabel>
          <div className="space-y-2 stagger-children">
            {report.recommendations
              .filter((r) => !dismissedTitles.has(r.title))
              .map((r) => (
                <div key={r.id} className="rounded-2xl p-4 bg-white shadow-card animate-slide-up flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                    <Lightbulb size={15} className="text-purple-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900">{r.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{r.rationale}</p>
                  </div>
                  <div className="flex items-start gap-1 shrink-0">
                    {r.actionLabel && (
                      <button
                        onClick={() => openCapture({ text: `${r.title}. ${r.rationale}`, autoAnalyze: true })}
                        className="mt-0.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-500 hover:to-purple-600 transition-all"
                      >
                        {r.actionLabel}
                      </button>
                    )}
                    <button
                      onClick={() => dismissItem(r.title)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors"
                      title="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
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
    </div>
  )
}

function ProblemCard({
  problem: p,
  onCapture,
  onCopilot,
  onCalendar,
  onDismiss,
}: {
  problem: PotentialProblem
  onCapture: (text: string) => void
  onCopilot: () => void
  onCalendar: () => void
  onDismiss: () => void
}) {
  const severityBg = p.severity === 'high' ? '#fee2e2' : p.severity === 'medium' ? '#ffedd5' : '#fef9c3'
  const severityColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#ea580c' : '#a16207'
  const borderColor = p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#f97316' : '#eab308'
  const actionText = p.suggestedAction ? `${p.title}. ${p.suggestedAction}` : p.title

  function handleAction() {
    if (p.actionType === 'calendar') { onCalendar(); return }
    if (p.actionType === 'capture') { onCapture(actionText); return }
    onCopilot() // default: open Copilot to discuss / handle it
  }

  return (
    <div
      className="rounded-2xl p-4 bg-white shadow-card animate-slide-up"
      style={{ borderLeft: `3px solid ${borderColor}` }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900">{p.title}</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{p.detail}</p>
          {p.suggestedAction && (
            <button
              onClick={handleAction}
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 mt-2 font-medium group"
            >
              <MessageCircle size={11} className="shrink-0" />
              {p.suggestedAction}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full"
            style={{ background: severityBg, color: severityColor }}
          >
            {p.severity}
          </span>
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
  item, accent, allMembers, responsible, forMembers, onComplete, onDismiss, onAddContext, onAssign,
}: {
  item: AttentionItem
  accent: string
  allMembers: FamilyMember[]
  responsible?: FamilyMember
  forMembers: FamilyMember[]
  onComplete: () => void
  onDismiss: () => void
  onAddContext: (context: string) => void
  onAssign: (forIds: string[], responsibleId?: string) => void
}) {
  const [done, setDone] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [contextDraft, setContextDraft] = useState('')
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
        {(item.sourceType === 'task' || item.sourceType === 'reminder') && (
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
            onClick={onDismiss}
            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-colors"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {assigning && (
        <AssignPanel
          allMembers={allMembers}
          initialFor={forMembers.map((m) => m.id)}
          initialResponsible={responsible?.id}
          onCancel={() => setAssigning(false)}
          onSave={(f, r) => { onAssign(f, r); setAssigning(false) }}
        />
      )}

      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-50 pt-3">
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
            <MicButton
              size={34}
              onText={(spoken) => setContextDraft((p) => (p ? p.trim() + ' ' : '') + spoken)}
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
