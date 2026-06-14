// Serializes family data into a compact, AI-readable context block.
// Shared by the Attention Engine, Copilot, and Extraction Engine.

import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
} from '@/lib/types'

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
  // Who is signed in / asking right now, so the AI can address them as "you".
  currentUserEmail?: string
  currentUserName?: string
}

// Format a date/time in the user's local timezone for the AI.
function fmtDatetime(iso: string, tz?: string): string {
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
  try {
    return new Date(iso).toLocaleDateString('en-US', {
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

function fmtMember(m: FamilyMember, currentUserEmail?: string): string {
  const isYou = !!currentUserEmail && m.email?.toLowerCase() === currentUserEmail.toLowerCase()
  const youTag = isYou ? ' ← THIS IS THE SIGNED-IN USER (address as "you")' : ''
  const parts = [`- ${m.name} (${m.role}${m.email ? `, ${m.email}` : ''})${youTag}`]
  if (m.summary) parts.push(`  summary: ${m.summary}`)
  if (m.routines?.length) parts.push(`  routines: ${m.routines.map((r) => `${r.title} [${r.schedule}]`).join('; ')}`)
  if (m.preferences?.length) parts.push(`  prefs: ${m.preferences.map((p) => p.text).join('; ')}`)
  if (m.importantInfo?.length) parts.push(`  info: ${m.importantInfo.map((i) => `${i.label}=${i.value}`).join('; ')}`)
  return parts.join('\n')
}

export function buildFamilyContext(input: FamilyContextInput): string {
  const { members, events, tasks, chores, plans, lists, now, timezone, eventContext, currentUserEmail, currentUserName } = input
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

  const sections: string[] = []

  const nowFormatted = fmtDatetime(now, tz)
  sections.push(`CURRENT TIME: ${nowFormatted}${tz ? ` (timezone: ${tz})` : ''}`)

  const matchedSelf = currentUserEmail
    ? members.find((m) => m.email?.toLowerCase() === currentUserEmail.toLowerCase())
    : undefined
  const selfDescriptor = matchedSelf
    ? `${matchedSelf.name} (${currentUserEmail})`
    : currentUserName || currentUserEmail
      ? `${currentUserName ?? ''}${currentUserEmail ? ` <${currentUserEmail}>` : ''} — NOTE: this person is not yet matched to a family member profile`
      : 'unknown'
  sections.push(`SIGNED-IN USER (the person you are talking to right now — address them as "you"): ${selfDescriptor}`)

  sections.push(
    `FAMILY MEMBERS:\n${members.length ? members.map((m) => fmtMember(m, currentUserEmail)).join('\n') : '(none yet)'}`
  )

  sections.push(
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

  sections.push(
    `OPEN TASKS / RESPONSIBILITIES:\n${
      openTasks.length
        ? openTasks
            .map(
              (t) =>
                `- ${t.title}${t.dueDate ? ` (due ${fmtDate(t.dueDate, tz)})` : ''}${
                  t.assigneeEmail ? ` [${t.assigneeEmail}]` : ''
                } priority=${t.priority}`
            )
            .join('\n')
        : '(none)'
    }`
  )

  if (chores?.length) {
    sections.push(
      `CHORES:\n${chores
        .map(
          (c) =>
            `- ${c.name} [${c.assigneeEmail || 'unassigned'}] every ${c.recurrence.interval} ${c.recurrence.frequency}, streak ${c.streak}, last done ${c.lastCompletedDate ?? 'never'}`
        )
        .join('\n')}`
    )
  }

  if (plans?.length) {
    sections.push(
      `ACTIVE PLANS:\n${plans
        .map((p) => {
          const openTaskCount = p.tasks.filter((t) => !t.isCompleted).length
          return `- ${p.title} (${p.kind})${p.targetDate ? ` target ${fmtDate(p.targetDate, tz)}` : ''} — ${openTaskCount} open tasks, readiness ${p.readiness ?? '?'}%`
        })
        .join('\n')}`
    )
  }

  if (lists?.length) {
    sections.push(
      `LISTS:\n${lists
        .map((l) => {
          const remaining = l.items.filter((i) => !i.isComplete).length
          return `- ${l.name} (${l.kind}): ${remaining} items remaining`
        })
        .join('\n')}`
    )
  }

  if (eventContext?.length) {
    sections.push(
      `USER-PROVIDED CALENDAR CONTEXT (the family explained these otherwise-ambiguous events — rely on this to understand what they are, who they're for, and what prep they need):\n${eventContext
        .map((e) => `- "${e.eventTitle}": ${e.context}`)
        .join('\n')}`
    )
  }

  return sections.join('\n\n')
}
