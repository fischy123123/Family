'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { doc, getDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from './AuthContext'

interface FamilyContextType {
  familyId: string | null
  inviteCode: string | null
  loading: boolean
  createFamily: () => Promise<void>
  joinFamily: (code: string) => Promise<boolean>
}

const FamilyContext = createContext<FamilyContextType>({
  familyId: null,
  inviteCode: null,
  loading: true,
  createFamily: async () => {},
  joinFamily: async () => false,
})

function randomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

export function FamilyProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setFamilyId(null)
      setLoading(false)
      return
    }

    const userDocRef = doc(db, 'users', user.uid)
    getDoc(userDocRef).then((snap) => {
      if (snap.exists() && snap.data().familyId) {
        const fid = snap.data().familyId
        setFamilyId(fid)
        // Load invite code
        getDoc(doc(db, 'families', fid)).then((fsnap) => {
          if (fsnap.exists()) setInviteCode(fsnap.data().inviteCode ?? null)
        })
      }
      setLoading(false)
    })
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

  return (
    <FamilyContext.Provider value={{ familyId, inviteCode, loading, createFamily, joinFamily }}>
      {children}
    </FamilyContext.Provider>
  )
}

export function useFamily() {
  return useContext(FamilyContext)
}
