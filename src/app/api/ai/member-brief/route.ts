import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { FamilyMember, Task, Chore, FamilyMemory, FamilyProfile, CalendarEvent } from '@/lib/types'
import { logUsage } from '@/lib/ai'
import { memoryConcernsMember } from '@/lib/types'

const MODEL = 'claude-sonnet-4-6'

interface MemberBriefRequest {
  member: FamilyMember
  viewerEmail: string
  tasks: Task[]
  chores: Chore[]
  memories: FamilyMemory[]
  events: CalendarEvent[]
  profile: FamilyProfile | null
  now: string
  timezone?: string
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

// Strict match: both id AND email must be explicitly set and match — never
// match when either side is undefined (avoids undefined === undefined).
function matchesMember(member: FamilyMember, assigneeId?: string, assigneeEmail?: string): boolean {
  if (member.id && assigneeId && assigneeId === member.id) return true
  if (member.email && assigneeEmail && assigneeEmail.toLowerCase() === member.email.toLowerCase()) return true
  return false
}

function buildMemberContext(req: MemberBriefRequest): string {
  const { member, tasks, chores, memories, events, now } = req
  const lines: string[] = []

  if (member.summary) lines.push(`Summary: ${member.summary}`)
  if (member.birthday) lines.push(`Birthday: ${fmtDate(member.birthday)}`)
  if (member.species) lines.push(`Species: ${member.species}`)

  if (member.routines?.length) {
    lines.push('Routines:')
    member.routines.forEach((r) => lines.push(`  - ${r.title}: ${r.schedule}`))
  }

  if (member.preferences?.length) {
    lines.push('Preferences:')
    member.preferences.forEach((p) => lines.push(`  - [${p.category}] ${p.text}`))
  }

  if (member.importantInfo?.length) {
    lines.push('Important info:')
    member.importantInfo.forEach((i) => lines.push(`  - [${i.category}] ${i.label}: ${i.value}`))
  }

  // Include notes stored directly on the member document (MemoryEntry[])
  if (member.memories?.length) {
    lines.push('Personal notes (from their profile):')
    member.memories.slice(0, 6).forEach((me) => lines.push(`  - ${me.text}`))
  }

  // Family memories that concern this member — matches any of the memory's
  // subjects (supports multi-person memories) by email or member id.
  const memberMemories = memories.filter((m) => memoryConcernsMember(m, member.email, member.id))
  if (memberMemories.length) {
    lines.push('Notes about this person:')
    memberMemories.slice(0, 8).forEach((m) => lines.push(`  - ${m.text}`))
  }

  // Strict: only tasks where member is responsible OR the task is for/about them
  const nowMs = new Date(now).getTime()
  const memberTasks = tasks.filter((t) => {
    if (t.isCompleted) return false
    if (matchesMember(member, t.assigneeId, t.assigneeEmail)) return true
    if (member.id && t.forIds?.includes(member.id)) return true
    return false
  })
  if (memberTasks.length) {
    lines.push('Open tasks:')
    memberTasks.forEach((t) => {
      const isFor = member.id && t.forIds?.includes(member.id)
      const isResponsible = matchesMember(member, t.assigneeId, t.assigneeEmail)
      const role = isFor && isResponsible ? '' : isFor ? ' (task is for/about them)' : ''
      // Flag tasks that were due in the past so the AI doesn't surface them as current
      const pastDue = t.dueDate && new Date(t.dueDate).getTime() < nowMs
        ? ' [PAST DUE — may already be resolved]'
        : ''
      const due = t.dueDate ? ` (due ${fmtDate(t.dueDate)})` : ''
      lines.push(`  - [${t.priority}] ${t.title}${due}${role}${pastDue}`)
    })
  }

  // Strict: only chores explicitly assigned to this member
  const memberChores = chores.filter((c) => matchesMember(member, c.assigneeId, c.assigneeEmail))
  if (memberChores.length) {
    lines.push('Recurring chores:')
    memberChores.forEach((c) => {
      const freq = c.recurrence?.frequency ?? 'recurring'
      lines.push(`  - ${c.name} (${freq}, streak: ${c.streak})`)
    })
  }

  // Upcoming events for this member: owned by them, event is for/about them,
  // they are responsible for it, or their name appears in the title.
  const horizon = nowMs + 14 * 24 * 60 * 60 * 1000
  const nameLower = member.name.toLowerCase()
  const memberEvents = (events ?? []).filter((e) => {
    const start = new Date(e.start).getTime()
    if (start < nowMs - 30 * 60 * 1000 || start > horizon) return false
    if (member.email && e.ownerEmail?.toLowerCase() === member.email.toLowerCase()) return true
    if (member.id && e.forIds?.includes(member.id)) return true
    if (member.id && e.assigneeId === member.id) return true
    if (e.title?.toLowerCase().includes(nameLower)) return true
    return false
  }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  if (memberEvents.length) {
    lines.push('Upcoming calendar events (next 14 days):')
    memberEvents.forEach((e) => {
      const start = new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const isFor = member.id && e.forIds?.includes(member.id)
      const isResponsible = member.id && e.assigneeId === member.id
      let role = ''
      if (isFor && isResponsible) role = ' (for them + they are responsible)'
      else if (isFor) role = ' (event is for/about them)'
      else if (isResponsible) role = ' (they are responsible for this)'
      lines.push(`  - ${e.title} — ${start}${e.location ? ` @ ${e.location}` : ''}${role}`)
    })
  }

  return lines.join('\n') || 'No details on file yet for this person.'
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const req: MemberBriefRequest = await request.json()
  const { member, viewerEmail, profile, now, timezone } = req

  const isSelf = !!(member.email && viewerEmail && member.email.toLowerCase() === viewerEmail.toLowerCase())
  const memberContext = buildMemberContext(req)

  const nowFmt = new Date(now).toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  const householdContext = profile
    ? [
        profile.household ? `Household: ${profile.household}` : '',
        profile.priorities?.length ? `Priorities: ${profile.priorities.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  let systemPrompt: string
  let userPrompt: string

  if (isSelf) {
    systemPrompt = `You are a personal assistant writing a brief, warm check-in for a family member looking at their own profile.
Tone: honest, warm, like a trusted friend summing up their situation.
CRITICAL RULES:
- Focus on what is CURRENTLY ACTIVE: open tasks, upcoming calendar events (next 14 days), and ongoing chores.
- Memories and notes are background context — use them only when directly relevant to a current task or upcoming event. Do NOT turn a static memory or general responsibility pattern into a headline ("Jessy is responsible for vet visits" is background, not news).
- If the task/chore/event list is empty or sparse, say so honestly — "not much on your plate" is fine.
- Do NOT reference past-due items as current obligations. Today is ${nowFmt}.
- Be specific — reference tasks and events by name when they exist.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Household context:\n${householdContext}\n` : ''}
Data for ${member.name} (their own view — address them as "you"):
${memberContext}

Write a 2-4 sentence check-in about what's on their plate RIGHT NOW, prioritising upcoming calendar events and open tasks. Be warm and specific about what's actually listed above.
If nothing active is listed, say they seem to have a light plate and note 1 routine if any exist.

Return this exact JSON (no markdown):
{
  "narrative": "..."
}`
  } else {
    systemPrompt = `You are a family relationship assistant helping someone understand a family member.
Your job: help the viewer see what this person is actively carrying and how to support them.
Tone: warm, grounded — like a thoughtful friend who knows this family.
CRITICAL RULES:
- Focus the narrative on what is CURRENTLY ACTIVE: upcoming calendar events, open tasks, ongoing challenges.
- Memories and background notes are context only — do NOT make them the headline of the narrative. A memory like "Jessy handles vet appointments" is a general responsibility pattern, not a current event; only surface it if there's an actual upcoming vet appointment or related open task.
- Do NOT invent tasks, responsibilities, or situations that aren't listed. Do not attribute other family members' work to this person.
- If the context is sparse on active items, be honest about that — "not much on their plate right now" is accurate and fine.
- Do NOT reference past-due items as current. Today is ${nowFmt}.
- For children/pets: keep suggestions age-appropriate. Don't attribute work tasks or adult responsibilities to kids.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Household context:\n${householdContext}\n` : ''}
Data specifically for ${member.name} (${member.role}):
${memberContext}

Based ONLY on what's listed above:

1. Write a 2-4 sentence narrative about where ${member.name} is right now, prioritising upcoming events and active tasks. Be honest — if the list is sparse on active items, reflect that rather than filling space with background facts.

2. Suggest 2-3 specific ways the viewer can support ${member.name}. Must be grounded in the actual data above — tie each suggestion to a real upcoming event, task, or pattern from the list.
   - "task": something the viewer should add to their own to-do list
   - "reminder": something to be reminded about later
   - "copilot": best explored in a conversation

3. List 2-3 key facts about ${member.name} from their profile data above (routines, preferences, importantInfo). Only include facts that are explicitly listed.

4. One optional reflective sentence for the viewer about their relationship with ${member.name}.

Return this exact JSON (no markdown):
{
  "narrative": "...",
  "supports": [{"title": "...", "description": "...", "actionType": "task"|"reminder"|"copilot"}],
  "keyFacts": ["...", "..."],
  "reflection": "..."
}`
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    logUsage('member-brief', MODEL, response.usage)
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const result = JSON.parse(jsonMatch[0])
    return NextResponse.json({ isSelf, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
