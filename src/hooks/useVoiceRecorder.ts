'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

export type RecorderState = 'idle' | 'listening' | 'transcribing'

// How long silence must last (after speech has started) before we auto-stop.
const SILENCE_AFTER_SPEECH_MS = 1800
// Minimum speech duration — prevents a background-noise blip from triggering.
const MIN_SPEECH_MS = 400
// Average byte-frequency amplitude below this = silence (0-255 scale).
const SILENCE_THRESHOLD = 14
// Safety cap — stop even if silence isn't detected (prevents infinite recording).
const MAX_RECORDING_MS = 60_000

function getBestMimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

function extForMime(mime: string) {
  if (mime.startsWith('audio/mp4')) return 'm4a'
  if (mime.startsWith('audio/ogg')) return 'ogg'
  return 'webm'
}

export function useVoiceRecorder({
  onTranscript,
  prompt = '',
}: {
  onTranscript: (text: string) => void
  prompt?: string
}) {
  const [state, setState] = useState<RecorderState>('idle')
  const stateRef = useRef<RecorderState>('idle')
  const onTranscriptRef = useRef(onTranscript)
  const promptRef = useRef(prompt)
  useEffect(() => { onTranscriptRef.current = onTranscript }, [onTranscript])
  useEffect(() => { promptRef.current = prompt }, [prompt])

  const recorderRef  = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const streamRef    = useRef<MediaStream | null>(null)
  const audioCtxRef  = useRef<AudioContext | null>(null)
  const rafRef       = useRef<number | null>(null)
  const safetyRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mimeRef      = useRef('')

  function track(s: RecorderState) { stateRef.current = s; setState(s) }

  // Stops the silence-detection loop and MediaRecorder, then runs Whisper.
  const stopAndTranscribe = useCallback(() => {
    if (stateRef.current !== 'listening') return

    if (rafRef.current)  { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null }

    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null

    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null

    recorderRef.current?.stop() // triggers onstop → transcribe
  }, [])

  const cleanup = useCallback(() => {
    if (rafRef.current)  { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null }
    recorderRef.current?.stop()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    track('idle')
  }, [])

  useEffect(() => () => { cleanup() }, [cleanup])

  // ── start() must be called synchronously inside a user-gesture handler ──
  // That's all iOS needs to allow AudioContext + mic.
  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      return // mic permission denied
    }
    if (stateRef.current !== 'idle') { stream.getTracks().forEach(t => t.stop()); return }

    streamRef.current = stream

    // ── Web Audio silence detection ─────────────────────────────────────
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
      await ctx.resume()
    } catch {
      stream.getTracks().forEach(t => t.stop()); return
    }
    audioCtxRef.current = ctx

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    let speechStarted = false
    let silenceAt: number | null = null
    let speechAt: number | null = null

    function tick() {
      if (stateRef.current !== 'listening') return
      analyser.getByteFrequencyData(buf)
      const level = buf.reduce((s, v) => s + v, 0) / buf.length

      if (level > SILENCE_THRESHOLD) {
        if (!speechAt) speechAt = Date.now()
        if (Date.now() - speechAt >= MIN_SPEECH_MS) speechStarted = true
        silenceAt = null
      } else if (speechStarted) {
        if (!silenceAt) silenceAt = Date.now()
        if (Date.now() - silenceAt >= SILENCE_AFTER_SPEECH_MS) {
          stopAndTranscribe(); return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    // Safety cutoff
    safetyRef.current = setTimeout(stopAndTranscribe, MAX_RECORDING_MS)

    // ── MediaRecorder ───────────────────────────────────────────────────
    const mime = getBestMimeType()
    mimeRef.current = mime
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorderRef.current = recorder
    chunksRef.current = []

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

    recorder.onstop = async () => {
      const chunks = chunksRef.current
      chunksRef.current = []

      if (!speechStarted || chunks.length === 0) { track('idle'); return }

      track('transcribing')
      try {
        const blob = new Blob(chunks, { type: mimeRef.current || 'audio/webm' })
        const form = new FormData()
        form.append('audio', blob, `rec.${extForMime(mimeRef.current)}`)
        if (promptRef.current) form.append('prompt', promptRef.current)

        const res  = await fetch('/api/transcribe', { method: 'POST', body: form })
        const data = await res.json() as { text?: string }
        if (res.ok && data.text?.trim()) onTranscriptRef.current(data.text.trim())
      } catch { /* non-fatal */ } finally {
        track('idle')
      }
    }

    recorder.start(250) // collect in 250 ms chunks for reliability
    track('listening')
  }, [stopAndTranscribe])

  return { state, start, stop: stopAndTranscribe, cleanup }
}
