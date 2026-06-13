'use client'

import { useState, useEffect } from 'react'
import {
  collection,
  onSnapshot,
  addDoc,
  setDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'

export function useFirestore<T extends { id: string }>(collectionName: string) {
  const { familyId } = useFamily()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!familyId) {
      setData([])
      setLoading(false)
      return
    }

    const colRef = collection(db, 'families', familyId, collectionName)
    const unsub = onSnapshot(colRef, (snap) => {
      setData(snap.docs.map((d) => ({ id: d.id, ...d.data() } as T)))
      setLoading(false)
    })
    return unsub
  }, [familyId, collectionName])

  async function create(item: Omit<T, 'id'> & { id?: string }): Promise<T> {
    if (!familyId) throw new Error('No family')
    const id = (item as { id?: string }).id ?? generateId()
    const { id: _id, ...rest } = item as T
    const docRef = doc(db, 'families', familyId, collectionName, id)
    await setDoc(docRef, rest)
    return { id, ...rest } as T
  }

  async function update(item: T): Promise<void> {
    if (!familyId) return
    const { id, ...rest } = item
    await setDoc(doc(db, 'families', familyId, collectionName, id), rest)
  }

  async function remove(id: string): Promise<void> {
    if (!familyId) return
    await deleteDoc(doc(db, 'families', familyId, collectionName, id))
  }

  return { data, loading, create, update, remove }
}
