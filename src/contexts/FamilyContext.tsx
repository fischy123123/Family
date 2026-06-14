'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from './AuthContext'

interface FamilyContextType {
  familyId: string | null
  inviteCode: string | null
  loading: boolean
  loadError: string | null
  createFamily: () => Promise<void>
  joinFamily: (code: string) => Promise<boolean>
  resetFamily: () => Promise<void>
  deleteFamily: () => Promise<void>
}

const FamilyContext = createContext<FamilyContextType>({
  familyId: null,
  inviteCode: null,
  loading: true,
  loadError: null,
  createFamily: async () => {},
  joinFamily: async () => false,
  resetFamily: async () => {},
  deleteFamily: async () => {},
})

// Subcollections under families/{id} that hold family data.
const FAMILY_SUBCOLLECTIONS = [
  'members', 'events', 'tasks', 'chores', 'plans', 'lists',
  'eventContext', 'shopping_lists', 'meal_plans', 'reminders', 'templates',
]

function randomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

export function FamilyProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setFamilyId(null)
      setLoadError(null)
      setLoading(false)
      return
    }

    let cancelled = false

    // Retry the lookup a few times: in Safari/Firefox the first Firestore
    // request can fail under storage partitioning. We must NOT treat a failed
    // read as "no family" — that wrongly sends an existing user to setup.
    async function loadFamily(attempt = 0): Promise<void> {
      try {
        const snap = await getDoc(doc(db, 'users', user!.uid))
        if (cancelled) return
        if (snap.exists() && snap.data().familyId) {
          const fid = snap.data().familyId
          setFamilyId(fid)
          setLoadError(null)
          try {
            const fsnap = await getDoc(doc(db, 'families', fid))
            if (!cancelled && fsnap.exists()) setInviteCode(fsnap.data().inviteCode ?? null)
          } catch {
            // Non-fatal: invite code unavailable but family ID is set
          }
        }
        if (!cancelled) setLoading(false)
      } catch (err) {
        console.error('Firestore family lookup failed (attempt ' + attempt + '):', err)
        if (cancelled) return
        if (attempt < 3) {
          setTimeout(() => loadFamily(attempt + 1), 800 * (attempt + 1))
        } else {
          // After all retries, surface the error but do NOT redirect to setup —
          // that would destroy the user's existing family data.
          const msg = err instanceof Error ? err.message : 'Could not load family data. Check your connection and refresh.'
          setLoadError(msg)
          setLoading(false)
        }
      }
    }

    loadFamily()
    return () => { cancelled = true }
  }, [user])

  async function createFamily() {
    if (!user) return
    const code = randomCode()
    const familyRef = doc(collection(db, 'families'))
    await setDoc(familyRef, {
      createdBy: user.uid,
      createdAt: new Date().toISOString(),
      inviteCode: code,
      members: [user.uid],
    })
    await setDoc(doc(db, 'users', user.uid), { familyId: familyRef.id }, { merge: true })
    setFamilyId(familyRef.id)
    setInviteCode(code)
  }

  async function joinFamily(code: string): Promise<boolean> {
    if (!user) return false
    const q = query(collection(db, 'families'), where('inviteCode', '==', code.toUpperCase()))
    const snap = await getDocs(q)
    if (snap.empty) return false
    const familyDoc = snap.docs[0]
    await setDoc(familyDoc.ref, { members: [...(familyDoc.data().members ?? []), user.uid] }, { merge: true })
    await setDoc(doc(db, 'users', user.uid), { familyId: familyDoc.id }, { merge: true })
    setFamilyId(familyDoc.id)
    setInviteCode(familyDoc.data().inviteCode)
    return true
  }

  // Detaches user from their current family (does not delete family data).
  // Use this to re-run onboarding without touching other family members' data.
  async function resetFamily(): Promise<void> {
    if (!user) return
    await setDoc(doc(db, 'users', user.uid), { familyId: null }, { merge: true })
    setFamilyId(null)
    setInviteCode(null)
  }

  // Fully deletes the current family's data from the browser using the client
  // SDK. The signed-in user has permission (per Firestore rules) to delete their
  // own family's subcollections and the family doc. This is the reliable
  // fallback when the server-side admin endpoint is unavailable. Note: it can
  // only clear THIS user's familyId pointer — other members' pointers require
  // the admin endpoint. Sufficient for re-running onboarding.
  async function deleteFamily(): Promise<void> {
    if (!user) return
    const fid = familyId
    if (fid) {
      for (const c of FAMILY_SUBCOLLECTIONS) {
        try {
          const snap = await getDocs(collection(db, 'families', fid, c))
          await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)))
        } catch (e) {
          console.error('Failed to clear subcollection', c, e)
        }
      }
      try {
        await deleteDoc(doc(db, 'families', fid))
      } catch (e) {
        console.error('Failed to delete family doc', e)
      }
    }
    await setDoc(doc(db, 'users', user.uid), { familyId: null }, { merge: true })
    setFamilyId(null)
    setInviteCode(null)
  }

  return (
    <FamilyContext.Provider value={{ familyId, inviteCode, loading, loadError, createFamily, joinFamily, resetFamily, deleteFamily }}>
      {children}
    </FamilyContext.Provider>
  )
}

export function useFamily() {
  return useContext(FamilyContext)
}
