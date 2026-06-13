'use client'

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'

export default function RootPage() {
  const { user, loading: authLoading } = useAuth()
  const { familyId, loading: familyLoading } = useFamily()
  const router = useRouter()

  useEffect(() => {
    if (authLoading || familyLoading) return
    if (!user) { router.replace('/signin'); return }
    if (!familyId) { router.replace('/setup'); return }
    router.replace('/dashboard')
  }, [user, familyId, authLoading, familyLoading, router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
