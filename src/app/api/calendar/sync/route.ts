import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { verifyFirebaseIdToken } from '@/lib/verifyFirebaseToken'
import { getEventsDelta, SyncTokenExpiredError } from '@/lib/google/calendar'
import type { CalendarEvent } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Syncs Google Calendar events for all connected family members to Firestore.
// Uses per-calendar syncTokens so only changed/deleted events are transferred
// after the first full sync — never re-fetches the entire calendar each time.
export async function POST(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ synced: 0, reason: 'admin-not-configured' })
  }

  const idToken = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!idToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    ;({ uid } = await verifyFirebaseIdToken(idToken))
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const db = getFirestore(adminApp)

  const userSnap = await db.collection('users').doc(uid).get()
  const familyId = userSnap.data()?.familyId
  if (!familyId) return NextResponse.json({ synced: 0, reason: 'no-family' })

  const tokensSnap = await db
    .collection('families').doc(familyId).collection('googleTokens').get()
  if (tokensSnap.empty) return NextResponse.json({ synced: 0, reason: 'no-tokens' })

  // 14-day window used only on the first (full) sync per member
  const timeMin = new Date().toISOString()
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  let synced = 0
  const syncStart = Date.now()

  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data() as {
      accessToken: string
      refreshToken: string
      email: string
      calSyncTokens?: Record<string, string>
    }
    const { accessToken, refreshToken, email } = tokenData
    if (!accessToken || !refreshToken) continue

    const storedTokens: Record<string, string> = tokenData.calSyncTokens ?? {}
    const isIncremental = Object.keys(storedTokens).length > 0

    try {
      const memberStart = Date.now()

      let delta = await (async () => {
        try {
          return await getEventsDelta(accessToken, refreshToken, storedTokens, timeMin, timeMax)
        } catch (err) {
          if (err instanceof SyncTokenExpiredError) {
            // Stored tokens are stale — fall back to a full sync
            console.log(`[sync] syncToken expired for ${email}, falling back to full sync`)
            return await getEventsDelta(accessToken, refreshToken, {}, timeMin, timeMax)
          }
          throw err
        }
      })()

      const eventsCol = db.collection('families').doc(familyId).collection('events')
      const BATCH_LIMIT = 490

      if (!isIncremental) {
        // First sync: wipe old google-sourced events for this owner, then insert all
        const oldSnap = await eventsCol
          .where('ownerEmail', '==', email)
          .where('source', '==', 'google')
          .get()
        for (let i = 0; i < oldSnap.docs.length; i += BATCH_LIMIT) {
          const batch = db.batch()
          oldSnap.docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref))
          await batch.commit()
        }
      } else {
        // Incremental: only delete the events Google told us were removed
        for (let i = 0; i < delta.deletedIds.length; i += BATCH_LIMIT) {
          const batch = db.batch()
          delta.deletedIds.slice(i, i + BATCH_LIMIT).forEach((id) => batch.delete(eventsCol.doc(id)))
          await batch.commit()
        }
      }

      // Upsert new/modified events
      const upserted: CalendarEvent[] = delta.upserted.map((e) => ({
        ...e,
        ownerEmail: e.ownerEmail || email,
      }))
      for (let i = 0; i < upserted.length; i += BATCH_LIMIT) {
        const batch = db.batch()
        upserted.slice(i, i + BATCH_LIMIT).forEach((e) => {
          batch.set(eventsCol.doc(e.id), { ...e, source: 'google' })
        })
        await batch.commit()
      }

      // Persist updated syncTokens so next run is incremental
      await tokenDoc.ref.update({ calSyncTokens: delta.syncTokensByCalendar })

      const mode = isIncremental ? 'incremental' : 'full'
      console.log(
        `[perf/sync] user=${email} mode=${mode} gcal=${Date.now() - memberStart}ms` +
        ` upserted=${delta.upserted.length} deleted=${delta.deletedIds.length}`
      )
      synced++
    } catch (err) {
      console.error(`Calendar sync failed for ${email}:`, err)
    }
  }

  console.log(`[perf/sync] total=${Date.now() - syncStart}ms members=${tokensSnap.docs.length} synced=${synced}`)
  return NextResponse.json({ synced })
}
