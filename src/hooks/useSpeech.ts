'use client'

import { useState, useEffect, useRef } from 'react'

// Wraps the Web Speech API for TTS. Calling speak() while already speaking
// cancels playback (toggle behaviour). Automatically cancels on unmount.
//
// Note: speechSynthesis.speak() MUST be called inside a user-gesture handler
// (tap, click) on iOS — the hook guarantees this because speak() is always
// invoked from a button's onClick.
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
  // Track the active utterance so we can cancel it without touching the
  // global queue (which may contain other utterances in future).
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    // Stop speech when the component that owns this hook unmounts (e.g. page
    // navigation) so audio doesn't keep playing in the background.
    return () => {
      if (supported) window.speechSynthesis.cancel()
    }
  }, [supported])

  function speak(text: string) {
    if (!supported) return

    // Toggle: tap again to stop
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      utteranceRef.current = null
      return
    }

    // Cancel anything already queued before we add ours
    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.92      // slightly slower than default for comfortable listening
    utterance.pitch = 1.0
    utterance.volume = 1.0
    utterance.onstart = () => setSpeaking(true)
    utterance.onend = () => { setSpeaking(false); utteranceRef.current = null }
    utterance.onerror = () => { setSpeaking(false); utteranceRef.current = null }

    utteranceRef.current = utterance
    // speechSynthesis.speak is synchronous — onstart fires immediately on most
    // browsers. Set optimistic state before the call to avoid a visual flicker.
    setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }

  function stop() {
    if (!supported) return
    window.speechSynthesis.cancel()
    setSpeaking(false)
    utteranceRef.current = null
  }

  return { speak, stop, speaking, supported }
}
