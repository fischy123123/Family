// Serializes family data into a compact, AI-readable context block.
// Shared by the Attention Engine, Copilot, and Extraction Engine.

import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory,
} from '@/lib/types'
import { resolveAssignee } from '@/lib/members'

// One actionable item the assistant noticed in the family's inbox. Folded into
// the same reasoning as everything else — never shown as a separate silo.
export interface InboxSignal {
  title: string
  date?: string | null
  notes?: string
  sourceEmailSubject?: string
  messageId?: string
}

export interface FamilyContextInput {
  members: FamilyMember[]
  events: CalendarEvent[]
  tasks: Task[]
  chores: Chore[]
  plans: Plan[]
  lists: SmartList[]
  now: string // ISO datetime
  timezone?: string // IANA timezone e.g. "America/Los_Angeles"
  // User-provided clarifications for ambiguous calendar events, keyed loosely
  // by event title. Captured from the Command Center "help me understand your
  // calendar" prompt.
  eventContext?: { eventTitle: string; context: string }[]
  // The "lens" — household identity and what this family cares about.
  profile?: FamilyProfile | null
  // Durable facts the assistant has learned and should reason through.
  memories?: FamilyMemory[]
  // Actionable signals pulled from the family's email inbox.
  inbox?: InboxSignal[]
  // Who is signed in / asking right now, so the AI can address them as "you".
  currentUserEmail?: string
  currentUserName?: string
}

// Date-only strings ("YYYY-MM-DD") carry no time or zone. Parsing one with
// `new Date()` yields UTC midnight, which any timezone behind UTC (e.g. Pacific)
// then renders as the PREVIOUS calendar day — the classic off-by-one. Detect
// these and render the literal calendar parts with NO timezone conversion.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// Format a date/time in the user's local timezone for the AI.
function fmtDatetime(iso: string, tz?: string): string {
  // All-day / date-only values have no time component — render as a plain date
  // so we never shift the day or invent a spurious time.
  if (DATE_ONLY_RE.test(iso.trim())) return fmtDate(iso, tz)
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })
  } catch {
    return new Date(iso).toISOString()
  }
}

function fmtDate(iso: string, tz?: string): string {
  const trimmed = iso.trim()
  // Date-only: pin to UTC so the calendar parts render exactly as written,
  // regardless of the server's runtime timezone (the server runs in UTC).
  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }
  try {
    return new Date(trimmed).toLocaleDateString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return new Date(iso).toDateString()
  }
}

// Onboarding historically saved routines/importantInfo as free-text strings,
// while the structured editors save arrays. Render either shape gracefully.
function flattenRoutines(v: FamilyMember['routines']): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.map((r) => `${r.title} [${r.schedule}]`).join('; ')
}
function flattenPrefs(v: FamilyMember['preferences']): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.map((p) => p.text).join('; ')
}
function flattenInfo(v: FamilyMember['importantInfo']): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.map((i) => `${i.label}=${i.value}`).join('; ')
}

function fmtMember(m: FamilyMember, currentUserEmail?: string): string {
  const isYou = !!currentUserEmail && m.email?.toLowerCase() === currentUserEmail.toLowerCase()
  const youTag = isYou ? ' ← THIS IS THE SIGNED-IN USER (address as "you")' : ''
  const parts = [`- ${m.name} (${m.role}${m.email ? `, ${m.email}` : ''})${youTag}`]
  if (m.summary) parts.push(`  summary: ${m.summary}`)
  const routines = flattenRoutines(m.routines)
  if (routines) parts.push(`  routines: ${routines}`)
  const prefs = flattenPrefs(m.preferences)
  if (prefs) parts.push(`  prefs: ${prefs}`)
  const info = flattenInfo(m.importantInfo)
  if (info) parts.push(`  info: ${info}`)
  return parts.join('\n')
}

function fmtProfile(p: FamilyProfile): string {
  const parts: string[] = []
  if (p.household) parts.push(`Who they are: ${p.household}`)
  if (p.priorities?.length) parts.push(`What matters most: ${p.priorities.join('; ')}`)
  if (p.concerns?.length) parts.push(`Watch out for / stressors: ${p.concerns.join('; ')}`)
  if (p.communicationStyle) parts.push(`Preferred tone: ${p.communicationStyle}`)
  if (p.quietHours) parts.push(`Quiet hours (don't surface non-urgent things then): ${p.quietHours}`)
  return parts.join('\n')
}

export function buildFamilyContext(input: FamilyContextInput): string {
  const { timeHeader, dataBlock } = buildFamilyContextParts(input)
  return `${timeHeader}\n\n${dataBlock}`
}

