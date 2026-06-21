import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage, estimateCost } from '@/lib/ai'
import { ATTENTION_MODEL, ATTENTION_MAX_TOKENS, ATTENTION_SYSTEM_PROMPT } from '@/lib/attentionPrompt'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
} from '@/lib/types'

// Vercel Cron: pre-generate briefings for every family member every 20 minutes.
// Stores results to families/{familyId}/briefings/{emailKey} so the Command
// Center can cold-start with a warm briefing in ~300ms instead of waiting for
// a fresh Sonnet generation (~20-30s).
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  let db
  try {
    db = getAdminDb()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Admin not configured'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const familiesSnap = await db.collection('families').get()

  let generated = 0
  let errors = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id
    const fam = (col: string) => db.collection('families').doc(familyId).collection(col)

    try {
      const [
        membersSnap, eventsSnap, tasksSnap, remindersSnap, choresSnap,
        plansSnap, listsSnap, profileSnap, memoriesSnap,
      ] = await Promise.all([
        fam('members').get(), fam('events').get(), fam('tasks').get(),
        fam('reminders').get(), fam('chores').get(), fam('plans').get(),
        fam('lists').get(), fam('profile').get(), fam('memories').get(),
      ])

      const docs = <T,>(s: FirebaseFirestore.QuerySnapshot) =>
        s.docs.map((d) => ({ id: d.id, ...d.data() } as T))

      const members = docs<FamilyMember>(membersSnap)
      if (members.length === 0) continue

      const tasks = docs<Task>(tasksSnap)
      const reminders = docs<FamilyReminder>(remindersSnap)

      // Merge legacy reminders into tasks (same logic as buildEngineBody in CommandCenter).
      const reminderAsTasks: Task[] = reminders.map((r) => ({
        id: r.id,
        title: r.title,
        notes: r.notes,
        isCompleted: r.isCompleted,
        completedAt: r.completedAt,
        dueDate: r.dueDate,
        assigneeEmail: r.assigneeEmail,
        priority: r.priority,
        recurrence: r.recurrence,
        relatedEventId: r.relatedEventId,
        source: 'ai' as const,
        createdAt: r.dueDate ?? new Date().toISOString(),
      }))
      const allTasks = [
        ...tasks,
        ...reminderAsTasks.filter((r) => !tasks.some((t) => t.id === r.id)),
      ]

      // Only send upcoming/ongoing events (same cutoff as CommandCenter).
      const relevantCutoff = Date.now() - 30 * 60 * 1000
      const allEvents = docs<CalendarEvent>(eventsSnap)
      const upcomingEvents = allEvents.filter(
        (e) => new Date(e.end ?? e.start).getTime() >= relevantCutoff
      )

      const profile = (profileSnap.docs[0]?.data() as FamilyProfile) ?? null
      const memories = docs<FamilyMemory>(memoriesSnap)
      const chores = docs<Chore>(choresSnap)
      const plans = docs<Plan>(plansSnap)
      const lists = docs<SmartList>(listsSnap)

      const now = new Date().toISOString()

      // Generate a personalized briefing for each member with an email address,
      // in parallel within the family.
      await Promise.all(
        members
          .filter((m) => !!m.email)
          .map(async (member) => {
            const emailKey = member.email.replace(/[@.]/g, '_')
            const runStart = Date.now()

            const ctx: FamilyContextInput = {
              members,
              events: upcomingEvents,
              tasks: allTasks,
              chores,
              plans,
              lists,
              profile,
              memories,
              inbox: [],
              now,
              timezone: 'America/Los_Angeles',
              currentUserEmail: member.email,
              currentUserName: member.name,
            }

            const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)

            let response
            try {
              response = await anthropic.messages.create({
                model: ATTENTION_MODEL,
                max_tokens: ATTENTION_MAX_TOKENS,
                system: [
                  { type: 'text', text: ATTENTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
                ],
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
                    { type: 'text', text: timeHeader },
                  ],
                }],
              })
            } catch (e) {
              console.error(`[cron/briefing] AI call failed for ${member.email} (family ${familyId}):`, e)
              errors++
              return
            }

            logUsage('cron-briefing', ATTENTION_MODEL, response.usage)
            const uMap = response.usage as unknown as Record<string, number>
            console.log(
              `[cron/briefing] family=${familyId} member=${member.email}` +
              ` wall=${Date.now() - runStart}ms stop=${response.stop_reason}` +
              ` cost=${estimateCost(ATTENTION_MODEL, uMap)}`
            )

            if (response.stop_reason === 'max_tokens') {
              console.warn(`[cron/briefing] Truncated response for ${member.email} — skipping write`)
              errors++
              return
            }

            const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}'
            const match = text.match(/\{[\s\S]*\}/)
            if (!match) {
              console.warn(`[cron/briefing] No JSON found for ${member.email}`)
              errors++
              return
            }

            let parsed: {
              greeting?: string
              items?: Record<string, unknown>[]
              problems?: Record<string, unknown>[]
              recommendations?: Record<string, unknown>[]
              eventAssignments?: Record<string, unknown>[]
            } = {}

            try {
              parsed = JSON.parse(match[0])
            } catch {
              const greetingMatch = match[0].match(/"greeting"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/)
              parsed = {
                greeting: greetingMatch?.[1] ?? 'Here is what needs your attention.',
                items: [], problems: [], recommendations: [],
              }
            }

            const items = (parsed.items ?? []).map((it, i) => ({ id: `att-${i}`, ...it }))
            const problems = (parsed.problems ?? []).map((p, i) => ({ id: `prob-${i}`, ...p }))
            const recommendations = (parsed.recommendations ?? []).map((r, i) => ({ id: `rec-${i}`, ...r }))
            const eventAssignments = (parsed.eventAssignments ?? []).map((a, i) => ({ id: `ea-${i}`, ...a }))

            const generatedAt = new Date().toISOString()
            const report = {
              generatedAt,
              tier: 'fast' as const,
              greeting: parsed.greeting ?? 'Here is what needs your attention.',
              items,
              problems,
              recommendations,
              eventAssignments,
            }

            await fam('briefings').doc(emailKey).set({
              forEmail: member.email,
              generatedAt,
              report,
            })

            generated++
          })
      )
    } catch (e) {
      console.error(`[cron/briefing] Failed for family ${familyId}:`, e)
      errors++
    }
  }

  return NextResponse.json({ ok: true, generated, errors })
}
