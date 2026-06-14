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
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)' }}>
      {/* Orbs */}
      <div className="absolute top-1/3 right-1/4 w-80 h-80 rounded-full opacity-20 blur-3xl animate-float pointer-events-none"
        style={{ background: 'radial-gradient(circle, #6366f1, transparent)' }} />
      <div className="absolute bottom-1/3 left-1/4 w-64 h-64 rounded-full opacity-15 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #3b82f6, transparent)', animation: 'float 4s ease-in-out 1.5s infinite' }} />

      <div className="relative z-10 w-full max-w-sm animate-scale-in">
        <div className="rounded-3xl p-8 text-center" style={{
          background: 'rgba(255,255,255,0.06)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 32px 64px rgba(0,0,0,0.4)',
        }}>
          <div className="inline-flex w-14 h-14 rounded-2xl items-center justify-center mb-4 shadow-float"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' }}>
            <span className="text-2xl">🏠</span>
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Set Up Your Family</h1>
          <p className="text-slate-400 text-sm mb-8">
            Create a new family space or join an existing one with an invite code.
          </p>

          {mode === 'choose' && (
            <div className="space-y-3">
              <button onClick={() => setMode('create')}
                className="w-full py-3.5 px-4 rounded-xl font-semibold text-sm transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: 'white', boxShadow: '0 4px 12px rgba(59,130,246,0.4)' }}>
                Create a New Family
              </button>
              <button onClick={() => setMode('join')}
                className="w-full py-3.5 px-4 rounded-xl font-semibold text-sm transition-all duration-200 text-white hover:bg-white/10"
                style={{ border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.05)' }}>
                Join with Invite Code
              </button>
              <button onClick={signOut} className="text-xs text-slate-600 hover:text-slate-400 mt-2 transition-colors">
                Sign out
              </button>
            </div>
          )}

          {mode === 'create' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                We&apos;ll create your family space and generate an invite code you can share with family members.
              </p>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button onClick={handleCreate} disabled={loading}
                className="w-full py-3.5 px-4 rounded-xl font-semibold text-sm text-white transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-50 disabled:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)', boxShadow: '0 4px 12px rgba(59,130,246,0.4)' }}>
                {loading ? 'Creating...' : 'Create Family Space'}
              </button>
              <button onClick={() => setMode('choose')} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
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
                  className="w-full py-3 px-4 rounded-xl text-center text-xl font-mono tracking-widest transition-all duration-200 text-white placeholder-slate-600 focus:outline-none"
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border: '1.5px solid rgba(255,255,255,0.15)',
                  }}
                  autoFocus
                />
                {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
              </div>
              <button type="submit" disabled={loading || !code.trim()}
                className="w-full py-3.5 px-4 rounded-xl font-semibold text-sm text-white transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-40 disabled:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)', boxShadow: '0 4px 12px rgba(59,130,246,0.4)' }}>
                {loading ? 'Joining...' : 'Join Family'}
              </button>
              <button type="button" onClick={() => setMode('choose')} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                Back
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
