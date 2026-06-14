'use client'

import { Plus } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { useCapture } from '@/contexts/CaptureContext'

export function AppShell({ children }: { children: React.ReactNode }) {
  const { open } = useCapture()

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 overflow-auto pb-28 sm:pb-0 min-h-screen">
        {children}
      </main>

      {/* Global Capture FAB */}
      <button
        onClick={() => open()}
        aria-label="Capture"
        className="fixed z-50 bottom-24 sm:bottom-8 right-5 w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center shadow-float hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 active:translate-y-0"
        style={{ boxShadow: '0 12px 28px rgba(79,70,229,0.45)' }}
      >
        <Plus size={26} strokeWidth={2.5} />
      </button>

      <MobileNav />
    </div>
  )
}
