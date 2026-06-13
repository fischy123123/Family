'use client'

export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFamily } from '@/contexts/FamilyContext'
import { useAuth } from '@/contexts/AuthContext'

export default function SetupPage() {
  const { createFamily, joinFamily } = useFamily()
  const { signOut } = useAuth()
  const router = useRouter()
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    setLoading(true)
    setError('')
    try {
      await createFamily()
      router.replace('/onboarding')
    } catch (e) {
      setError('Something went wrong. Check your Firebase config and try again.')
      setLoading(false)
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    if (!code.trim()) return
    setLoading(true)
    setError('')
    try {
      const ok = await joinFamily(code.trim())
      if (!ok) {
        setError('No family found with that code. Check with your family member.')
        setLoading(false)
      } else {
        router.replace('/dashboard')
      }
    } catch (e) {
      setError('Something went wrong. Check your Firebase config and try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm text-center">
        <div className="text-5xl mb-4">🏠</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Set Up Your Family</h1>
        <p className="text-gray-500 text-sm mb-8">
          Create a new family space or join an existing one with an invite code.
        </p>

        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => setMode('create')}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            >
              Create a New Family
            </button>
            <button
              onClick={() => setMode('join')}
              className="w-full py-3 px-4 bg-white border border-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
            >
              Join with Invite Code
            </button>
            <button onClick={signOut} className="text-xs text-gray-400 hover:text-gray-600 mt-2">
              Sign out
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              We&apos;ll create your family space and generate an invite code you can share with family members.
            </p>
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating...' : 'Create Family Space'}
            </button>
            <button onClick={() => setMode('choose')} className="text-sm text-gray-400 hover:text-gray-600">
              Back
            </button>
          </div>
        )}

        {mode === 'join' && (
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <input
                type="text"
                placeholder="Enter invite code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={6}
                className="w-full py-3 px-4 border border-gray-200 rounded-xl text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              {error && <p className="text-red-500 text-xs mt-2">{error}</p>}
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Joining...' : 'Join Family'}
            </button>
            <button type="button" onClick={() => setMode('choose')} className="text-sm text-gray-400 hover:text-gray-600">
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
