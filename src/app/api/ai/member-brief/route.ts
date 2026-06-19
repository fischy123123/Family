import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { FamilyMember, Task, Chore, FamilyMemory, FamilyProfile } from '@/lib/types'

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

function buildMemberContext(req: MemberBriefRequest): string {
  const { member, tasks, chores, memories } = req
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

  const memberMemories = memories.filter(
    (m) => !m.subjectEmail || m.subjectEmail.toLowerCase() === member.email?.toLowerCase()
  )
  if (memberMemories.length) {
    lines.push('Memories:')
    memberMemories.slice(0, 10).forEach((m) => lines.push(`  - ${m.text}`))
  }

  const memberTasks = tasks.filter(
    (t) => !t.isCompleted &&
      (t.assigneeId === member.id || t.assigneeEmail?.toLowerCase() === member.email?.toLowerCase())
  )
  if (memberTasks.length) {
    lines.push('Open tasks:')
    memberTasks.forEach((t) => {
      const due = t.dueDate ? ` (due ${fmtDate(t.dueDate)})` : ''
      lines.push(`  - [${t.priority}] ${t.title}${due}`)
    })
  }

  const memberChores = chores.filter(
    (c) => c.assigneeId === member.id || c.assigneeEmail?.toLowerCase() === member.email?.toLowerCase()
  )
  if (memberChores.length) {
    lines.push('Recurring chores:')
    memberChores.forEach((c) => {
      const freq = c.recurrence?.frequency ?? 'recurring'
      lines.push(`  - ${c.name} (${freq}, streak: ${c.streak})`)
    })
  }

  return lines.join('\n') || 'No details on file yet.'
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const req: MemberBriefRequest = await request.json()
  const { member, viewerEmail, profile, now, timezone } = req

  const isSelf = member.email?.toLowerCase() === viewerEmail?.toLowerCase()
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
Tone: honest, warm, like a trusted friend summing up your week.
Be specific — reference actual tasks and chores by name. Don't be generic.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Context:\n${householdContext}\n` : ''}
About ${member.name} (this is their own view):
${memberContext}

Write a personal check-in for ${member.name} about what's on their plate. 2-4 sentences. Address them as "you". Be warm and specific.

Return this exact JSON shape (no markdown, no commentary):
{
  "narrative": "..."
}`
  } else {
    systemPrompt = `You are a family relationship assistant helping someone understand a family member they care about.
Your job: help the viewer see what this person is carrying and how they can show up for them.
Tone: warm, perceptive, grounded — like a therapist or wise friend who knows the family well.
Be specific. Reference actual tasks, chores, and context. Don't be generic or vague.
Return ONLY valid JSON.`

    userPrompt = `Right now: ${nowFmt}
${householdContext ? `Context:\n${householdContext}\n` : ''}
About ${member.name}:
${memberContext}

1. Write a 2-4 sentence narrative about where ${member.name} is right now — what they're dealing with, what's ahead, and anything they might need.

2. Suggest 2-3 specific ways the viewer can support ${member.name} this week. Each should be immediately actionable.
   - Use actionType "task" for things the viewer should add to their own to-do list
   - Use actionType "reminder" for things they should be reminded about later
   - Use actionType "copilot" for things best explored in a conversation (planning, complex coordination)

3. List 2-3 key facts about ${member.name} the viewer should keep in mind (from their profile, memories, routines).

4. One optional reflective sentence the viewer might want to sit with about their relationship with ${member.name}.

Return this exact JSON shape (no markdown, no commentary):
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
