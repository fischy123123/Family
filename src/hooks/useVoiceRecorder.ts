'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

export type RecorderState = 'idle' | 'recording' | 'transcribing'

interface UseVoiceRecorderOptions {
  // Called with the transcribed text when Whisper returns a result.
  onTranscript: (text: string) => void
  // Passed to Whisper as a context hint — include family member names so
  // Whisper biases toward recognising them correctly ("Jessy" vs "Jesse").
  prompt?: string
}

// Picks the best supported MIME type for the current browser.
// iOS Safari records as audio/mp4; Chrome/Android as audio/webm.
// Whisper accepts both.
function getBestMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return ''
}

// Maps a MIME type to the file extension Whisper needs.
function extForMime(mime: string): string {
  if (mime.startsWith('audio/mp4')) return 'm4a'
  if (mime.startsWith('audio/ogg')) return 'ogg'
  return 'webm'
}

export function useVoiceRecorder({ onTranscript, prompt = '' }: UseVoiceRecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const mimeRef = useRef('')
  // Stable ref so the onstop closure always has the latest prompt/callback.
  const onTranscriptRef = useRef(onTranscript)
  const promptRef = useRef(prompt)
  useEffect(() => { onTranscriptRef.current = onTranscript }, [onTranscript])
  useEffect(() => { promptRef.current = prompt }, [prompt])

  // Release mic and reset state.
  const cleanup = useCallback(() => {
    recorderRef.current?.stop()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    chunksRef.current = []
    setState('idle')
  }, [])

  useEffect(() => () => { cleanup() }, [cleanup])

  const start = useCallback(async () => {
    if (state !== 'idle') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mime = getBestMimeType()
      mimeRef.current = mime
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        // Release the mic immediately — don't hold it during the API call.
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const chunks = chunksRef.current
        chunksRef.current = []
        if (chunks.length === 0) { setState('idle'); return }

        setState('transcribing')
        try {
          const blob = new Blob(chunks, { type: mimeRef.current || 'audio/webm' })
          const ext = extForMime(mimeRef.current)
          const form = new FormData()
          form.append('audio', blob, `recording.${ext}`)
          if (promptRef.current) form.append('prompt', promptRef.current)

          const res = await fetch('/api/transcribe', { method: 'POST', body: form })
          const data = await res.json() as { text?: string; error?: string }
          if (res.ok && data.text) onTranscriptRef.current(data.text)
        } catch { /* non-fatal — user can try again */ } finally {
          setState('idle')
        }
      }

      recorder.start()
      setState('recording')
    } catch {
      // Mic permission denied or hardware unavailable.
      setState('idle')
    }
  }, [state])

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
      // setState('transcribing') is set inside onstop
    }
  }, [])

  return { state, start, stop, cleanup }
}
