'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '@/lib/firebase'

interface AuthContextType {
  user: User | null
  loading: boolean
  signInError: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signInError: null,
  signIn: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [signInError, setSignInError] = useState<string | null>(null)

  useEffect(() => {
    getRedirectResult(auth).catch((e: Error) => {
      setSignInError(e.message)
      setLoading(false)
    })
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setLoading(false)
    })
    return unsub
  }, [])

  async function signIn() {
    try {
      if (!auth) throw new Error('Firebase not configured — check NEXT_PUBLIC_FIREBASE_* environment variables in Vercel')
      const provider = new GoogleAuthProvider()
      await signInWithRedirect(auth, provider)
    } catch (e: unknown) {
      setSignInError(e instanceof Error ? e.message : 'Sign-in failed')
      setLoading(false)
    }
  }

  async function signOut() {
    await firebaseSignOut(auth)
  }

  return (
    <AuthContext.Provider value={{ user, loading, signInError, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
