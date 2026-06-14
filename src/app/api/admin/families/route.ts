import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { isAdminEmail } from '@/lib/admin'

export const dynamic = 'force-dynamic'

const SUBCOLLECTIONS = [
  'members', 'events', 'tasks', 'chores', 'plans', 'lists',
  'eventContext', 'shopping_lists', 'meal_plans', 'reminders', 'templates',
]

// Verify the caller's Firebase ID token and confirm they're an admin.
async function requireAdmin(
  request: NextRequest,
  adminApp: import('firebase-admin/app').App,
): Promise<{ ok: true; email: string } | { ok: false; res: NextResponse }> {
  const idToken = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!idToken) {
    return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  try {
    const decoded = await getAuth(adminApp).verifyIdToken(idToken)
    if (!isAdminEmail(decoded.email, process.env.ADMIN_EMAILS)) {
      return { ok: false, res: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
    }
    return { ok: true, email: decoded.email ?? '' }
  } catch {
    return { ok: false, res: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }
}

async function deleteCollection(db: FirebaseFirestore.Firestore, path: string) {
  const snap = await db.collection(path).limit(300).get()
  if (snap.empty) return
  const batch = db.batch()
  snap.docs.forEach((d) => batch.delete(d.ref))
  await batch.commit()
  if (snap.size === 300) await deleteCollection(db, path)
}

async function purgeFamily(db: FirebaseFirestore.Firestore, familyId: string) {
  for (const col of SUBCOLLECTIONS) {
    await deleteCollection(db, `families/${familyId}/${col}`)
  }
  await db.collection('families').doc(familyId).delete()
}

// GET — list every family with summary info
export async function GET(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ error: 'Server not configured for admin operations' }, { status: 500 })
  }
  const gate = await requireAdmin(request, adminApp)
  if (!gate.ok) return gate.res

  const db = getFirestore(adminApp)
  const snap = await db.collection('families').get()
  const families = snap.docs.map((d) => {
    const data = d.data()
    return {
      id: d.id,
      memberCount: Array.isArray(data.members) ? data.members.length : 0,
      members: Array.isArray(data.members) ? data.members : [],
      createdBy: data.createdBy ?? null,
      createdAt: data.createdAt ?? null,
      inviteCode: data.inviteCode ?? null,
    }
  })
  // Newest first when createdAt is present
  families.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))

  return NextResponse.json({ families })
}

// POST — purge a single family ({ familyId }) or all families ({ all: true })
export async function POST(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ error: 'Server not configured for admin operations' }, { status: 500 })
  }
  const gate = await requireAdmin(request, adminApp)
  if (!gate.ok) return gate.res

  const body = (await request.json().catch(() => ({}))) as { familyId?: string; all?: boolean }
  const db = getFirestore(adminApp)

  // Determine which families to purge
  let targetIds: string[]
  if (body.all) {
    const snap = await db.collection('families').get()
    targetIds = snap.docs.map((d) => d.id)
  } else if (body.familyId) {
    targetIds = [body.familyId]
  } else {
    return NextResponse.json({ error: 'Provide familyId or all:true' }, { status: 400 })
  }

  for (const fid of targetIds) {
    await purgeFamily(db, fid)
  }

  // Clear familyId pointers on any user docs that referenced a purged family
  const purged = new Set(targetIds)
  const usersSnap = await db.collection('users').get()
  const updates = usersSnap.docs.filter((u) => purged.has(u.data()?.familyId))
  await Promise.all(
    updates.map((u) => u.ref.set({ familyId: null }, { merge: true })),
  )

  return NextResponse.json({ ok: true, purged: targetIds.length, usersDetached: updates.length })
}
