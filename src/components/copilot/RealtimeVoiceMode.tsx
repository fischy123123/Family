'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Mic, MicOff } from 'lucide-react'
import { useRealtimeVoice, type RealtimeState } from '@/hooks/useRealtimeVoice'
import { useWakeLock } from '@/hooks/useWakeLock'
import { cn } from '@/lib/utils'
import type { FamilyMember } from '@/lib/types'

interface ToolContext {
  familyId: string
  userEmail: string
  members: FamilyMember[]
  timezone: string
  googleTokens: { accessToken: string; refreshToken: string } | null
}

const STATUS_TEXT: Record<RealtimeState, string> = {
  idle: '',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
}

function Orb({ state, muted }: { state: RealtimeState; muted: boolean }) {
  const isListening = state === 'listening' && !muted
  const isSpeaking = state === 'speaking'
  const isBusy = state === 'thinking' || state === 'connecting'

  return (
    <div className="relative flex items-center justify-center w-56 h-56">
      {isListening && (
        <>
          <span className="absolute inset-0 rounded-full bg-white/10 animate-ping" />
          <span className="absolute inset-4 rounded-full bg-white/10 animate-ping [animation-delay:300ms]" />
        </>
      )}
      {isSpeaking && <span className="absolute inset-0 rounded-full bg-blue-400/20 animate-pulse" />}
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

export function RealtimeVoiceMode({
  getContext,
  onUserText,
  onAssistantText,
  onError,
  onClose,
}: {
  getContext: () => Promise<ToolContext>
  onUserText?: (text: string) => void
  onAssistantText?: (text: string) => void
  onError: (msg: string) => void
  onClose: () => void
}) {
  const [lastUser, setLastUser] = useState('')
  const startedRef = useRef(false)

  // Keep the screen awake for the whole time voice mode is open so the device
  // doesn't lock itself mid-conversation from lack of touch input.
  useWakeLock(true)

  const { state, error, isMuted, start, stop, toggleMute } = useRealtimeVoice({
    getContext,
    onUserText: (t) => { setLastUser(t); onUserText?.(t) },
    onAssistantText,
    onError,
  })

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
      <div className="w-full flex justify-end max-w-md">
        <button
          onClick={handleClose}
          className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          aria-label="Close voice mode"
        >
          <X size={22} />
        </button>
      </div>

      <div className="flex flex-col items-center gap-8 flex-1 justify-center">
        <Orb state={state} muted={isMuted} />
        <div className="text-center min-h-[3rem] max-w-sm">
          {error ? (
            <>
              <p className="text-red-300 text-base font-medium">Couldn&apos;t start voice</p>
              <p className="text-white/50 text-sm mt-1.5 break-words">{error}</p>
              <button
                onClick={() => start()}
                className="mt-4 px-5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <p className="text-white text-lg font-medium">{STATUS_TEXT[state]}</p>
              {lastUser && (
                <p className="text-white/60 text-sm mt-2 max-w-xs mx-auto line-clamp-2">
                  &ldquo;{lastUser}&rdquo;
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="w-full max-w-md flex flex-col items-center gap-4">
        <p className="text-white/40 text-xs text-center flex items-center gap-1.5">
          {isMuted ? <MicOff size={13} /> : <Mic size={13} />}
          {isMuted ? 'Microphone muted' : 'Just start talking — interrupt me anytime'}
        </p>
        <div className="flex items-center gap-3 w-full justify-center">
          <button
            onClick={toggleMute}
            className={cn(
              'w-12 h-12 rounded-full flex items-center justify-center transition-colors active:scale-95',
              isMuted
                ? 'bg-amber-500 hover:bg-amber-400 text-white'
                : 'bg-white/10 hover:bg-white/20 text-white',
            )}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button
            onClick={handleClose}
            className="px-8 py-3.5 rounded-full bg-red-500 hover:bg-red-600 text-white font-semibold shadow-lg transition-colors active:scale-95"
          >
            End conversation
          </button>
        </div>
      </div>
    </div>
  )
}
