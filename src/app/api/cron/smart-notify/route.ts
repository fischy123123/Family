import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb, getAdminMessaging } from '@/lib/firebaseAdmin'
import { getAnthropic, MODEL_FAST, logUsage } from '@/lib/ai'
import { getEvents } from '@/lib/google/calendar'
import { buildFamilyContextParts } from '@/lib/familyContext'
import { DEFAULT_TIMEZONE } from '@/lib/time'
import type {
  CalendarEvent, FamilyMember, Task, Chore, Plan, SmartList, FamilyProfile, FamilyMemory,
} from '@/lib/types'

export const dynamic = 'force-dynamic'

// Smart notification endpoint — designed to run every 30–60 minutes.
// Unlike the morning cron (which sends a fixed daily briefing), this uses
// the same full family context the attention engine uses so Claude can reason
// holistically: prep time from memories, medication routines, quiet hours from
// the profile, coach check-ins, anything the family said matters to them.
//
// Cost controls:
//   • Push tokens checked first — bail immediately if no devices registered.
//   • Data block prompt-cached (1h TTL) — same strategy as the attention engine.
//     On a 30-60 min cron, the static family data rarely changes between runs,
//     so only the time header incurs full token cost after the first call.
//   • Hash dedup — if the full data state hasn't changed AND we notified within
//     the last hour, skip the AI call entirely. The AI only fires when something
//     actually changed (new event, new task, new memory, etc.).

function hashState(data: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}

// Cached at the prompt level (1h TTL) — never changes between runs.
const SYSTEM_PROMPT =
  `You are the push notification brain for a family app. Your job is to decide, RIGHT NOW, ` +
  `whether this family needs a push notification based on everything you know about them.\n\n` +
  `You have their full context: calendar, tasks, memories, personal notes, routines, ` +
  `priorities, and family profile. Use ALL of it — not just the raw event list.\n\n` +
  `WHAT TO LOOK FOR:\n` +
  `• Upcoming events that need PREP TIME — if a memory says they need to leave 45 min early, ` +
  `account for that. An event 2 hours away might need a push now.\n` +
  `• Overdue tasks that are blocking something real or time-sensitive today.\n` +
  `• Health or medication routines that happen at a specific time.\n` +
  `• Anything the family has explicitly said they want to be reminded about.\n` +
  `• Coach check-ins or insights that just became available and feel personally relevant.\n` +
  `• Time-sensitive chores with real consequences if missed — trash/recycling day before ` +
  `collection, anything that has to happen before a specific event or deadline today.\n\n` +
  `WHAT TO IGNORE:\n` +
  `• Everyday routine chores with no deadline (dishes, laundry, tidying) — these can wait.\n` +
  `• Events happening tomorrow or later — only what's relevant in the next 3 hours.\n` +
  `• Quiet hours specified in the family profile — do NOT push during those times.\n` +
  `• Anything that was already sent recently (a dedupe note will be included if relevant).\n\n` +
  `Be selective but not overly cautious. If something has a real consequence for missing it ` +
  `today, that is worth a push. When genuinely nothing is time-sensitive, do NOT send.\n\n` +
  `Return ONLY valid JSON — no markdown, no explanation:\n` +
  `{"shouldNotify":true/false,"title":"...","body":"...","trigger":"event"|"task"|"coach"|"other"}\n` +
  `title ≤50 chars · body ≤160 chars · trigger drives the tap destination.`

