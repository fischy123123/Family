// Serializes family data into a compact, AI-readable context block.
// Shared by the Attention Engine, Copilot, and Extraction Engine.

import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory,
} from '@/lib/types'
import { memorySubjects, memoryConcernsMember } from '@/lib/types'
import { resolveAssignee, memberById } from '@/lib/members'

// One actionable item the assistant noticed in the family's inbox. Folded into
// the same reasoning as everything else — never shown as a separate silo.
export interface InboxSignal {
  title: string
  date?: string | null
  notes?: string
  sourceEmailSubject?: string
  messageId?: string
  // Names of the family members this item is specifically about or for.
  // Populated by the Gmail extraction model when a name is clearly identifiable.
  forNames?: string[]
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

// Compact "noted Jun 5" date stamp for a memory, so the AI can judge how stale
// any relative time reference ("this week", "next Tuesday") inside it might be.
function notedOn(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })
  } catch {
    return ''
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
  // Profile notes (MemoryEntry[]) written directly on this member's profile
  if (m.memories?.length) {
    parts.push(`  notes: ${m.memories.slice(0, 5).map((n) => n.text).join('; ')}`)
  }
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

// ── Tunable context limits ────────────────────────────────────────────────
// These govern how much of the family's data reaches the model. Raising them
// gives richer context (more lookahead, more history) at the cost of more input
// tokens → higher per-call cost, slower processing, and a bigger cache-write on
// cold starts. The [ctx/breakdown] log (especially the horizon histogram) shows
// exactly what each increment would add before you change anything.
const HORIZON_DAYS = 14          // how far into the future events are included
const PAST_WINDOW_HOURS = 12     // how far back events are kept (catch ongoing/just-passed)
const EVENT_CAP = 40             // max events sent to the model
const TASK_CAP = 40              // max open tasks sent to the model
const FAMILY_MEMORY_CAP = 60     // max shared memories sent
const PERSONAL_MEMORY_CAP = 30   // max personal memories sent
// Buckets (days from now) for the horizon histogram — shows how many events
// would be added by extending HORIZON_DAYS to each value.
const HORIZON_BUCKETS = [1, 3, 7, 14, 30, 60, 90, 180, 365]

// Rough token estimate from character count (~3.7 chars/token for English prose
// with JSON/structure). Good enough to reason about prompt cost in logs.
const estTokens = (chars: number) => Math.round(chars / 3.7)

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
  const horizon = new Date(nowDate.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)
  const pastCutoff = new Date(nowDate.getTime() - PAST_WINDOW_HOURS * 60 * 60 * 1000)

  const eventsInWindow = (events ?? [])
    .filter((e) => {
      const s = new Date(e.start)
      return s >= pastCutoff && s <= horizon
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  const upcomingEvents = eventsInWindow.slice(0, EVENT_CAP)

  const openTasksAll = (tasks ?? []).filter((t) => !t.isCompleted)
  const openTasks = openTasksAll.slice(0, TASK_CAP)

  // ── STAGE 1: EVENT FILTERING ─────────────────────────────────────────────
  // Trace each event through the pipeline so we know exactly why anything is
  // dropped before the model ever sees it.
  const allEvents = events ?? []
  const endedEvents = allEvents.filter((e) => new Date(e.start) < pastCutoff)
  const beyondHorizon = allEvents.filter((e) => new Date(e.start) > horizon)
  console.log(
    `[ctx/events] raw=${allEvents.length}` +
    ` → dropped_ended=${endedEvents.length} (start < ${PAST_WINDOW_HOURS}h ago)` +
    ` dropped_beyond_horizon=${beyondHorizon.length} (start > ${HORIZON_DAYS}d out)` +
    ` → in_window=${eventsInWindow.length}` +
    ` → dropped_over_cap=${Math.max(0, eventsInWindow.length - upcomingEvents.length)} (cap=${EVENT_CAP})` +
    ` → SENT=${upcomingEvents.length}`
  )

  // ── HORIZON HISTOGRAM ────────────────────────────────────────────────────
  // How many events fall within each future window. This is the key signal for
  // deciding whether to extend HORIZON_DAYS: it shows what additional context a
  // longer horizon would capture (and therefore what it would cost in tokens).
  const futureEvents = allEvents.filter((e) => new Date(e.start) >= nowDate)
  const histogram = HORIZON_BUCKETS.map((days) => {
    const edge = new Date(nowDate.getTime() + days * 24 * 60 * 60 * 1000)
    const count = futureEvents.filter((e) => new Date(e.start) <= edge).length
    const marker = days === HORIZON_DAYS ? '*' : ''
    return `${days}d${marker}=${count}`
  }).join(' ')
  console.log(
    `[ctx/horizon] cumulative events within N days (*=current horizon): ${histogram}` +
    ` | total_future=${futureEvents.length}`
  )

  // ── STAGE 2: TASK FILTERING ──────────────────────────────────────────────
  console.log(
    `[ctx/tasks] raw=${tasks?.length ?? 0}` +
    ` → dropped_completed=${(tasks?.length ?? 0) - openTasksAll.length}` +
    ` → open=${openTasksAll.length}` +
    ` → dropped_over_cap=${Math.max(0, openTasksAll.length - openTasks.length)} (cap=${TASK_CAP})` +
    ` → SENT=${openTasks.length}`
  )

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
    `"Tomorrow" means the calendar day AFTER this date in the user's timezone, not the next UTC day.\n` +
    `MEMORY TIME RULES (critical):\n` +
    `- A memory describing a ROUTINE or HABIT (e.g. "trains Mon/Wed/Fri", "trash goes out Tuesdays") is NOT evidence ` +
    `that the activity is happening today. NEVER create a "now"/"next"/"later" timed item from a recurring pattern. ` +
    `Only a confirmed entry in UPCOMING EVENTS (the calendar) proves a specific occurrence is happening on a specific day. ` +
    `If a routine "usually" falls today but it is not on the calendar, do not assert it is happening — at most, gently note it as a possibility.\n` +
    `- Each memory shows when it was "noted". Treat relative time words inside a memory ("this week", "next Tuesday", ` +
    `"in 10 days", "tomorrow") as relative to its noted date, NOT to today. Such references are very likely STALE — ` +
    `do not surface them as current facts. Prefer the calendar and absolute dates for anything time-sensitive.`

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
  const memberByIdent = (ident: string) => {
    const v = ident.toLowerCase()
    return members.find((m) => m.email?.toLowerCase() === v || m.id.toLowerCase() === v)
  }
  const viewer = (currentUserEmail ?? '').toLowerCase()
  const viewerMember = viewer ? members.find((m) => m.email?.toLowerCase() === viewer) : undefined
  // A memory is private to another adult only if EVERY subject it concerns is an
  // adult with their own login and none of them is the viewer. Memories about a
  // child (or shared with the viewer) stay household-visible.
  const isPrivateToOtherAdult = (m: FamilyMemory) => {
    const subjects = memorySubjects(m)
    if (!subjects.length) return false
    const concernsViewer = memoryConcernsMember(m, currentUserEmail, viewerMember?.id)
    if (concernsViewer) return false
    // Private only if all subjects are parents (adults with logins)
    return subjects.every((s) => memberByIdent(s)?.role === 'parent')
  }
  const concernsViewer = (m: FamilyMemory) =>
    memoryConcernsMember(m, currentUserEmail, viewerMember?.id)
  const familyMemories = (memories ?? []).filter(
    (m) => !isPrivateToOtherAdult(m) && !concernsViewer(m)
  )
  const personalMemories = (memories ?? []).filter((m) => concernsViewer(m))

  // ── STAGE 3: MEMORY FILTERING ────────────────────────────────────────────
  // Memories split three ways: family-wide (everyone sees), personal (only the
  // viewer, folded into their lens), and private-to-another-adult (hidden from
  // this viewer entirely). Each visible bucket is then capped.
  const hiddenPrivate = (memories ?? []).filter(isPrivateToOtherAdult).length
  console.log(
    `[ctx/memories] raw=${memories?.length ?? 0}` +
    ` → hidden_private_to_other_adult=${hiddenPrivate}` +
    ` | family: have=${familyMemories.length} sent=${Math.min(familyMemories.length, FAMILY_MEMORY_CAP)}` +
    ` dropped_over_cap=${Math.max(0, familyMemories.length - FAMILY_MEMORY_CAP)} (cap=${FAMILY_MEMORY_CAP})` +
    ` | personal: have=${personalMemories.length} sent=${Math.min(personalMemories.length, PERSONAL_MEMORY_CAP)}` +
    ` dropped_over_cap=${Math.max(0, personalMemories.length - PERSONAL_MEMORY_CAP)} (cap=${PERSONAL_MEMORY_CAP})`
  )

  // The personal lens: everything this individual has told us about themselves.
  // Preferences, routines, important info, and personal memories all go here.
  // This is the HIGHEST priority filter — the AI personalises the briefing
  // through it, without any hardcoded rules.
  const personalPrefs = matchedSelf ? flattenPrefs(matchedSelf?.preferences) : ''
  const personalRoutines = matchedSelf ? flattenRoutines(matchedSelf?.routines) : ''
  const personalInfo = matchedSelf ? flattenInfo(matchedSelf?.importantInfo) : ''
  const profileNotes = matchedSelf?.memories ?? []
  const hasPersonalLens = personalPrefs || personalRoutines || personalInfo
    || profileNotes.length > 0 || personalMemories.length > 0
  if (hasPersonalLens) {
    const lensLines: string[] = []
    if (personalPrefs) lensLines.push(`Stated preferences: ${personalPrefs}`)
    if (personalRoutines) lensLines.push(`Their routines: ${personalRoutines}`)
    if (personalInfo) lensLines.push(`Important info about them: ${personalInfo}`)
    if (profileNotes.length) {
      lensLines.push(
        `Profile notes (things they've written about themselves):\n${profileNotes
          .slice(0, 10)
          .map((n) => `  - ${n.text}`)
          .join('\n')}`
      )
    }
    if (personalMemories.length) {
      const sorted = [...personalMemories].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }).slice(0, PERSONAL_MEMORY_CAP)
      lensLines.push(
        `What I have learned about this person:\n${sorted
          .map((m) => `  - ${m.category ? `[${m.category}] ` : ''}${m.text} (noted ${notedOn(m.createdAt, tz)})`)
          .join('\n')}`
      )
    }
    dataSections.push(
      `PERSONAL LENS FOR ${matchedSelf?.name ?? 'THE SIGNED-IN USER'} ` +
      `(READ THIS FIRST — highest-priority context. Use this to personalise every part of the briefing: ` +
      `what to surface, how to frame it, what to skip. Their routines, preferences, and important info ` +
      `here are facts you already know — never ask them to repeat things listed here. ` +
      `No hardcoded rules — use your judgment about what this specific person would want to know):\n${lensLines.join('\n')}`
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
    }).slice(0, FAMILY_MEMORY_CAP)
    dataSections.push(
      `WHAT YOU KNOW ABOUT THIS FAMILY (shared durable memory — facts, routines, preferences that apply to everyone):\n${ordered
        .map((m) => {
          const subs = memorySubjects(m)
            .map((s) => memberByIdent(s)?.name ?? s)
          const who = subs.length ? ` (about ${subs.join(', ')})` : ''
          const cat = m.category ? `[${m.category}] ` : ''
          return `- ${cat}${m.text}${who} (noted ${notedOn(m.createdAt, tz)})`
        })
        .join('\n')}`
    )
  }

  dataSections.push(
    `UPCOMING EVENTS (next 14 days):\n${
      upcomingEvents.length
        ? upcomingEvents
            .map((e) => {
              const forNames = (e.forIds ?? [])
                .map((id) => memberById(members, id)?.name)
                .filter((n): n is string => Boolean(n))
              const forStr = forNames.length ? ` [for: ${forNames.join(', ')}]` : ''
              const respName = e.assigneeId ? memberById(members, e.assigneeId)?.name : undefined
              const respStr = respName ? ` [responsible: ${respName}]` : ''
              return `- [id:${e.id}] ${e.title} | ${e.isAllDay ? 'all-day ' : ''}${fmtDatetime(e.start, tz)}${
                e.location ? ` @ ${e.location}` : ''
              }${e.ownerEmail ? ` (${e.ownerEmail})` : ''}${forStr}${respStr}`
            })
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
                const forNames = (t.forIds ?? [])
                  .map((id) => memberById(members, id)?.name)
                  .filter((n): n is string => Boolean(n))
                const forStr = forNames.length ? ` [for: ${forNames.join(', ')}]` : ''
                const notesStr = t.notes ? ` | notes: ${t.notes.slice(0, 200)}` : ''
                return `- [id:${t.id}] ${t.title}${t.dueDate ? ` (due ${fmtDate(t.dueDate, tz)})` : ''}${
                  who ? ` [assigned: ${who}]` : ''
                }${forStr} priority=${t.priority}${notesStr}`
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

  // ── STAGE 4: INBOX FILTERING ─────────────────────────────────────────────
  console.log(
    `[ctx/inbox] raw=${inbox?.length ?? 0}` +
    ` → dropped_stale=${(inbox?.length ?? 0) - freshInbox.length} (date < today)` +
    ` → SENT=${freshInbox.length}`
  )

  if (freshInbox.length > 0) {
    dataSections.push(
      `FROM THE INBOX (actionable items the assistant found in the family's email — treat these as RAW SIGNALS, not facts. Fold the genuinely relevant ones into your briefing the same way you would a calendar event or task; decide what's worth surfacing and what's noise. Do NOT list these separately or tell the user to "check their inbox" — just inform them of what matters):\n${freshInbox
        .map((s) => {
          const when = s.date ? ` — ${fmtDate(s.date, tz)}` : ''
          const note = s.notes ? ` (${s.notes})` : ''
          const forWho = s.forNames?.length ? ` [for: ${s.forNames.join(', ')}]` : ''
          const src = s.sourceEmailSubject ? ` [email: "${s.sourceEmailSubject}"]` : ''
          const mid = s.messageId ? ` [msgid:${s.messageId}]` : ''
          return `- ${s.title}${when}${note}${forWho}${src}${mid}`
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

  const dataBlock = dataSections.join('\n\n')

  // ── STAGE 5: PROMPT SIZE BY SECTION ──────────────────────────────────────
  // Which sections dominate the prompt. Each line: <section header>=<chars>
  // (~<tokens>t). The header is the first words of each section so you can map
  // cost back to content (e.g. if WHAT YOU KNOW ABOUT THIS FAMILY is huge, the
  // memory cap is the lever; if UPCOMING EVENTS dominates, the horizon is).
  const sectionSizes = dataSections
    .map((s) => {
      const header = s.split('\n')[0].replace(/\s*\(.*$/, '').slice(0, 32).trim()
      return `${header}=${s.length}c(~${estTokens(s.length)}t)`
    })
    .join(' | ')
  console.log(`[ctx/sections] ${sectionSizes}`)
  console.log(
    `[ctx/total] data_block=${dataBlock.length}c(~${estTokens(dataBlock.length)}t)` +
    ` time_header=${timeHeader.length}c(~${estTokens(timeHeader.length)}t)` +
    ` GRAND_TOTAL=${dataBlock.length + timeHeader.length}c(~${estTokens(dataBlock.length + timeHeader.length)}t)`
  )

  return { timeHeader, dataBlock }
}
