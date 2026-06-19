import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb, getAdminMessaging } from '@/lib/firebaseAdmin'
import Anthropic from '@anthropic-ai/sdk'
import { logUsage } from '@/lib/ai'

const NOTIFY_MODEL = 'claude-haiku-4-5-20251001'

/** Returns true if an ISO date string falls on today or is overdue (past today). */
function isDueOrOverdue(iso?: string): boolean {
  if (!iso) return false
  const today = new Date().toISOString().split('T')[0]
  return iso.split('T')[0] <= today
}

/** Returns true if an ISO date string falls on today exactly. */
function isToday(iso?: string): boolean {
  if (!iso) return false
  const today = new Date().toISOString().split('T')[0]
  return iso.split('T')[0] === today
}

async function generateBriefing(familyName: string, summary: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    // Short daily notification text generated on a cron — Haiku keeps recurring cost down.
    model: NOTIFY_MODEL,
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: `Today's family data for ${familyName}:\n${summary}`,
      },
    ],
    system:
      "You are a family assistant. Given today's family data, write a morning briefing notification. Keep it under 200 characters total (notification body). Be warm, specific, and action-oriented. Mention the 2-3 most important things. Example: 'Mia has soccer at 4pm (leave by 3:40). Dentist for Jake at 2pm. Grocery run needed.'",
  })

  logUsage('cron-notify', NOTIFY_MODEL, response.usage)
  return response.content[0].type === 'text' ? response.content[0].text.trim() : ''
}

export async function GET(request: NextRequest) {
  // Protect the endpoint: Vercel Cron sends the CRON_SECRET as a bearer token.
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let db, messaging
  try {
    db = getAdminDb()
    messaging = getAdminMessaging()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Admin not configured'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const familiesSnap = await db.collection('families').get()
  let sent = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id
    const familyData = familyDoc.data()
    const familyName: string = familyData.name ?? 'the family'

    const today = new Date().toISOString().split('T')[0]

    // Gather members
    const membersSnap = await db.collection('families').doc(familyId).collection('members').get()
    const members = membersSnap.docs.map((d) => d.data().name as string).filter(Boolean)

    // Gather incomplete tasks due today or overdue
    const tasksSnap = await db.collection('families').doc(familyId).collection('tasks').get()
    const dueTasks: string[] = []
    tasksSnap.forEach((d) => {
      const t = d.data()
      if (!t.isCompleted && isDueOrOverdue(t.dueDate)) {
        const assignee = t.assignedTo ? ` (${t.assignedTo})` : ''
        const overdue = t.dueDate && t.dueDate.split('T')[0] < today ? ' [OVERDUE]' : ''
        dueTasks.push(`${t.title}${assignee}${overdue}`)
      }
    })

    // Gather today's events
    const eventsSnap = await db.collection('families').doc(familyId).collection('events').get()
    const todayEvents: string[] = []
    eventsSnap.forEach((d) => {
      const e = d.data()
      if (typeof e.start === 'string' && isToday(e.start)) {
        const time = e.start.includes('T') ? ` at ${e.start.split('T')[1].slice(0, 5)}` : ''
        const who = e.attendees?.join(', ') ?? ''
        todayEvents.push(`${e.title}${time}${who ? ` (${who})` : ''}`)
      }
    })

    // Gather all chores
    const choresSnap = await db.collection('families').doc(familyId).collection('chores').get()
    const pendingChores: string[] = []
    choresSnap.forEach((d) => {
      const c = d.data()
      if (c.lastCompletedDate !== today) {
        pendingChores.push(c.name)
      }
    })

    // Skip if nothing to report
    if (dueTasks.length === 0 && todayEvents.length === 0 && pendingChores.length === 0) continue

    // Collect this family's device tokens.
    const tokensSnap = await db.collection('families').doc(familyId).collection('pushTokens').get()
    const tokens = tokensSnap.docs.map((d) => d.data().token as string).filter(Boolean)
    if (tokens.length === 0) continue

    // Build structured summary for Claude
    const summaryParts: string[] = []
    if (members.length > 0) summaryParts.push(`Members: ${members.join(', ')}`)
    if (todayEvents.length > 0) summaryParts.push(`Today's events: ${todayEvents.join('; ')}`)
    if (dueTasks.length > 0) summaryParts.push(`Tasks due/overdue: ${dueTasks.join('; ')}`)
    if (pendingChores.length > 0) summaryParts.push(`Pending chores: ${pendingChores.join(', ')}`)
    const summary = summaryParts.join('\n')

    // Generate AI briefing
    let body: string
    try {
      body = await generateBriefing(familyName, summary)
    } catch (e) {
      console.error(`Failed to generate briefing for family ${familyId}:`, e)
      continue
    }

    if (!body) continue

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: `Good morning, ${familyName}! ☀️`,
        body,
      },
      webpush: {
        fcmOptions: { link: '/command' },
      },
    })
    sent += res.successCount

    // Clean up tokens that are no longer valid.
    res.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        tokensSnap.docs[i].ref.delete().catch(() => {})
      }
    })
  }

  return NextResponse.json({ ok: true, sent })
}
