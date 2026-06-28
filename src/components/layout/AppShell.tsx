'use client'

import { useState, useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { MomentCoachSheet } from '@/components/coach/MomentCoachSheet'
import { useCapture } from '@/contexts/CaptureContext'

export function AppShell({ children }: { children: React.ReactNode }) {
  // isOpen still matters: the Capture modal is opened from in-app affordances
  // (recommendations, quick notes), so we hide the FAB while it's up.
  const { isOpen } = useCapture()
  const [coachOpen, setCoachOpen] = useState(false)

  // Let any screen open the "Right now" coach (e.g. the Day Planner's "get a
  // nudge" button) without prop-drilling — they dispatch a window event.
  useEffect(() => {
    const openCoach = () => setCoachOpen(true)
    window.addEventListener('open-moment-coach', openCoach)
    return () => window.removeEventListener('open-moment-coach', openCoach)
  }, [])

  // Hide the floating button whenever any overlay is up, so it can't be
  // tapped through a backdrop on mobile.
  const overlayUp = isOpen || coachOpen

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 overflow-auto pb-36 sm:pb-0 min-h-screen">
        {children}
      </main>

      {/* Global "Right now" FAB — one-tap access to the coach from any screen,
          for the moments you're stuck and don't want to navigate. */}
      {!overlayUp && (
        <button
          onClick={() => setCoachOpen(true)}
          aria-label="Right now"
          className="fixed z-50 bottom-24 sm:bottom-8 right-5 inline-flex items-center gap-1.5 pl-3 pr-4 h-12 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white font-semibold text-sm shadow-float hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 active:translate-y-0"
          style={{ boxShadow: '0 12px 28px rgba(99,102,241,0.45)' }}
        >
          <Sparkles size={18} strokeWidth={2.5} />
          Right now
        </button>
      )}

      <MomentCoachSheet open={coachOpen} onClose={() => setCoachOpen(false)} />

      <MobileNav />
    </div>
  )
}
