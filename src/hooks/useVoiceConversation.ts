'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

export type ConvoState = 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'idle'

interface TurnResult {
  reply: string
  pendingCount: number
  msgIndex: number
}

interface Options {
  // Send the transcribed text to the agent; returns the spoken reply + whether
  // it queued actions (and which thread message holds them).
  getReply: (text: string) => Promise<TurnResult>
  // Apply the queued actions for the given thread message index.
  executePending: (msgIndex: number) => Promise<void>
  // Surface the live user transcript to the UI.
  onTranscript?: (text: string) => void
  onError?: (message: string) => void
}

// --- Voice-activity detection tuning -------------------------------------
const VAD_THRESHOLD = 0.022 // RMS above this = speech
const SILENCE_MS = 1300 // stop after this much silence following speech
const MAX_UTTERANCE_MS = 20000 // hard cap on a single utterance
const POLL_MS = 60

// --- Affirmative / negative detection for confirming queued actions ------
const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|please do|sounds good|correct|affirmative|that works|go for it|perfect|great)\b/i
const NO_RE = /\b(no|nope|nah|cancel|don't|do not|never mind|nevermind|stop|skip|forget it|not now)\b/i

function classify(text: string): 'yes' | 'no' | 'other' {
  if (NO_RE.test(text)) return 'no'
  if (YES_RE.test(text)) return 'yes'
  return 'other'
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function useVoiceConversation(opts: Options) {
  const [state, setState] = useState<ConvoState>('idle')

  // Keep callbacks fresh without re-subscribing the loop.
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

  const activeRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const speakResolveRef = useRef<(() => void) | null>(null)
  // Thread message index of actions awaiting a spoken yes/no, or null.
  const pendingMsgIndexRef = useRef<number | null>(null)
  const mimeRef = useRef<string>('')

  // ---- forward declarations via refs so functions can call each other ----
  const listenRef = useRef<() => void>(() => {})

  const cleanup = useCallback(() => {
    activeRef.current = false
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try { recorderRef.current.stop() } catch { /* noop */ }
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
    analyserRef.current = null
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.src = ''
    }
    speakResolveRef.current = null
    pendingMsgIndexRef.current = null
  }, [])

  const speak = useCallback(async (text: string) => {
    if (!activeRef.current) return
    const clean = stripMarkdown(text)
    if (!clean) return
    setState('speaking')
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
      })
      if (!res.ok || !activeRef.current) return
      const buf = await res.arrayBuffer()
      if (!activeRef.current) return
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      const audio = audioElRef.current ?? new Audio()
      audioElRef.current = audio
      audio.src = url
      await new Promise<void>((resolve) => {
        speakResolveRef.current = resolve
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        audio.play().catch(() => resolve())
      })
      speakResolveRef.current = null
      URL.revokeObjectURL(url)
    } catch {
      /* if TTS fails we just skip speaking and resume listening */
    }
  }, [])

  // Handle one completed user utterance: confirmation flow or a new turn.
  const handleUtterance = useCallback(async (text: string) => {
    if (!activeRef.current) return
    optsRef.current.onTranscript?.(text)

    // If actions are waiting on a spoken yes/no, resolve that first.
    if (pendingMsgIndexRef.current != null) {
      const verdict = classify(text)
      if (verdict === 'yes') {
        const idx = pendingMsgIndexRef.current
        pendingMsgIndexRef.current = null
        setState('thinking')
        try { await optsRef.current.executePending(idx) } catch { /* surfaced via toast */ }
        await speak('Done — all set.')
        return
      }
      if (verdict === 'no') {
        pendingMsgIndexRef.current = null
        await speak("Okay, I won't do that.")
        return
      }
      // Anything else: treat as a brand-new request.
      pendingMsgIndexRef.current = null
    }

    setState('thinking')
    let result: TurnResult
    try {
      result = await optsRef.current.getReply(text)
    } catch (e) {
      optsRef.current.onError?.(e instanceof Error ? e.message : 'Something went wrong')
      await speak('Sorry, something went wrong.')
      return
    }
    if (!activeRef.current) return
    if (result.pendingCount > 0) pendingMsgIndexRef.current = result.msgIndex
    await speak(
      result.reply ||
        (result.pendingCount > 0
          ? 'I have something ready to confirm. Should I go ahead?'
          : 'Done.'),
    )
  }, [speak])

  const transcribe = useCallback(async (blob: Blob) => {
    if (!activeRef.current) return
    setState('transcribing')
    try {
      const ext = mimeRef.current.includes('mp4') ? 'm4a' : 'webm'
      const form = new FormData()
      form.append('audio', blob, `voice.${ext}`)
      const res = await fetch('/api/transcribe', { method: 'POST', body: form })
      const data = (await res.json()) as { text?: string; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Transcription failed')
      const text = (data.text ?? '').trim()
      if (!activeRef.current) return
      if (text) {
        await handleUtterance(text)
      }
    } catch (e) {
      optsRef.current.onError?.(e instanceof Error ? e.message : 'Transcription failed')
    } finally {
      // Resume the loop for the next turn.
      if (activeRef.current) listenRef.current()
    }
  }, [handleUtterance])

  const listen = useCallback(() => {
    if (!activeRef.current || !streamRef.current || !analyserRef.current) return
    setState('listening')

    const recorder = new MediaRecorder(
      streamRef.current,
      mimeRef.current ? { mimeType: mimeRef.current } : undefined,
    )
    recorderRef.current = recorder
    chunksRef.current = []
    let speechDetected = false
    let stopped = false
    const startTime = Date.now()
    let lastVoiceTime = Date.now()

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      const blob = new Blob(chunksRef.current, { type: mimeRef.current || 'audio/webm' })
      chunksRef.current = []
      if (!activeRef.current) return
      if (!speechDetected || blob.size < 1200) {
        // Nothing meaningful captured — keep listening.
        listenRef.current()
        return
      }
      transcribe(blob)
    }

    const analyser = analyserRef.current
    const data = new Uint8Array(analyser.frequencyBinCount)

    const stopUtterance = () => {
      if (stopped) return
      stopped = true
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        try { recorderRef.current.stop() } catch { /* noop */ }
      }
    }

    pollRef.current = setInterval(() => {
      if (!activeRef.current) { stopUtterance(); return }
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / data.length)
      const now = Date.now()

      if (rms > VAD_THRESHOLD) {
        speechDetected = true
        lastVoiceTime = now
      }
      if (speechDetected && now - lastVoiceTime > SILENCE_MS) {
        stopUtterance()
      }
      if (now - startTime > MAX_UTTERANCE_MS) {
        stopUtterance()
      }
    }, POLL_MS)

    try { recorder.start() } catch { /* noop */ }
  }, [transcribe])

  useEffect(() => { listenRef.current = listen }, [listen])

  const start = useCallback(async () => {
    if (activeRef.current) return
    setState('connecting')
    activeRef.current = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyserRef.current = analyser

      mimeRef.current = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? ''

      // Prepare (and unlock) the audio element within this user gesture.
      const audio = new Audio()
      audioElRef.current = audio

      listen()
    } catch (e) {
      optsRef.current.onError?.(e instanceof Error ? e.message : 'Microphone access denied')
      cleanup()
      setState('idle')
    }
  }, [listen, cleanup])

  // Interrupt the assistant while it's speaking and go back to listening.
  const interrupt = useCallback(() => {
    if (state !== 'speaking') return
    if (audioElRef.current) {
      audioElRef.current.pause()
    }
    if (speakResolveRef.current) {
      const resolve = speakResolveRef.current
      speakResolveRef.current = null
      resolve()
    }
    if (activeRef.current) listen()
  }, [state, listen])

  const stop = useCallback(() => {
    cleanup()
    setState('idle')
  }, [cleanup])

  // Clean up on unmount.
  useEffect(() => () => cleanup(), [cleanup])

  return { state, start, stop, interrupt }
}
