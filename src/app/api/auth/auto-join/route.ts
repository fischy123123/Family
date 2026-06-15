import { NextRequest, NextResponse } from 'next/server'
import { getAdminApp } from '@/lib/firebaseAdmin'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

export const dynamic = 'force-dynamic'

// Called by FamilyContext when a signed-in user has no familyId yet.
// Searches for a family member doc whose email matches the user's verified email.
// If found, links the user to that family (writes users/{uid}.familyId and
// adds their UID to families/{familyId}.members) so they skip invite-code setup.
export async function POST(request: NextRequest) {
  const adminApp = getAdminApp()
  if (!adminApp) {
    return NextResponse.json({ familyId: null, reason: 'admin-not-configured' })
  }

  const idToken = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!idToken) {
    return NextResponse.json({ familyId: null, reason: 'no-token' }, { status: 401 })
  }

  let uid: string
  let email: string
  try {
    const decoded = await getAuth(adminApp).verifyIdToken(idToken)
    uid = decoded.uid
    email = decoded.email ?? ''
  } catch {
    return NextResponse.json({ familyId: null, reason: 'invalid-token' }, { status: 401 })
  }

  if (!email) {
    return NextResponse.json({ familyId: null, reason: 'no-email' })
  }

  const db = getFirestore(adminApp)

  // Search all members subcollections for a doc with this email.
  const snap = await db.collectionGroup('members').where('email', '==', email).limit(1).get()
  if (snap.empty) {
    return NextResponse.json({ familyId: null, reason: 'not-found' })
  }

  // Extract the familyId from the member doc path: families/{familyId}/members/{memberId}
  const memberRef = snap.docs[0].ref
  const familyId = memberRef.parent.parent?.id
  if (!familyId) {
    return NextResponse.json({ familyId: null, reason: 'bad-path' })
  }

  // Link the user to this family in a batch:
  // 1. Write users/{uid}.familyId
  // 2. Add their UID to families/{familyId}.members so Firestore rules let them in
  const batch = db.batch()
  batch.set(db.collection('users').doc(uid), { familyId }, { merge: true })
  batch.update(db.collection('families').doc(familyId), {
    members: FieldValue.arrayUnion(uid),
  })
  await batch.commit()

  return NextResponse.json({ familyId })
}
