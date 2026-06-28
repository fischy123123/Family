'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { MomentCoach } from './MomentCoach'

// The "Right now" coach in an overlay, so it's reachable in one tap from any
// screen via the global FAB — not just the Coach tab. Renders the same
// MomentCoach experience (its own independent state) inside a bottom sheet.
export function MomentCoachSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Lock background scroll while the sheet is up, and close on Escape.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-slate-50 rounded-t-3xl sm:rounded-3xl shadow-elevated animate-slide-up p-4 pt-6 pb-8">
        {/* Grabber (mobile) + close */}
        <div className="sm:hidden w-10 h-1 bg-slate-300 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-2.5" />
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
        >
          <X size={18} />
        </button>
        <MomentCoach />
      </div>
    </div>
  )
}
