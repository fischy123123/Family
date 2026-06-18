'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Mic } from 'lucide-react'
import { useVoiceConversation, type ConvoState } from '@/hooks/useVoiceConversation'
import { cn } from '@/lib/utils'

interface TurnResult {
  reply: string
  pendingCount: number
  msgIndex: number
}

const STATUS_TEXT: Record<ConvoState, string> = {
  connecting: 'Connecting…',
  listening: 'Listening…',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  idle: '',
}

function Orb({ state }: { state: ConvoState }) {
  // The orb's animation reflects the conversation state.
  const isListening = state === 'listening'
  const isSpeaking = state === 'speaking'
  const isBusy = state === 'thinking' || state === 'transcribing' || state === 'connecting'

  return (
    <div className="relative flex items-center justify-center w-56 h-56">
      {/* Outer pulsing rings */}
      {isListening && (
        <>
          <span className="absolute inset-0 rounded-full bg-white/10 animate-ping" />
          <span className="absolute inset-4 rounded-full bg-white/10 animate-ping [animation-delay:300ms]" />
        </>
      )}
      {isSpeaking && (
        <span className="absolute inset-0 rounded-full bg-blue-400/20 animate-pulse" />
      )}
      {/* Core orb */}
      <div
        className={cn(
          'relative w-40 h-40 rounded-full bg-gradient-to-br from-blue-400 via-blue-500 to-purple-600 shadow-2xl transition-transform duration-500',
          isListening && 'scale-105 animate-[pulse_1.6s_ease-in-out_infinite]',
          isSpeaking && 'scale-110 animate-[pulse_0.8s_ease-in-out_infinite]',
          isBusy && 'scale-95 opacity-90',
        )}
      >
        <div className="absolute inset-3 rounded-full bg-gradient-to-tr from-white/30 to-transparent" />
      </div>
    </div>
  )
}

export function VoiceMode({
  getReply,
  executePending,
  onClose,
  onError,
}: {
  getReply: (text: string) => Promise<TurnResult>
  executePending: (msgIndex: number) => Promise<void>
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [lastTranscript, setLastTranscript] = useState('')
  const startedRef = useRef(false)

  const { state, start, stop, interrupt } = useVoiceConversation({
    getReply,
    executePending,
    onTranscript: (t) => setLastTranscript(t),
    onError,
  })

  // Auto-start the conversation as soon as the overlay opens (this mounts
  // right after the user's tap, so the mic prompt and audio are user-initiated).
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    start()
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = () => {
    stop()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-slate-900 via-slate-900 to-indigo-950 px-6 py-10 animate-slide-up">
      {/* Close button */}
      <div className="w-full flex justify-end max-w-md">
        <button
          onClick={handleClose}
          className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          aria-label="Close voice mode"
        >
          <X size={22} />
        </button>
      </div>

      {/* Orb + status */}
      <div className="flex flex-col items-center gap-8 flex-1 justify-center">
        <button
          onClick={() => state === 'speaking' && interrupt()}
          className="focus:outline-none"
          aria-label={state === 'speaking' ? 'Tap to interrupt' : 'Voice assistant'}
        >
          <Orb state={state} />
        </button>
        <div className="text-center min-h-[3rem]">
          <p className="text-white text-lg font-medium">{STATUS_TEXT[state]}</p>
          {state === 'speaking' && (
            <p className="text-white/40 text-sm mt-1">Tap the orb to interrupt</p>
          )}
          {lastTranscript && (state === 'thinking' || state === 'transcribing') && (
            <p className="text-white/60 text-sm mt-2 max-w-xs mx-auto line-clamp-2">
              &ldquo;{lastTranscript}&rdquo;
            </p>
          )}
        </div>
      </div>

      {/* End button */}
      <div className="w-full max-w-md flex flex-col items-center gap-4">
        <p className="text-white/40 text-xs text-center flex items-center gap-1.5">
          <Mic size={13} /> Just start talking — I&apos;ll listen and reply
        </p>
        <button
          onClick={handleClose}
          className="px-8 py-3.5 rounded-full bg-red-500 hover:bg-red-600 text-white font-semibold shadow-lg transition-colors active:scale-95"
        >
          End conversation
        </button>
      </div>
    </div>
  )
}
