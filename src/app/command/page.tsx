'use client'

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { AppShell } from '@/components/layout/AppShell'
import { CommandCenter } from '@/components/command/CommandCenter'

export default function CommandPage() {
  const { user, loading } = useAuth()
  const { familyId } = useFamily()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  useEffect(() => {
    if (!loading && !user) router.replace('/signin')
  }, [user, loading, router])

  // Handle Google OAuth redirect
  useEffect(() => {
    const status = searchParams.get('google')
    if (!status) return
    if (!user?.email || !familyId) return

    if (status === 'connected') {
      fetch('/api/auth/google/tokens')
        .then((r) => r.json())
        .then(async ({ tokens }) => {
          if (tokens?.access_token) {
            const { doc, setDoc } = await import('firebase/firestore')
            const { db } = await import('@/lib/firebase')
            await setDoc(doc(db, 'families', familyId, 'googleTokens', user.email!), {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiryDate: tokens.expiry_date ?? Date.now() + 3600 * 1000,
              email: user.email,
            })
            toast('Google Calendar connected!', 'success')
          }
          router.replace('/command')
        })
        .catch(() => router.replace('/command'))
    } else if (status === 'error') {
      toast('Could not connect Google Calendar', 'error')
      router.replace('/command')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, user, familyId])

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <AppShell>
      <CommandCenter />
    </AppShell>
  )
}
