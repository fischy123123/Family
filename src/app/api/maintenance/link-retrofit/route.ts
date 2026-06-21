import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'

// ---------------------------------------------------------------------------
// Deterministic provenance-link retrofit (Tier 1 + Tier 2).
//
// Connects EXISTING reminders/tasks to the calendar event they prepare for —
// but ONLY when the match is certain, never by guessing. A link is written
// only when exactly ONE event satisfies ALL of:
//   1. same calendar day  (item.dueDate date === event.start date)
//   2. shared significant title word  (e.g. "recital", "dentist")
//   3. compatible people  (if both name a person, they must overlap)
// If zero events match → left alone. If more than one → reported as ambiguous
// and left alone (that's Tier 3 / inference territory, which we don't touch).
//
// Idempotent: items that already have a relatedEventId are skipped.
//
// POST { familyId, dryRun?: boolean } → { linked, ambiguous, skipped, scanned, breakdown }
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'about',
  'appointment', 'appt', 'meeting', 'event', 'reminder', 'task', 'plan',
  'buy', 'get', 'pick', 'drop', 'take', 'bring', 'call', 'book', 'prep',
])

function significantTokens(s: string | undefined): Set<string> {
  const matches = (s ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
  return new Set(matches.filter((t) => !STOPWORDS.has(t)))
}

function dayKey(iso: string | undefined): string | null {
  if (!iso) return null
  const trimmed = iso.trim()
  // Date-only or datetime — take the leading YYYY-MM-DD.
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  const d = new Date(trimmed)
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]
}

// Collect the set of member identifiers a record concerns (ids + emails).
function peopleKeys(r: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  const forIds = r.forIds as string[] | undefined
  forIds?.forEach((id) => out.add(id.toLowerCase()))
  if (r.assigneeId) out.add(String(r.assigneeId).toLowerCase())
  if (r.assigneeEmail) out.add(String(r.assigneeEmail).toLowerCase())
  return out
}

interface SkipReasons {
  already_linked: number     // already has relatedEventId — nothing to do
  completed: number          // marked done — not worth linking
  no_due_date: number        // no dueDate field — can't match by day
  no_keywords: number        // title words all filtered by stopwords/length
  no_event_that_day: number  // has due date but no calendar event on that day
  no_keyword_match: number   // event on same day but no shared significant word
  people_mismatch: number    // keyword matched but people don't overlap
  ambiguous: number          // multiple events match — left for Copilot
}

export async function POST(request: NextRequest) {
  const { familyId, dryRun } = await request.json()
  if (!familyId) {
    return NextResponse.json({ error: 'familyId is required' }, { status: 400 })
  }

  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ error: 'Firestore admin not configured' }, { status: 500 })
  }
  const db = getFirestore(adminApp)
  const fam = db.collection('families').doc(familyId)

  // Load the data we need.
  const [eventsSnap, remindersSnap, tasksSnap] = await Promise.all([
    fam.collection('events').get(),
    fam.collection('reminders').get(),
    fam.collection('tasks').get(),
  ])

  type Doc = { id: string; [k: string]: unknown }
  const events: Doc[] = eventsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))

  // Build per-event indexes up front.
  const eventTokens = new Map(events.map((e) => [e.id, significantTokens(e.title as string)]))
  const eventDay = new Map(events.map((e) => [e.id, dayKey(e.start as string)]))
  const eventPeople = new Map(events.map((e) => [e.id, peopleKeys(e)]))

  // Build set of days that have at least one event (for quick pre-filter).
  const daysWithEvents = new Set(Array.from(eventDay.values()).filter(Boolean) as string[])

  const linked: { collection: string; id: string; title: string; eventTitle: string; day: string }[] = []
  const ambiguous: { collection: string; id: string; title: string; candidates: string[] }[] = []
  let scanned = 0

  const reasons: SkipReasons = {
    already_linked: 0,
    completed: 0,
    no_due_date: 0,
    no_keywords: 0,
    no_event_that_day: 0,
    no_keyword_match: 0,
    people_mismatch: 0,
    ambiguous: 0,
  }

  // Process both reminders and capture tasks — both can prepare for an event.
  for (const [collection, snap] of [['reminders', remindersSnap], ['tasks', tasksSnap]] as const) {
    for (const doc of snap.docs) {
      const item = doc.data() as Record<string, unknown>
      scanned++

      // Idempotent.
      if (item.relatedEventId) { reasons.already_linked++; continue }
      // Completed items don't need provenance links.
      if (item.isCompleted) { reasons.completed++; continue }
      // Must have a due date for day-level matching.
      const itemDay = dayKey(item.dueDate as string)
      if (!itemDay) { reasons.no_due_date++; continue }
      // Must have at least one meaningful title word to match against.
      const itemTokens = significantTokens(item.title as string)
      if (itemTokens.size === 0) { reasons.no_keywords++; continue }

      // Quick check: is there any event on this day at all?
      if (!daysWithEvents.has(itemDay)) { reasons.no_event_that_day++; continue }

      const itemPeople = peopleKeys(item)

      // Find every event that satisfies all three deterministic conditions.
      let noKeywordMatch = false
      let peopleMismatch = false

      const candidates = events.filter((e) => {
        if (eventDay.get(e.id) !== itemDay) return false
        const et = eventTokens.get(e.id)!
        const sharesWord = Array.from(itemTokens).some((t) => et.has(t))
        if (!sharesWord) { noKeywordMatch = true; return false }
        const ep = eventPeople.get(e.id)!
        // People compatibility: only enforce when BOTH sides name someone.
        if (itemPeople.size > 0 && ep.size > 0) {
          const overlap = Array.from(itemPeople).some((p) => ep.has(p))
          if (!overlap) { peopleMismatch = true; return false }
        }
        return true
      })

      if (candidates.length === 1) {
        const ev = candidates[0]
        linked.push({
          collection,
          id: doc.id,
          title: item.title as string,
          eventTitle: ev.title as string,
          day: itemDay,
        })
        if (!dryRun) {
          await fam.collection(collection).doc(doc.id).update({ relatedEventId: ev.id })
        }
      } else if (candidates.length > 1) {
        ambiguous.push({
          collection,
          id: doc.id,
          title: item.title as string,
          candidates: candidates.map((c) => c.title as string),
        })
        reasons.ambiguous++
      } else {
        // Attribute the skip to the first blocking condition hit.
        if (peopleMismatch) reasons.people_mismatch++
        else if (noKeywordMatch) reasons.no_keyword_match++
        else reasons.no_event_that_day++
      }
    }
  }

  const skippedCount = Object.values(reasons).reduce((a, b) => a + b, 0)

  console.log(
    `[link-retrofit] family=${familyId} dryRun=${!!dryRun} scanned=${scanned}` +
    ` linked=${linked.length} ambiguous=${reasons.ambiguous} skipped=${skippedCount}` +
    ` events=${events.length}` +
    ` reasons=${JSON.stringify(reasons)}`
  )

  return NextResponse.json({
    dryRun: !!dryRun,
    scanned,
    events: events.length,
    linked,
    ambiguous,
    skippedCount,
    breakdown: reasons,
    summary:
      `Scanned ${scanned} items across ${events.length} events — ` +
      `linked ${linked.length}, ` +
      `${reasons.ambiguous} ambiguous (left for Copilot), ` +
      `${skippedCount} skipped.`,
  })
}
