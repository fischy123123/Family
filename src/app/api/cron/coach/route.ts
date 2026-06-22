import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb } from '@/lib/firebaseAdmin'
import { generateCoaching, type CoachInput } from '@/lib/coach'
import { DEFAULT_TIMEZONE } from '@/lib/time'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyGoal, Reflection, CoachingInsight,
} from '@/lib/types'

// Weekly life-coaching pass. Runs on a cron, reasons over each family's longer
// horizon, and writes a fresh set of reflective insights to Firestore so the
// family sees a check-in waiting for them — no need to open the app to trigger it.
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

  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(weekStart.getDate() - weekStart.getDay())
  weekStart.setHours(0, 0, 0, 0)
  const weekOf = weekStart.toISOString()

  const familiesSnap = await db.collection('families').get()
  let generated = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id
    const fam = (col: string) => db.collection('families').doc(familyId).collection(col)

    try {
      const [
        membersSnap, eventsSnap, tasksSnap, choresSnap, plansSnap,
        listsSnap, profileSnap, memoriesSnap, goalsSnap, reflectionsSnap, insightsSnap,
      ] = await Promise.all([
        fam('members').get(), fam('events').get(), fam('tasks').get(),
        fam('chores').get(), fam('plans').get(), fam('lists').get(),
        fam('profile').get(), fam('memories').get(), fam('goals').get(),
        fam('reflections').get(), fam('insights').get(),
      ])

      const docs = <T,>(s: FirebaseFirestore.QuerySnapshot) =>
        s.docs.map((d) => ({ id: d.id, ...d.data() } as T))

      const members = docs<FamilyMember>(membersSnap)
      const goals = docs<FamilyGoal>(goalsSnap)
      const reflections = docs<Reflection>(reflectionsSnap)

      // Skip families with no meaningful data to coach on.
      if (members.length === 0 && goals.length === 0 && reflections.length === 0) continue

      const events = docs<CalendarEvent>(eventsSnap)
      const tasks = docs<Task>(tasksSnap)
      const recentInsights = docs<CoachingInsight>(insightsSnap)

      const input: CoachInput = {
        members,
        events,
        tasks: tasks.filter((t) => !t.isCompleted),
        chores: docs<Chore>(choresSnap),
        plans: docs<Plan>(plansSnap),
        lists: docs<SmartList>(listsSnap),
        profile: (profileSnap.docs[0]?.data() as FamilyProfile) ?? null,
        memories: docs<FamilyMemory>(memoriesSnap),
        goals,
        reflections: reflections.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ),
        recentInsights,
        pastEvents: events,
        completedTasks: tasks.filter((t) => t.isCompleted),
        now: now.toISOString(),
        timezone: DEFAULT_TIMEZONE,
      }

      const result = await generateCoaching(input)
      if (result.insights.length === 0) continue

      const batch = db.batch()
      result.insights.forEach((it, i) => {
        const id = `coach-${weekStart.getTime()}-${i}`
        batch.set(fam('insights').doc(id), {
          ...it,
          generatedAt: now.toISOString(),
          weekOf,
        })
      })
      // Stash the summary so the command center can show the weekly headline.
      batch.set(fam('coachSummary').doc('latest'), {
        summary: result.summary,
        weekOf,
        generatedAt: now.toISOString(),
      })
      await batch.commit()
      generated += result.insights.length
    } catch (e) {
      console.error(`Coaching failed for family ${familyId}:`, e)
      continue
    }
  }

  return NextResponse.json({ ok: true, generated })
}
