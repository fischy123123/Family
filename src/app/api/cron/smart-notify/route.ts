import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb, getAdminMessaging } from '@/lib/firebaseAdmin'
import { getAnthropic, MODEL_FAST, logUsage } from '@/lib/ai'
import { getEvents } from '@/lib/google/calendar'
import type { CalendarEvent } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Near-real-time smart notification endpoint.
// Designed to be called every 15–30 min by an external cron (e.g. cron-job.org).
// For each family:
//   1. Syncs Google Calendar using stored tokens (keeps data fresh without user opening the app)
//   2. Hashes the relevant actionable state (events in next 4h, due/overdue tasks)
//   3. Skips the AI call entirely when nothing changed since last notification
//   4. Calls Claude Haiku to decide whether to push — and what to say — only when warranted
//   5. Deduplicates to avoid re-sending the same message

function hashState(data: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}

function isDueOrOverdue(iso?: string): boolean {
  if (!iso) return false
  const today = new Date().toISOString().split('T')[0]
  return iso.split('T')[0] <= today
}

function isWithinHours(iso: string, hours: number): boolean {
  const t = new Date(iso).getTime()
  return t >= Date.now() && t <= Date.now() + hours * 3_600_000
}

interface NotifyDecision {
  shouldNotify: boolean
  title: string
  body: string
}