// Split into a time-dynamic header (changes every run) and a mostly-static data
// block (members, events, tasks, etc.). The data block can be prompt-cached so
// only the small time header incurs full token cost on repeat calls.
export function buildFamilyContextParts(input: FamilyContextInput): {
  timeHeader: string
  dataBlock: string
} {
  const {
    members, events, tasks, chores, plans, lists, now, timezone, eventContext,
    profile, memories, inbox, currentUserEmail, currentUserName,
  } = input
  const tz = timezone || undefined
  const nowDate = new Date(now)
  const horizon = new Date(nowDate.getTime() + 14 * 24 * 60 * 60 * 1000)

  const upcomingEvents = (events ?? [])
    .filter((e) => {
      const s = new Date(e.start)
      return s >= new Date(nowDate.getTime() - 12 * 60 * 60 * 1000) && s <= horizon
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 40)

  const openTasks = (tasks ?? []).filter((t) => !t.isCompleted).slice(0, 40)

  // ── Time header (dynamic — changes every run, excluded from cache) ────────
  const nowFormatted = fmtDatetime(now, tz)
  const localDateStr = new Date(now).toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const timeHeader =
    `CURRENT TIME: ${nowFormatted}${tz ? ` (timezone: ${tz})` : ''}\n` +
    `TODAY'S LOCAL DATE: ${localDateStr} — use this as the anchor for all relative date reasoning. ` +
    `"Tomorrow" means the calendar day AFTER this date in the user's timezone, not the next UTC day.`

  // ── Data block (mostly static — eligible for prompt caching) ────────────
  const dataSections: string[] = []

  const matchedSelf = currentUserEmail
    ? members.find((m) => m.email?.toLowerCase() === currentUserEmail.toLowerCase())
    : undefined
  const selfDescriptor = matchedSelf
    ? `${matchedSelf.name} (${currentUserEmail})`
    : currentUserName || currentUserEmail
      ? `${currentUserName ?? ''}${currentUserEmail ? ` <${currentUserEmail}>` : ''} — NOTE: this person is not yet matched to a family member profile`
      : 'unknown'
  dataSections.push(`SIGNED-IN USER (the person you are talking to right now — address them as "you"): ${selfDescriptor}`)

  // Split memories: family-wide vs personal to the current user.
  // Privacy only matters between ADULTS who each have their own login — one
  // parent's private notes shouldn't leak into the other parent's briefing.
  // A memory about a CHILD (or a member with no login) is household logistics
  // everyone needs: a parent must see their kid's grounding, allergy, schedule,
  // etc. Previously any subjectEmail hid the memory from everyone but that
  // subject, so a correction tagged to a child was invisible to the parents.
  const memberByEmail = (email?: string) =>
    email ? members.find((m) => m.email?.toLowerCase() === email.toLowerCase()) : undefined
  const viewer = (currentUserEmail ?? '').toLowerCase()
  const isPrivateToOtherAdult = (m: FamilyMemory) => {
    if (!m.subjectEmail) return false
    const subj = memberByEmail(m.subjectEmail)
    if (subj?.role !== 'parent') return false // children/other → household-wide
    return m.subjectEmail.toLowerCase() !== viewer
  }
  const familyMemories = (memories ?? []).filter(
    (m) => !isPrivateToOtherAdult(m) && m.subjectEmail?.toLowerCase() !== viewer
  )
  const personalMemories = (memories ?? []).filter(
    (m) => m.subjectEmail && m.subjectEmail.toLowerCase() === viewer
  )

  // The personal lens: what this individual has told us they care about (or
  // don't care about). Combine their member preferences + personal memories.
  // This is the HIGHEST priority filter — the AI personalises the briefing
  // through it, without any hardcoded rules.
  const personalPrefs = matchedSelf ? flattenPrefs(matchedSelf?.preferences) : ''
  const hasPersonalLens = personalPrefs || personalMemories.length > 0
  if (hasPersonalLens) {
    const lensLines: string[] = []
    if (personalPrefs) lensLines.push(`Stated preferences: ${personalPrefs}`)
    if (personalMemories.length) {
      const sorted = [...personalMemories].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }).slice(0, 30)
      lensLines.push(
        `What I have learned about this person specifically:\n${sorted
          .map((m) => `  - ${m.category ? `[${m.category}] ` : ''}${m.text}`)
          .join('\n')}`
      )
    }
    dataSections.push(
      `PERSONAL LENS FOR ${matchedSelf?.name ?? 'THE SIGNED-IN USER'} ` +
      `(READ THIS FIRST — apply it as the primary filter on what you surface in this briefing. ` +
      `Do not show them things that contradict their stated preferences or that they have ` +
      `previously indicated they don't want to see. No hardcoded rules — use your judgment ` +
      `about what this person would actually want to know):\n${lensLines.join('\n')}`
    )
  }

  if (profile) {
    const profileText = fmtProfile(profile)
    if (profileText) {
      dataSections.push(
        `HOUSEHOLD PROFILE (secondary lens — shared family priorities. Apply after the personal lens above):\n${profileText}`
      )
    }
  }

  dataSections.push(
    `FAMILY MEMBERS:\n${members.length ? members.map((m) => fmtMember(m, currentUserEmail)).join('\n') : '(none yet)'}`
  )

  if (familyMemories.length) {
    const ordered = [...familyMemories].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    }).slice(0, 60)
    dataSections.push(
      `WHAT YOU KNOW ABOUT THIS FAMILY (shared durable memory — facts, routines, preferences that apply to everyone):\n${ordered
        .map((m) => {
          const who = m.subjectEmail ? ` (about ${m.subjectEmail})` : ''
          const cat = m.category ? `[${m.category}] ` : ''
          return `- ${cat}${m.text}${who}`
        })
        .join('\n')}`
    )
  }

  dataSections.push(
    `UPCOMING EVENTS (next 14 days):\n${
      upcomingEvents.length
        ? upcomingEvents
            .map(
              (e) =>
                `- ${e.title} | ${e.isAllDay ? 'all-day ' : ''}${fmtDatetime(e.start, tz)}${
                  e.location ? ` @ ${e.location}` : ''
                }${e.ownerEmail ? ` (${e.ownerEmail})` : ''}`
            )
            .join('\n')
        : '(none)'
    }`
  )

  dataSections.push(
    `OPEN TASKS / RESPONSIBILITIES:\n${
      openTasks.length
        ? openTasks
            .map(
              (t) => {
                const who = resolveAssignee(members, t)?.name ?? t.assigneeEmail
                return `- [id:${t.id}] ${t.title}${t.dueDate ? ` (due ${fmtDate(t.dueDate, tz)})` : ''}${
                  who ? ` [${who}]` : ''
                } priority=${t.priority}`
              }
            )
            .join('\n')
        : '(none)'
    }`
  )

  if (chores?.length) {
    dataSections.push(
      `CHORES:\n${chores
        .map(
          (c) =>
            `- ${c.name} [${resolveAssignee(members, c)?.name || c.assigneeEmail || 'unassigned'}] every ${c.recurrence.interval} ${c.recurrence.frequency}, streak ${c.streak}, last done ${c.lastCompletedDate ?? 'never'}`
        )
        .join('\n')}`
    )
  }

  if (plans?.length) {
    dataSections.push(
      `ACTIVE PLANS:\n${plans
        .map((p) => {
          const openTaskCount = p.tasks.filter((t) => !t.isCompleted).length
          return `- ${p.title} (${p.kind})${p.targetDate ? ` target ${fmtDate(p.targetDate, tz)}` : ''} — ${openTaskCount} open tasks, readiness ${p.readiness ?? '?'}%`
        })
        .join('\n')}`
    )
  }

  if (lists?.length) {
    dataSections.push(
      `LISTS:\n${lists
        .map((l) => {
          const remaining = l.items.filter((i) => !i.isComplete).length
          return `- ${l.name} (${l.kind}): ${remaining} items remaining`
        })
        .join('\n')}`
    )
  }

  // Filter out inbox signals with dates that have already passed — stale
  // appointment reminders are noise that confuse the attention engine.
  const todayStr = nowDate.toISOString().split('T')[0]
  const freshInbox = (inbox ?? []).filter((s) => !s.date || s.date >= todayStr)

  if (freshInbox.length > 0) {
    dataSections.push(
      `FROM THE INBOX (actionable items the assistant found in the family's email — treat these as RAW SIGNALS, not facts. Fold the genuinely relevant ones into your briefing the same way you would a calendar event or task; decide what's worth surfacing and what's noise. Do NOT list these separately or tell the user to "check their inbox" — just inform them of what matters):\n${freshInbox
        .map((s) => {
          const when = s.date ? ` — ${fmtDate(s.date, tz)}` : ''
          const note = s.notes ? ` (${s.notes})` : ''
          const src = s.sourceEmailSubject ? ` [email: "${s.sourceEmailSubject}"]` : ''
          const mid = s.messageId ? ` [msgid:${s.messageId}]` : ''
          return `- ${s.title}${when}${note}${src}${mid}`
        })
        .join('\n')}`
    )
  }


  if (eventContext?.length) {
    dataSections.push(
      `USER-PROVIDED CALENDAR CONTEXT (the family explained these otherwise-ambiguous events — rely on this to understand what they are, who they're for, and what prep they need):\n${eventContext
        .map((e) => `- "${e.eventTitle}": ${e.context}`)
        .join('\n')}`
    )
  }

  return { timeHeader, dataBlock: dataSections.join('\n\n') }
}
