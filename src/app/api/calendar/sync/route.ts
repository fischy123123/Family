import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getEvents } from '@/lib/google/calendar'
import type { CalendarEvent } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Syncs Google Calendar events for all connected family members to Firestore.
// Called on app load by any signed-in user so calendar data stays fresh even
// when some family members haven't opened the app recently.
export async function POST(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ synced: 0, reason: 'admin-not-configured' })
  }

  const idToken = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!idToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    const decoded = await getAuth(adminApp).verifyIdToken(idToken)
    uid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const db = getFirestore(adminApp)

  // Resolve familyId for this user
  const userSnap = await db.collection('users').doc(uid).get()
  const familyId = userSnap.data()?.familyId
  if (!familyId) return NextResponse.json({ synced: 0, reason: 'no-family' })

  // Read all stored Google tokens for this family
  const tokensSnap = await db.collection('families').doc(familyId).collection('googleTokens').get()
  if (tokensSnap.empty) return NextResponse.json({ synced: 0, reason: 'no-tokens' })

  const timeMin = new Date().toISOString()
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  let synced = 0
  const syncStart = Date.now()

  for (const tokenDoc of tokensSnap.docs) {
    const { accessToken, refreshToken, email } = tokenDoc.data() as {
      accessToken: string; refreshToken: string; email: string
    }
    if (!accessToken || !refreshToken) continue

    try {
      const memberStart = Date.now()
      const rawEvents = await getEvents(accessToken, refreshToken, timeMin, timeMax)
      const events: CalendarEvent[] = rawEvents.map((e) => ({
        ...e,
        ownerEmail: e.ownerEmail || email,
      }))

      // Replace this owner's google-sourced events atomically
      const eventsCol = db.collection('families').doc(familyId).collection('events')
      const oldSnap = await eventsCol
        .where('ownerEmail', '==', email)
        .where('source', '==', 'google')
        .get()

      const BATCH_LIMIT = 490
      // Delete old events
      for (let i = 0; i < oldSnap.docs.length; i += BATCH_LIMIT) {
        const batch = db.batch()
        oldSnap.docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref))
        await batch.commit()
      }
      // Write new events
      for (let i = 0; i < events.length; i += BATCH_LIMIT) {
        const batch = db.batch()
        events.slice(i, i + BATCH_LIMIT).forEach((e) => {
          batch.set(eventsCol.doc(e.id), { ...e, source: 'google' })
        })
        await batch.commit()
      }

      // Update the stored access token if it was refreshed
      // (getEvents may have refreshed it internally — we can't detect that here,
      // but the refresh endpoint handles token rotation on the client side)

      console.log(`[perf/sync] user=${email} gcal=${Date.now() - memberStart}ms events=${rawEvents.length}`)
      synced++
    } catch (err) {
      // One member's token failing shouldn't block others
      console.error(`Calendar sync failed for ${email}:`, err)
    }
  }

  console.log(`[perf/sync] total=${Date.now() - syncStart}ms members=${tokensSnap.docs.length} synced=${synced}`)
  return NextResponse.json({ synced })
}
