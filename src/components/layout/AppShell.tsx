'use client'

import { useState } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { MomentCoachSheet } from '@/components/coach/MomentCoachSheet'
import { useCapture } from '@/contexts/CaptureContext'

export function AppShell({ children }: { children: React.ReactNode }) {
  const { open, isOpen } = useCapture()
  const [coachOpen, setCoachOpen] = useState(false)

  // Hide the floating buttons whenever any overlay is up, so they can't be
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
          className="fixed z-50 bottom-24 sm:bottom-8 left-5 inline-flex items-center gap-1.5 pl-3 pr-4 h-12 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white font-semibold text-sm shadow-float hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 active:translate-y-0"
          style={{ boxShadow: '0 12px 28px rgba(99,102,241,0.45)' }}
        >
          <Sparkles size={18} strokeWidth={2.5} />
          Right now
        </button>
      )}

      {/* Global Capture FAB — hidden while any overlay is open so it can't be
          accidentally tapped through the backdrop on mobile */}
      {!overlayUp && (
        <button
          onClick={() => open()}
          aria-label="Capture"
          className="fixed z-50 bottom-24 sm:bottom-8 right-5 w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center shadow-float hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 active:translate-y-0"
          style={{ boxShadow: '0 12px 28px rgba(79,70,229,0.45)' }}
        >
          <Plus size={26} strokeWidth={2.5} />
        </button>
      )}

      <MomentCoachSheet open={coachOpen} onClose={() => setCoachOpen(false)} />

      <MobileNav />
    </div>
  )
}
