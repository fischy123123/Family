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
  // User-provided clarifications for ambiguous calendar events, keyed loosely
  // by event title. Captured from the Command Center "help me understand your
  // calendar" prompt.
  eventContext?: { eventTitle: string; context: string }[]
}

function fmtMember(m: FamilyMember): string {
  const parts = [`- ${m.name} (${m.role}${m.email ? `, ${m.email}` : ''})`]
  if (m.summary) parts.push(`  summary: ${m.summary}`)
  if (m.routines?.length) parts.push(`  routines: ${m.routines.map((r) => `${r.title} [${r.schedule}]`).join('; ')}`)
  if (m.preferences?.length) parts.push(`  prefs: ${m.preferences.map((p) => p.text).join('; ')}`)
  if (m.importantInfo?.length) parts.push(`  info: ${m.importantInfo.map((i) => `${i.label}=${i.value}`).join('; ')}`)
  return parts.join('\n')
}

export function buildFamilyContext(input: FamilyContextInput): string {
  const { members, events, tasks, chores, plans, lists, now, eventContext } = input
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

  sections.push(`CURRENT TIME: ${nowDate.toString()}`)

  sections.push(
    `FAMILY MEMBERS:\n${members.length ? members.map(fmtMember).join('\n') : '(none yet)'}`
  )

  sections.push(
    `UPCOMING EVENTS (next 14 days):\n${
      upcomingEvents.length
        ? upcomingEvents
            .map(
              (e) =>
                `- ${e.title} | ${e.isAllDay ? 'all-day ' : ''}${new Date(e.start).toString()}${
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
                `- ${t.title}${t.dueDate ? ` (due ${new Date(t.dueDate).toDateString()})` : ''}${
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
          return `- ${p.title} (${p.kind})${p.targetDate ? ` target ${new Date(p.targetDate).toDateString()}` : ''} — ${openTaskCount} open tasks, readiness ${p.readiness ?? '?'}%`
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
