'use client'

import { useState, useEffect, useRef } from 'react'

export type SpeechState = 'idle' | 'loading' | 'playing'

// Fetches TTS audio from the server (/api/tts → OpenAI) and plays it via an
// HTMLAudioElement. Calling speak() while loading or playing stops playback
// (toggle behaviour). Automatically stops on unmount (navigation).
export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle')
  // Use a ref to read current state inside async callbacks without stale closures.
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

  // Stop when the component that owns this hook navigates away.
  useEffect(() => stop, [])

  async function speak(text: string) {
    // Toggle: speaking or loading → stop.
    if (stateRef.current !== 'idle') {
      stop()
      return
    }

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
      if (!res.ok) throw new Error(`TTS ${res.status}`)
      if (ctrl.signal.aborted) return

      const blob = await res.blob()
      if (ctrl.signal.aborted) return

      const url = URL.createObjectURL(blob)
      objectUrlRef.current = url

      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = stop
      audio.onerror = stop

      track('playing')
      await audio.play()
    } catch (e) {
      // AbortError = user tapped stop while loading — not a real error.
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        stop()
      }
    }
  }

  return {
    speak,
    stop,
    state,
    speaking: state !== 'idle',
    loading: state === 'loading',
  }
}
