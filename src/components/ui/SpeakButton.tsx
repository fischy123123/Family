'use client'

import { Volume2, VolumeX, Loader2 } from 'lucide-react'
import { useSpeech } from '@/hooks/useSpeech'

interface SpeakButtonProps {
  text: string
  // Use 'white' on dark gradient cards (blue briefing, rose/amber coach).
  color?: 'white' | 'slate'
  size?: number
  className?: string
}

export function SpeakButton({ text, color = 'slate', size = 15, className = '' }: SpeakButtonProps) {
  const { speak, state } = useSpeech()

  const base = color === 'white'
    ? 'text-white/70 hover:text-white'
    : 'text-slate-400 hover:text-slate-600'

  const ring = color === 'white' ? 'ring-white/40' : 'ring-slate-300'

  return (
    <button
      onClick={(e) => { e.stopPropagation(); speak(text) }}
      aria-label={state === 'playing' ? 'Stop' : state === 'loading' ? 'Loading…' : 'Read aloud'}
      title={state === 'playing' ? 'Stop' : state === 'loading' ? 'Loading…' : 'Read aloud'}
      className={`
        relative inline-flex items-center justify-center rounded-full p-1.5 transition-colors
        ${base}
        ${state === 'playing' ? `ring-2 ${ring}` : ''}
        ${className}
      `}
    >
      {state === 'loading' && <Loader2 size={size} className="shrink-0 animate-spin" />}
      {state === 'playing' && (
        <>
          <VolumeX size={size} className="shrink-0" />
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-20"
            style={{ background: color === 'white' ? 'white' : '#94a3b8' }}
          />
        </>
      )}
      {state === 'idle' && <Volume2 size={size} className="shrink-0" />}
    </button>
  )
}
