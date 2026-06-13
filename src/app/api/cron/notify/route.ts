import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb, getAdminMessaging } from '@/lib/firebaseAdmin'

interface DueItem {
  label: string
}

/** Returns true if an ISO date string falls on today (local-ish, UTC date compare). */
function isDueToday(iso?: string): boolean {
  if (!iso) return false
  const today = new Date().toISOString().split('T')[0]
  return iso.split('T')[0] <= today
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

  const familiesSnap = await db.collection('families').get()
  let sent = 0

  for (const familyDoc of familiesSnap.docs) {
    const familyId = familyDoc.id

    // Gather what's due today across reminders, events, and chores.
    const due: DueItem[] = []

    const remindersSnap = await db.collection('families').doc(familyId).collection('reminders').get()
    remindersSnap.forEach((d) => {
      const r = d.data()
      if (!r.isCompleted && isDueToday(r.dueDate)) due.push({ label: `🔔 ${r.title}` })
    })

    const today = new Date().toISOString().split('T')[0]
    const eventsSnap = await db.collection('families').doc(familyId).collection('events').get()
    eventsSnap.forEach((d) => {
      const e = d.data()
      if (typeof e.start === 'string' && e.start.split('T')[0] === today) {
        due.push({ label: `📅 ${e.title}` })
      }
    })

    const choresSnap = await db.collection('families').doc(familyId).collection('chores').get()
    choresSnap.forEach((d) => {
      const c = d.data()
      if (c.lastCompletedDate !== today) due.push({ label: `🧹 ${c.name}` })
    })

    if (due.length === 0) continue

    // Collect this family's device tokens.
    const tokensSnap = await db.collection('families').doc(familyId).collection('pushTokens').get()
    const tokens = tokensSnap.docs.map((d) => d.data().token as string).filter(Boolean)
    if (tokens.length === 0) continue

    const body = due.slice(0, 5).map((d) => d.label).join('\n') +
      (due.length > 5 ? `\n…and ${due.length - 5} more` : '')

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: `Today's Family Agenda (${due.length})`,
        body,
      },
      webpush: {
        fcmOptions: { link: '/dashboard' },
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
