'use client'

import { useState, useRef, useCallback } from 'react'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

interface Options {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
}

export function useVoiceRecorder({ onTranscript, onError }: Options) {
  const [state, setState] = useState<VoiceState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? ''

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        chunksRef.current = []

        if (blob.size < 1000) {
          // Too short to be meaningful — ignore silently
          setState('idle')
          return
        }

        setState('transcribing')
        try {
          const form = new FormData()
          form.append('audio', blob, `voice.${ext}`)
          const res = await fetch('/api/transcribe', { method: 'POST', body: form })
          const data = (await res.json()) as { text?: string; error?: string }
          if (!res.ok || data.error) throw new Error(data.error ?? 'Transcription failed')
          const text = data.text?.trim() ?? ''
          if (text) onTranscript(text)
        } catch (e) {
          onError?.(e instanceof Error ? e.message : 'Transcription failed')
        } finally {
          setState('idle')
        }
      }

      recorder.start()
      setState('recording')
    } catch (e) {
      onError?.(e instanceof Error ? e.message : 'Microphone access denied')
      setState('idle')
    }
  }, [onTranscript, onError])

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [])

  const toggle = useCallback(() => {
    if (state === 'idle') startRecording()
    else if (state === 'recording') stopRecording()
  }, [state, startRecording, stopRecording])

  return { state, toggle }
}