interface NotifyDecision {
  shouldNotify: boolean
  title: string
  body: string
  trigger: 'event' | 'task' | 'coach' | 'other'
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let db, messaging
  try {
    db = getAdminDb()
    messaging = getAdminMessaging()
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Admin not configured' }, { status: 500 })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const anthropic = getAnthropic()
  const now = new Date()
  const familiesSnap = await db.collection('families').get()

  let sent = 0
  let skipped = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id
    const fam = (col: string) => db.collection('families').doc(familyId).collection(col)

    // No tokens → nothing to send, skip all work for this family.
    const tokensSnap = await fam('pushTokens').get()
    const tokens = tokensSnap.docs.map((d) => d.data().token as string).filter(Boolean)
    if (tokens.length === 0) continue

    // ── Calendar sync ──────────────────────────────────────────────────────
    // Refresh Google Calendar data so Claude reasons about fresh events,
    // not whatever was last synced when the user had the app open.
    const googleTokensSnap = await db.collection('families').doc(familyId)
      .collection('googleTokens').get()

    if (!googleTokensSnap.empty) {
      const calendarTimeMin = now.toISOString()
      const calendarTimeMax = new Date(Date.now() + 7 * 86_400_000).toISOString()
      const eventsCol = fam('events')

      for (const tokenDoc of googleTokensSnap.docs) {
        const { accessToken, refreshToken, email } = tokenDoc.data() as {
          accessToken: string; refreshToken: string; email: string
        }
        if (!accessToken || !refreshToken) continue

        try {
          const rawEvents = await getEvents(accessToken, refreshToken, calendarTimeMin, calendarTimeMax)
          const events: CalendarEvent[] = rawEvents.map((e) => ({
            ...e, ownerEmail: e.ownerEmail || email,
          }))

          const BATCH_LIMIT = 490
          const oldSnap = await eventsCol
            .where('ownerEmail', '==', email)
            .where('source', '==', 'google')
            .get()

          for (let i = 0; i < oldSnap.docs.length; i += BATCH_LIMIT) {
            const batch = db.batch()
            oldSnap.docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref))
            await batch.commit()
          }
          for (let i = 0; i < events.length; i += BATCH_LIMIT) {
            const batch = db.batch()
            events.slice(i, i + BATCH_LIMIT).forEach((e) => {
              batch.set(eventsCol.doc(e.id), { ...e, source: 'google' })
            })
            await batch.commit()
          }
        } catch (err) {
          console.error(`smart-notify calendar sync failed for ${email}:`, err)
        }
      }
    }

    // ── Pull full family data ──────────────────────────────────────────────
    // Same collections as the attention engine. Coach insights included so
    // Claude can surface a new check-in as a notification trigger.
    const [
      membersSnap, eventsSnap, tasksSnap, choresSnap,
      plansSnap, listsSnap, profileSnap, memoriesSnap, insightsSnap,
    ] = await Promise.all([
      fam('members').get(), fam('events').get(), fam('tasks').get(), fam('chores').get(),
      fam('plans').get(), fam('lists').get(), fam('profile').get(),
      fam('memories').get(), fam('insights').get(),
    ])

    const docs = <T,>(s: FirebaseFirestore.QuerySnapshot) =>
      s.docs.map((d) => ({ id: d.id, ...d.data() } as T))

    const members = docs<FamilyMember>(membersSnap)
    if (members.length === 0) continue

    // Append unread coach insights to memories so Claude sees them as context.
    // They're short text entries — blending them in is simpler than a new field.
    const baseMemories = docs<FamilyMemory>(memoriesSnap)
    const insightMemories: FamilyMemory[] = insightsSnap.docs
      .filter((d) => !d.data().notifiedAt)
      .map((d) => ({
        id: d.id,
        text: `[Coach check-in] ${d.data().title ?? ''}: ${d.data().body ?? ''}`.trim(),
        createdAt: d.data().generatedAt ?? now.toISOString(),
      } as FamilyMemory))
    const memories = [...baseMemories, ...insightMemories]

    // ── Build full context ─────────────────────────────────────────────────
    const { timeHeader, dataBlock } = buildFamilyContextParts({
      members,
      events: docs<CalendarEvent>(eventsSnap),
      tasks: docs<Task>(tasksSnap),
      chores: docs<Chore>(choresSnap),
      plans: docs<Plan>(plansSnap),
      lists: docs<SmartList>(listsSnap),
      profile: (profileSnap.docs[0]?.data() as FamilyProfile) ?? null,
      memories,
      now: now.toISOString(),
      timezone: DEFAULT_TIMEZONE,
    })

    // ── Hash dedup ─────────────────────────────────────────────────────────
    // Hash the data block (everything Claude will reason about). If nothing
    // changed AND we notified within the last hour, skip the AI call.
    const currentHash = hashState(dataBlock)

    const stateRef = fam('meta').doc('smartNotify')
    const stateDoc = await stateRef.get()
    const stored = stateDoc.data() ?? {}
    const lastHash: string = stored.lastHash ?? ''
    const lastNotifiedAt: string = stored.lastNotifiedAt ?? ''
    const lastBody: string = stored.lastBody ?? ''

    const oneHourAgo = Date.now() - 60 * 60_000
    if (currentHash === lastHash && lastNotifiedAt && new Date(lastNotifiedAt).getTime() > oneHourAgo) {
      skipped++
      await stateRef.set({ lastCheckedAt: now.toISOString() }, { merge: true })
      continue
    }

    // ── Ask Claude ────────────────────────────────────────────────────────
    const dedupeNote = lastBody
      ? `\n\nDo NOT send a notification if it repeats this recently sent message:\n"${lastBody}"`
      : ''

    let decision: NotifyDecision
    try {
      const response = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 150,
        system: [
          // System prompt cached at 1h — never changes between runs.
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
        ],
        messages: [{
          role: 'user',
          content: [
            // Data block cached at 1h — only changes when family data changes.
            { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
            // Time header always fresh — current time + dedupe note.
            { type: 'text', text: timeHeader + dedupeNote },
          ],
        }],
      })

      logUsage('smart-notify', MODEL_FAST, response.usage)

      const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
      const match = raw.match(/\{[\s\S]*\}/)
      const parsed = match ? JSON.parse(match[0]) : {}
      decision = {
        shouldNotify: !!parsed.shouldNotify,
        title: String(parsed.title ?? ''),
        body: String(parsed.body ?? ''),
        trigger: (['event', 'task', 'coach', 'other'].includes(parsed.trigger) ? parsed.trigger : 'other') as NotifyDecision['trigger'],
      }
    } catch (err) {
      console.error(`smart-notify AI failed for family ${familyId}:`, err)
      continue
    }

    // Always update stored hash so subsequent runs with unchanged data skip.
    await stateRef.set(
      {
        lastHash: currentHash,
        lastCheckedAt: now.toISOString(),
        ...(decision.shouldNotify
          ? { lastNotifiedAt: now.toISOString(), lastBody: decision.body }
          : {}),
      },
      { merge: true },
    )

    if (!decision.shouldNotify || !decision.body) { skipped++; continue }

    // ── Send ───────────────────────────────────────────────────────────────
    // Link to the most relevant destination based on Claude's trigger label.
    const notifLink =
      decision.trigger === 'event' ? '/calendar' :
      decision.trigger === 'task' ? '/tasks' :
      decision.trigger === 'coach' ? '/coach' :
      '/command'

    try {
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: decision.title || 'Family Update', body: decision.body },
        webpush: {
          fcmOptions: { link: notifLink },
          data: { link: notifLink },
        },
      })
      sent += res.successCount

      // Clean up stale device tokens.
      res.responses.forEach((r, i) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          tokensSnap.docs[i].ref.delete().catch(() => {})
        }
      })

      // Mark coach insights as notified so they aren't re-surfaced next run.
      if (decision.trigger === 'coach' && insightMemories.length > 0) {
        const batch = db.batch()
        insightsSnap.docs
          .filter((d) => !d.data().notifiedAt)
          .forEach((d) => batch.update(d.ref, { notifiedAt: now.toISOString() }))
        await batch.commit()
      }
    } catch (err) {
      console.error(`smart-notify FCM send failed for family ${familyId}:`, err)
    }
  }

  return NextResponse.json({ ok: true, sent, skipped })
}
