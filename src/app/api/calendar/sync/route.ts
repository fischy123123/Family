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

  // A full re-sync re-establishes the time window and re-expands every recurring
  // instance, pruning stale ones. We force it when the caller asks (?full=1) or
  // when the last full sync is older than this — incremental syncTokens are
  // locked to their original absolute window, so without periodic full syncs,
  // recurring-event date changes (and anything past the original window) never
  // propagate.
  const FULL_RESYNC_MS = 2 * 60 * 60 * 1000  // 2 hours
  const forceFull = request.nextUrl.searchParams.get('full') === '1'

  const userSnap = await db.collection('users').doc(uid).get()
  const familyId = userSnap.data()?.familyId
  if (!familyId) return NextResponse.json({ synced: 0, reason: 'no-family' })

  const tokensSnap = await db
    .collection('families').doc(familyId).collection('googleTokens').get()
  if (tokensSnap.empty) return NextResponse.json({ synced: 0, reason: 'no-tokens' })

  // 30-day window, re-anchored to "now" on every full sync so it slides forward.
  const timeMin = new Date().toISOString()
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  let synced = 0
  const syncStart = Date.now()

  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data() as {
      accessToken: string
      refreshToken: string
      email: string
      calSyncTokens?: Record<string, string>
      lastFullSyncAt?: number
    }
    const { accessToken, refreshToken, email } = tokenData
    if (!accessToken || !refreshToken) continue

    // Force a full sync when asked, when we have no tokens yet, or when the last
    // full sync is stale — otherwise use the stored tokens for a cheap delta.
    const fullDue = forceFull
      || !tokenData.calSyncTokens
      || Object.keys(tokenData.calSyncTokens).length === 0
      || (Date.now() - (tokenData.lastFullSyncAt ?? 0) > FULL_RESYNC_MS)
    const storedTokens: Record<string, string> = fullDue ? {} : (tokenData.calSyncTokens ?? {})
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

      // Delete stale / cancelled events
      if (!isIncremental) {
        // Full sync: delete events that are no longer in the Google response —
        // scoped to the CALENDARS we actually fetched (not the owner's login
        // email). A recurring event on a shared/family calendar has a different
        // owner id, so the old (email-scoped) filter never pruned its stale
        // instances after a date change. Scoping by calendarId fixes that and
        // still can't touch another member's calendars (we only fetched ours).
        const fetchedCals = new Set(delta.fetchedCalendarIds)
        const freshIds = new Set(delta.upserted.map((e) => e.id))
        const oldSnap = await eventsCol.where('source', '==', 'google').get()
        const stale = oldSnap.docs.filter((d) => {
          const cid = (d.data() as CalendarEvent).calendarId
          return cid && fetchedCals.has(cid) && !freshIds.has(d.id)
        })
        for (let i = 0; i < stale.length; i += BATCH_LIMIT) {
          const batch = db.batch()
          stale.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref))
          await batch.commit()
        }
      } else {
        // Incremental: delete only the events Google marked as cancelled
        for (let i = 0; i < delta.deletedIds.length; i += BATCH_LIMIT) {
          const batch = db.batch()
          delta.deletedIds.slice(i, i + BATCH_LIMIT).forEach((id) => batch.delete(eventsCol.doc(id)))
          await batch.commit()
        }
      }

      // Upsert new/modified events with merge:true so custom fields (forIds,
      // assigneeId) on existing docs are never overwritten — those fields are not
      // present in the Google Calendar API response, so a merge leaves them intact.
      const upserted: CalendarEvent[] = delta.upserted.map((e) => ({
        ...e,
        ownerEmail: e.ownerEmail || email,
        source: 'google',
      }))
      for (let i = 0; i < upserted.length; i += BATCH_LIMIT) {
        const batch = db.batch()
        upserted.slice(i, i + BATCH_LIMIT).forEach((e) => {
          batch.set(eventsCol.doc(e.id), e, { merge: true })
        })
        await batch.commit()
      }

      // Persist updated syncTokens so next run is incremental; stamp the full
      // sync time so the periodic re-sync window slides forward.
      const tokenUpdate: Record<string, unknown> = { calSyncTokens: delta.syncTokensByCalendar }
      if (fullDue) tokenUpdate.lastFullSyncAt = Date.now()
      await tokenDoc.ref.update(tokenUpdate)

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
