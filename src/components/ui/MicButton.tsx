'use client'

import { Mic } from 'lucide-react'
import { useSpeechToText } from '@/hooks/useSpeechToText'

interface MicButtonProps {
  /** Called with each finalized chunk of dictated text. */
  onText: (text: string) => void
  /** Visual size of the button in px. */
  size?: number
  className?: string
  title?: string
}

/**
 * Tap-to-speak button. Hidden automatically on browsers without speech support.
 * Turns red and pulses while listening.
 */
export function MicButton({ onText, size = 36, className = '', title = 'Tap to speak' }: MicButtonProps) {
  const { listening, supported, toggle } = useSpeechToText(onText)
  if (!supported) return null

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? 'Stop dictation' : title}
      title={listening ? 'Listening… tap to stop' : title}
      className={`shrink-0 flex items-center justify-center rounded-xl transition-all ${
        listening
          ? 'bg-red-500 text-white animate-pulse shadow-lg'
          : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700'
      } ${className}`}
      style={{ width: size, height: size }}
    >
      <Mic size={size * 0.45} />
    </button>
  )
}
