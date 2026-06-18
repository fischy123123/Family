'use client'

import { Volume2, VolumeX } from 'lucide-react'
import { useSpeech } from '@/hooks/useSpeech'

interface SpeakButtonProps {
  text: string
  // Color of the icon + ripple — pass 'white' for use on dark gradient cards.
  color?: 'white' | 'slate'
  size?: number
  className?: string
}

// Tap-to-speak button that reads `text` aloud using the Web Speech API.
// Tap again while speaking to stop. Invisible when TTS is unsupported.
export function SpeakButton({ text, color = 'slate', size = 14, className = '' }: SpeakButtonProps) {
  const { speak, speaking, supported } = useSpeech()
  if (!supported) return null

  const iconColor = color === 'white' ? 'text-white/80 hover:text-white' : 'text-slate-400 hover:text-slate-600'
  const ringColor  = color === 'white' ? 'ring-white/30' : 'ring-slate-300'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()   // don't bubble to parent card click handlers
        speak(text)
      }}
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      title={speaking ? 'Stop' : 'Read aloud'}
      className={`
        relative inline-flex items-center justify-center rounded-full p-1.5 transition-colors
        ${iconColor}
        ${speaking ? `ring-2 ${ringColor}` : ''}
        ${className}
      `}
    >
      {speaking
        ? <VolumeX size={size} className="shrink-0" />
        : <Volume2 size={size} className="shrink-0" />}

      {/* Subtle pulse ring while speaking */}
      {speaking && (
        <span
          className="absolute inset-0 rounded-full animate-ping opacity-30"
          style={{ background: color === 'white' ? 'white' : '#94a3b8' }}
        />
      )}
    </button>
  )
}
