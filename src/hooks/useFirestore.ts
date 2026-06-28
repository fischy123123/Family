'use client'

import { useState, useEffect } from 'react'
import {
  collection,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'

// Recursively drop `undefined` values — Firestore rejects them, including when
// they're nested inside arrays/maps (e.g. an optional field on a plan item
// inside the `items` array). Only plain objects/arrays are recursed into;
// class instances (FieldValue like deleteField(), Timestamp, Date) are left
// intact so sentinels keep working.
function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStrip)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = deepStrip(v)
    }
    return out
  }
  return value
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return deepStrip(obj) as Record<string, unknown>
}

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
    await setDoc(docRef, stripUndefined(rest as Record<string, unknown>))
    return { id, ...rest } as T
  }

  async function update(item: T): Promise<void> {
    if (!familyId) return
    const { id, ...rest } = item
    await updateDoc(doc(db, 'families', familyId, collectionName, id), stripUndefined(rest as Record<string, unknown>))
  }

  async function remove(id: string): Promise<void> {
    if (!familyId) return
    await deleteDoc(doc(db, 'families', familyId, collectionName, id))
  }

  return { data, loading, create, update, remove }
}
