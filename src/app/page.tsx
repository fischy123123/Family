'use client'

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'

export default function RootPage() {
  const { user, loading: authLoading } = useAuth()
  const { familyId, loading: familyLoading, loadError } = useFamily()
  const router = useRouter()

  useEffect(() => {
    if (authLoading || familyLoading) return
    if (!user) { router.replace('/signin'); return }
    // If there was a load error, stay on this page and show the error.
    if (loadError) return
    if (!familyId) { router.replace('/setup'); return }
    router.replace('/command')
  }, [user, familyId, authLoading, familyLoading, loadError, router])

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-slate-900">
        <div className="text-4xl">⚠️</div>
        <h1 className="text-lg font-semibold text-white">Could not load your family data</h1>
        <p className="text-slate-400 text-sm text-center max-w-xs">
          {loadError}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white"
          style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
