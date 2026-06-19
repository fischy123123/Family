import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { FamilyMember, Task, Chore, FamilyMemory, FamilyProfile } from '@/lib/types'
import { memoryConcernsMember } from '@/lib/types'

const MODEL = 'claude-sonnet-4-6'

interface MemberBriefRequest {
  member: FamilyMember
  viewerEmail: string
  tasks: Task[]
  chores: Chore[]
  memories: FamilyMemory[]
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
  const { member, tasks, chores, memories, now } = req
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

  // Strict: only tasks explicitly assigned to this member by id or email
  const nowMs = new Date(now).getTime()
  const memberTasks = tasks.filter(
    (t) => !t.isCompleted && matchesMember(member, t.assigneeId, t.assigneeEmail)
  )
  if (memberTasks.length) {
    lines.push('Open tasks:')
    memberTasks.forEach((t) => {
      // Flag tasks that were due in the past so the AI doesn't surface them as current
      const pastDue = t.dueDate && new Date(t.dueDate).getTime() < nowMs
        ? ' [PAST DUE — may already be resolved]'
        : ''
      const due = t.dueDate ? ` (due ${fmtDate(t.dueDate)}${pastDue ? '' : ''})` : ''
      lines.push(`  - [${t.priority}] ${t.title}${due}${pastDue}`)
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
- Write ONLY about what is explicitly listed in the context below. Do not invent, infer, or extrapolate.
- If the task/chore list is empty or sparse, say so honestly — "not much on your plate" is fine.
- Do NOT reference anything that happened in the past (past-due items, old events). Today is ${nowFmt}.
- If you see "[PAST DUE]" tags, do not surface those as current obligations.
- Be specific — reference tasks and chores by name if they exist.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Household context:\n${householdContext}\n` : ''}
Data for ${member.name} (their own view — address them as "you"):
${memberContext}

Write a 2-4 sentence check-in about what's on their plate RIGHT NOW. Be warm and specific about what's actually listed above.
If nothing is listed, say they seem to have a light plate and note 1 routine if any exist.

Return this exact JSON (no markdown):
{
  "narrative": "..."
}`
  } else {
    systemPrompt = `You are a family relationship assistant helping someone understand a family member.
Your job: help the viewer see what this person is carrying and how to support them.
Tone: warm, grounded — like a thoughtful friend who knows this family.
CRITICAL RULES:
- Write ONLY about what is explicitly listed in the context below for this specific person.
- Do NOT invent tasks, responsibilities, or situations that aren't listed. Do not attribute other family members' work to this person.
- If the context is sparse, be honest about that — "not much on their plate" is accurate and fine.
- Do NOT reference past events as current. Today is ${nowFmt}. Anything marked [PAST DUE] may already be resolved.
- For children/pets: keep suggestions age-appropriate. Don't attribute work tasks or adult responsibilities to kids.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Household context:\n${householdContext}\n` : ''}
Data specifically for ${member.name} (${member.role}):
${memberContext}

Based ONLY on what's listed above:

1. Write a 2-4 sentence narrative about where ${member.name} is right now. Be honest — if the list is sparse, reflect that.

2. Suggest 2-3 specific ways the viewer can support ${member.name}. Must be grounded in the actual data above.
   - "task": something the viewer should add to their own to-do list
   - "reminder": something to be reminded about later
   - "copilot": best explored in a conversation

3. List 2-3 key facts about ${member.name} from their profile data above (routines, preferences, importantInfo).
   Only include facts that are explicitly listed — do not make things up.

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
