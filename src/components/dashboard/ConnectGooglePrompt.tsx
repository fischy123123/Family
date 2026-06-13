'use client'

import { useState, useEffect } from 'react'
import { Calendar, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ConnectGooglePromptProps {
  onConnect: () => void
}

const BENEFITS = [
  'See all your existing Google Calendar events',
  'AI scans Gmail for appointments automatically',
  "Create events that appear on your phone's calendar",
]

export function ConnectGooglePrompt({ onConnect }: ConnectGooglePromptProps) {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    setDismissed(localStorage.getItem('fcc_google_dismissed') === '1')
  }, [])

  function dismiss() {
    localStorage.setItem('fcc_google_dismissed', '1')
    setDismissed(true)
  }

  if (dismissed) return null

  return (
    <div className="relative rounded-2xl border border-purple-200 bg-gradient-to-br from-purple-50 to-blue-50 p-5 shadow-sm animate-slide-up">
      {/* Dismiss button */}
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center shrink-0 shadow-sm">
          <Calendar size={18} className="text-white" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Connect Google Calendar</h3>
          <p className="text-xs text-gray-500 leading-snug mt-0.5">
            Sync your real Google Calendar events, get proactive Gmail suggestions, and let the AI see your full schedule.
          </p>
        </div>
      </div>

      {/* Benefits */}
      <ul className="space-y-1.5 mb-4">
        {BENEFITS.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2">
            <div className="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center shrink-0 mt-0.5">
              <Check size={10} className="text-green-600" strokeWidth={3} />
            </div>
            <span className="text-xs text-gray-600">{benefit}</span>
          </li>
        ))}
      </ul>

      {/* Actions */}
      <div className="flex items-center gap-4">
        <Button
          size="sm"
          className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-4"
          onClick={onConnect}
        >
          Connect Google Calendar
        </Button>
        <button
          onClick={dismiss}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors underline underline-offset-2"
        >
          Maybe later
        </button>
      </div>
    </div>
  )
}
