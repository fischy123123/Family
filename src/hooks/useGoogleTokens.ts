'use client'
import { useState, useEffect } from 'react'
import { doc, setDoc, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'

export interface GoogleTokens {
  accessToken: string
  refreshToken: string
  expiryDate: number
  email: string
}

export function useGoogleTokens() {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const [tokens, setTokens] = useState<GoogleTokens | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!familyId || !user?.email) { setLoading(false); return }
    const ref = doc(db, 'families', familyId, 'googleTokens', user.email)
    const unsub = onSnapshot(ref, (snap) => {
      setTokens(snap.exists() ? snap.data() as GoogleTokens : null)
      setLoading(false)
    })
    return unsub
  }, [familyId, user?.email])

  async function saveTokens(raw: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }) {
    if (!familyId || !user?.email || !raw.access_token || !raw.refresh_token) return
    const data: GoogleTokens = {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiryDate: raw.expiry_date ?? Date.now() + 3600 * 1000,
      email: user.email,
    }
    await setDoc(doc(db, 'families', familyId, 'googleTokens', user.email), data)
    setTokens(data)
  }

  async function getFreshTokens(): Promise<GoogleTokens | null> {
    if (!tokens) return null
    // If token is still valid (5 min buffer), return as-is
    if (tokens.expiryDate && Date.now() < tokens.expiryDate - 5 * 60 * 1000) return tokens
    // Refresh
    try {
      const res = await fetch('/api/auth/google/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      })
      if (!res.ok) return null
      const { accessToken, expiryDate } = await res.json()
      const updated = { ...tokens, accessToken, expiryDate }
      if (familyId && user?.email) {
        await setDoc(doc(db, 'families', familyId, 'googleTokens', user.email), updated)
      }
      setTokens(updated)
      return updated
    } catch {
      return null
    }
  }

  return { tokens, loading, saveTokens, getFreshTokens, isConnected: !!tokens?.refreshToken }
}
