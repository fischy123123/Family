'use client'

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { Calendar, Brain, Users } from 'lucide-react'

export default function SignInPage() {
  const { user, loading, signIn, signInError } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && user) router.replace('/')
  }, [user, loading, router])

  return (
    <div
      className="min-h-screen relative overflow-hidden flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)' }}
    >
      {/* Ambient orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-20 blur-3xl animate-float pointer-events-none"
        style={{ background: 'radial-gradient(circle, #3b82f6, transparent)' }} />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full opacity-15 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #8b5cf6, transparent)', animation: 'float 4s ease-in-out 1s infinite' }} />
      <div className="absolute top-3/4 left-1/2 w-64 h-64 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #06b6d4, transparent)', animation: 'float 5s ease-in-out 2s infinite' }} />

      {/* Card */}
      <div className="relative z-10 w-full max-w-sm animate-scale-in">
        <div className="rounded-3xl p-8" style={{
          background: 'rgba(255,255,255,0.06)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 32px 64px rgba(0,0,0,0.4)',
        }}>
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex w-16 h-16 rounded-2xl items-center justify-center mb-4 shadow-float"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' }}>
              <span className="text-3xl">🏠</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">Family Command Center</h1>
            <p className="text-slate-400 text-sm">Your family&apos;s intelligent hub</p>
          </div>

          {/* Features */}
          <div className="space-y-2.5 mb-8">
            {[
              { icon: Calendar, label: 'Google Calendar sync', sub: 'See all your real events in one place' },
              { icon: Brain, label: 'AI family assistant', sub: 'Talk to it — it takes action for you' },
              { icon: Users, label: 'Shared family space', sub: 'Invite code for instant family join' },
            ].map(({ icon: Icon, label, sub }) => (
              <div key={label} className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                  <Icon size={15} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{label}</p>
                  <p className="text-xs text-slate-500">{sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Google sign-in */}
          <button
            onClick={signIn}
            className="w-full flex items-center justify-center gap-3 bg-white rounded-xl py-3.5 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all duration-200 shadow-elevated hover:-translate-y-0.5 hover:shadow-float active:translate-y-0"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {signInError && (
            <p className="text-xs text-red-400 text-center mt-3 bg-red-500/10 rounded-lg px-3 py-2 break-all">
              {signInError}
            </p>
          )}

          {/* Temporary debug panel — remove once auth is working */}
          <div className="mt-4 rounded-lg p-3 text-left text-[10px] font-mono text-slate-500 border border-white/5" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <p>loading: {String(loading)}</p>
            <p>user: {user ? user.email : 'null'}</p>
            <p>error: {signInError ?? 'none'}</p>
          </div>

          <p className="text-xs text-slate-600 text-center mt-4">
            Your data is private and secure. No subscriptions.
          </p>
        </div>
      </div>
    </div>
  )
}
