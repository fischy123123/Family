'use client'

import { useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { MomentCoachSheet } from '@/components/coach/MomentCoachSheet'
import { useCapture } from '@/contexts/CaptureContext'

export function AppShell({ children }: { children: React.ReactNode }) {
  // The global FAB is CAPTURE — the one door into the app for anything in your
  // head. Opened with no arguments it starts empty with the mic ready, which is
  // what makes voice brain-dump (and therefore triggers) reachable at all.
  const { open: openCapture, isOpen } = useCapture()
  const [coachOpen, setCoachOpen] = useState(false)

  // The in-the-moment coach no longer has a global button, but the Day Planner's
  // "get a nudge" still opens it contextually via this window event.
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

      {/* Global Capture FAB — say or type anything from any screen and let the
          app sort it into tasks, events, memories, and "when X, remind me" triggers. */}
      {!overlayUp && (
        <button
          onClick={() => openCapture()}
          aria-label="Capture — say or type anything"
          className="fixed z-50 bottom-24 sm:bottom-8 right-5 inline-flex items-center gap-1.5 pl-3 pr-4 h-12 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 text-white font-semibold text-sm shadow-float hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 active:translate-y-0"
          style={{ boxShadow: '0 12px 28px rgba(79,70,229,0.45)' }}
        >
          <Plus size={18} strokeWidth={2.75} />
          Capture
        </button>
      )}

      <MomentCoachSheet open={coachOpen} onClose={() => setCoachOpen(false)} />

      <MobileNav />
    </div>
  )
}