async function askShouldNotify(
  familyName: string,
  currentTimeISO: string,
  summary: string,
  recentBody: string,
): Promise<NotifyDecision> {
  const anthropic = getAnthropic()

  const dedupeNote = recentBody
    ? `\n\nDO NOT repeat this notification already sent recently:\n"${recentBody}"`
    : ''

  const response = await anthropic.messages.create({
    model: MODEL_FAST,
    max_tokens: 120,
    system:
      'You are a push notification assistant for a family app. Be selective and direct. ' +
      'Only push when there is something genuinely time-sensitive or overdue right now. ' +
      'Keep title ≤50 chars, body ≤160 chars. Return only valid JSON — no markdown, no explanation.',
    messages: [
      {
        role: 'user',
        content:
          `Family: ${familyName}\nCurrent time: ${currentTimeISO}\n\n` +
          `${summary}${dedupeNote}\n\n` +
          `Should we send a push notification right now? ` +
          `Return JSON: {"shouldNotify":true/false,"title":"...","body":"..."}`,
      },
    ],
  })

  logUsage('smart-notify', MODEL_FAST, response.usage)

  const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  try {
    const parsed = JSON.parse(raw) as NotifyDecision
    return { shouldNotify: !!parsed.shouldNotify, title: parsed.title ?? '', body: parsed.body ?? '' }
  } catch {
    return { shouldNotify: false, title: '', body: '' }
  }
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

  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]
  const familiesSnap = await db.collection('families').get()

  let sent = 0
  let skipped = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id
    const familyName: string = familyDoc.data().name ?? 'the family'

    // Check push tokens first — pointless to do any work without them
    const tokensSnap = await db.collection('families').doc(familyId).collection('pushTokens').get()
    const tokens = tokensSnap.docs.map((d) => d.data().token as string).filter(Boolean)
    if (tokens.length === 0) continue

    // Step 1: Sync Google Calendar for all connected members
    const googleTokensSnap = await db
      .collection('families').doc(familyId).collection('googleTokens').get()

    if (!googleTokensSnap.empty) {
      const calendarTimeMin = now.toISOString()
      const calendarTimeMax = new Date(Date.now() + 7 * 86_400_000).toISOString()
      const eventsCol = db.collection('families').doc(familyId).collection('events')

      for (const tokenDoc of googleTokensSnap.docs) {
        const { accessToken, refreshToken, email } = tokenDoc.data() as {
          accessToken: string; refreshToken: string; email: string
        }
        if (!accessToken || !refreshToken) continue

        try {
          const rawEvents = await getEvents(accessToken, refreshToken, calendarTimeMin, calendarTimeMax)
          const events: CalendarEvent[] = rawEvents.map((e) => ({
            ...e,
            ownerEmail: e.ownerEmail || email,
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

    // Step 2: Read fresh data to evaluate urgency
    const [tasksSnap, eventsSnap, choresSnap] = await Promise.all([
      db.collection('families').doc(familyId).collection('tasks').get(),
      db.collection('families').doc(familyId).collection('events').get(),
      db.collection('families').doc(familyId).collection('chores').get(),
    ])

    const dueTasks: { title: string; assignedTo?: string; overdue: boolean }[] = []
    tasksSnap.forEach((d) => {
      const t = d.data()
      if (!t.isCompleted && isDueOrOverdue(t.dueDate)) {
        dueTasks.push({
          title: t.title,
          assignedTo: t.assignedTo,
          overdue: !!t.dueDate && t.dueDate.split('T')[0] < todayStr,
        })
      }
    })

    // Events starting within the next 4 hours
    const soonEvents: { title: string; start: string; minsUntil: number; attendees?: string[] }[] = []
    eventsSnap.forEach((d) => {
      const e = d.data()
      if (typeof e.start === 'string' && isWithinHours(e.start, 4)) {
        soonEvents.push({
          title: e.title,
          start: e.start,
          minsUntil: Math.round((new Date(e.start).getTime() - now.getTime()) / 60_000),
          attendees: e.attendees,
        })
      }
    })

    const pendingChores: string[] = []
    choresSnap.forEach((d) => {
      const c = d.data()
      if (c.lastCompletedDate !== todayStr) pendingChores.push(c.name)
    })

    // Step 3: Hash the actionable state to detect changes
    const actionableState = { dueTasks, soonEvents }
    const currentHash = hashState(actionableState)

    const stateRef = db.collection('families').doc(familyId).collection('meta').doc('smartNotify')
    const stateDoc = await stateRef.get()
    const stored = stateDoc.data() ?? {}
    const lastHash: string = stored.lastHash ?? ''
    const lastNotifiedAt: string = stored.lastNotifiedAt ?? ''
    const lastBody: string = stored.lastBody ?? ''

    // Skip if unchanged within last 30 min (prevents hammering when cron runs frequently)
    const thirtyMinAgo = Date.now() - 30 * 60_000
    if (currentHash === lastHash && lastNotifiedAt && new Date(lastNotifiedAt).getTime() > thirtyMinAgo) {
      skipped++
      await stateRef.set({ lastCheckedAt: now.toISOString() }, { merge: true })
      continue
    }

    // Skip early if nothing actionable at all
    if (dueTasks.length === 0 && soonEvents.length === 0) {
      await stateRef.set({ lastHash: currentHash, lastCheckedAt: now.toISOString() }, { merge: true })
      continue
    }

    // Step 4: Build a concise summary for Claude
    const lines: string[] = []
    if (soonEvents.length > 0) {
      lines.push('Upcoming events (next 4h):')
      soonEvents.forEach((e) => {
        const who = e.attendees?.length ? ` — ${e.attendees.join(', ')}` : ''
        lines.push(`  • ${e.title} in ${e.minsUntil} min${who}`)
      })
    }
    if (dueTasks.length > 0) {
      lines.push('Due/overdue tasks:')
      dueTasks.forEach((t) => {
        const tag = t.overdue ? ' [OVERDUE]' : ''
        const who = t.assignedTo ? ` → ${t.assignedTo}` : ''
        lines.push(`  • ${t.title}${who}${tag}`)
      })
    }
    const summary = lines.join('\n')

    // Step 5: Ask Claude if this warrants a notification
    let decision: NotifyDecision
    try {
      decision = await askShouldNotify(familyName, now.toISOString(), summary, lastBody)
    } catch (err) {
      console.error(`smart-notify AI failed for family ${familyId}:`, err)
      continue
    }

    // Always update the stored hash so next run skips unchanged state
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

    if (!decision.shouldNotify || !decision.body) continue

    // Step 6: Send the push notification
    try {
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: decision.title || `${familyName} Update`,
          body: decision.body,
        },
        webpush: {
          fcmOptions: { link: '/command' },
        },
      })
      sent += res.successCount

      res.responses.forEach((r, i) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          tokensSnap.docs[i].ref.delete().catch(() => {})
        }
      })
    } catch (err) {
      console.error(`smart-notify FCM send failed for family ${familyId}:`, err)
    }
  }

  return NextResponse.json({ ok: true, sent, skipped })
}
