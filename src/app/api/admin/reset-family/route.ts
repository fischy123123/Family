import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

export const dynamic = 'force-dynamic'

const SUBCOLLECTIONS = [
  'members', 'events', 'tasks', 'chores', 'plans', 'lists',
  'eventContext', 'shopping_lists', 'meal_plans', 'reminders', 'templates',
]

async function deleteCollection(
  db: FirebaseFirestore.Firestore,
  path: string
) {
  const snap = await db.collection(path).limit(200).get()
  if (snap.empty) return
  const batch = db.batch()
  snap.docs.forEach((d) => batch.delete(d.ref))
  await batch.commit()
  if (snap.size === 200) await deleteCollection(db, path)
}

export async function POST(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ error: 'Server not configured for admin operations' }, { status: 500 })
  }

  // Verify the caller's Firebase ID token
  const authHeader = request.headers.get('Authorization')
  const idToken = authHeader?.replace('Bearer ', '')
  if (!idToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let uid: string
  try {
    const decoded = await getAuth(adminApp).verifyIdToken(idToken)
    uid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const db = getFirestore(adminApp)

  // Read the user's familyId
  const userDoc = await db.collection('users').doc(uid).get()
  const familyId = userDoc.data()?.familyId
  if (!familyId) {
    return NextResponse.json({ ok: true, message: 'No family to delete' })
  }

  // Verify this user is actually a member of the family
  const familyDoc = await db.collection('families').doc(familyId).get()
  if (!familyDoc.exists) {
    // Family doc gone — just clear the user pointer
    await db.collection('users').doc(uid).set({ familyId: null }, { merge: true })
    return NextResponse.json({ ok: true })
  }
  const members: string[] = familyDoc.data()?.members ?? []
  if (!members.includes(uid)) {
    return NextResponse.json({ error: 'Not a member of this family' }, { status: 403 })
  }

  // Delete all subcollections
  for (const col of SUBCOLLECTIONS) {
    await deleteCollection(db, `families/${familyId}/${col}`)
  }

  // Delete the family document itself
  await db.collection('families').doc(familyId).delete()

  // Clear familyId from all members' user docs
  await Promise.all(
    members.map((memberId) =>
      db.collection('users').doc(memberId).set({ familyId: null }, { merge: true })
    )
  )

  return NextResponse.json({ ok: true })
}
