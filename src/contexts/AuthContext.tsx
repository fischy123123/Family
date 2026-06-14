'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth'
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
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          setUser(result.user)
        } else if (result === null) {
          // No pending redirect — normal page load
        }
      })
      .catch((e: Error) => {
        setSignInError(`Auth error: ${e.code ?? ''} — ${e.message}`)
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
      if (!auth) throw new Error('Firebase not configured — check NEXT_PUBLIC_FIREBASE_* env vars in Vercel')
      const provider = new GoogleAuthProvider()
      provider.addScope('email')
      provider.addScope('profile')
      try {
        // Try popup first — works on mobile Chrome and desktop
        await signInWithPopup(auth, provider)
      } catch (popupError: unknown) {
        const code = (popupError as { code?: string }).code ?? ''
        // Only fall back to redirect if the popup was actually blocked
        if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user') {
          await signInWithRedirect(auth, provider)
        } else {
          throw popupError
        }
      }
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string }
      setSignInError(`${err.code ?? 'error'}: ${err.message ?? 'Sign-in failed'}`)
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
