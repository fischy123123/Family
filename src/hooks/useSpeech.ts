'use client'

import { useState, useEffect, useRef } from 'react'

export type SpeechState = 'idle' | 'loading' | 'playing'

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle')
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<SpeechState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  function track(s: SpeechState) {
    stateRef.current = s
    setState(s)
  }

  function stop() {
    abortRef.current?.abort()
    abortRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    track('idle')
  }

  useEffect(() => stop, [])

  async function speak(text: string) {
    setError(null)

    if (stateRef.current !== 'idle') {
      stop()
      return
    }

    // ── iOS Safari / PWA audio unlock ──────────────────────────────────────
    // iOS requires HTMLAudioElement.play() to be invoked synchronously within
    // a user-gesture handler. After any await (including fetch), the gesture
    // context is lost and play() is silently rejected. The fix: create the
    // Audio element and call play() right now (it will fail because there's
    // no src — that's fine). iOS marks this element as "user-activated", so
    // the later play() call after we set .src succeeds even though it's async.
    const audio = new Audio()
    audioRef.current = audio
    audio.play().catch(() => {}) // intentional — primes element, errors ignored

    track('loading')
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      })

      if (ctrl.signal.aborted) return

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Server error ${res.status}`)
      }

      const blob = await res.blob()
      if (ctrl.signal.aborted) return

      const url = URL.createObjectURL(blob)
      objectUrlRef.current = url

      audio.src = url
      audio.onended = stop
      audio.onerror = () => { setError('Playback failed'); stop() }

      track('playing')
      await audio.play()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      const msg = e instanceof Error ? e.message : 'TTS failed'
      setError(msg)
      stop()
    }
  }

  return { speak, stop, state, speaking: state !== 'idle', loading: state === 'loading', error }
}
