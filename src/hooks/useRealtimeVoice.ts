'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { FamilyMember } from '@/lib/types'

export type RealtimeState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

interface ToolContext {
  familyId: string
  userEmail: string
  members: FamilyMember[]
  timezone: string
  googleTokens: { accessToken: string; refreshToken: string } | null
}

interface Options {
  // Resolve the dynamic context needed to mint a session + run tools.
  getContext: () => Promise<ToolContext>
  onUserText?: (text: string) => void
  onAssistantText?: (text: string) => void
  onAction?: (summary: string) => void
  onError?: (message: string) => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RealtimeEvent = Record<string, any>

export function useRealtimeVoice(opts: Options) {
  const [state, setState] = useState<RealtimeState>('idle')

  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const ctxRef = useRef<ToolContext | null>(null)
  const activeRef = useRef(false)

  const send = useCallback((event: RealtimeEvent) => {
    const dc = dcRef.current
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(event))
  }, [])

  const runToolCall = useCallback(async (callId: string, name: string, argsJson: string) => {
    const ctx = ctxRef.current
    if (!ctx) return
    let input: Record<string, unknown> = {}
    try { input = argsJson ? JSON.parse(argsJson) : {} } catch { /* keep empty */ }

    let output: unknown = { error: 'Tool failed' }
    try {
      const res = await fetch('/api/realtime/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: name,
          input,
          familyId: ctx.familyId,
          userEmail: ctx.userEmail,
          googleTokens: ctx.googleTokens,
          timezone: ctx.timezone,
          members: ctx.members,
        }),
      })
      const data = await res.json()
      output = data.result ?? data
      if (Array.isArray(data.actions)) {
        for (const a of data.actions) optsRef.current.onAction?.(a)
      }
    } catch (e) {
      output = { error: e instanceof Error ? e.message : 'Tool failed' }
    }

    // Feed the tool result back to the model and let it continue speaking.
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    })
    send({ type: 'response.create' })
  }, [send])

  const handleEvent = useCallback((evt: RealtimeEvent) => {
    switch (evt.type) {
      case 'input_audio_buffer.speech_started':
        setState('listening')
        break
      case 'response.created':
        setState('thinking')
        break
      case 'response.audio.delta':
        setState('speaking')
        break
      case 'response.done':
        if (activeRef.current) setState('listening')
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) optsRef.current.onUserText?.(String(evt.transcript).trim())
        break
      case 'response.audio_transcript.done':
        if (evt.transcript) optsRef.current.onAssistantText?.(String(evt.transcript).trim())
        break
      case 'response.function_call_arguments.done':
        runToolCall(evt.call_id, evt.name, evt.arguments)
        break
      case 'error':
        optsRef.current.onError?.(evt.error?.message ?? 'Realtime error')
        break
    }
  }, [runToolCall])

  const stop = useCallback(() => {
    activeRef.current = false
    try { dcRef.current?.close() } catch { /* noop */ }
    dcRef.current = null
    try { pcRef.current?.close() } catch { /* noop */ }
    pcRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.srcObject = null
    }
    setState('idle')
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true
    setState('connecting')
    try {
      const ctx = await optsRef.current.getContext()
      ctxRef.current = ctx

      // 1. Mint an ephemeral session configured with our prompt + tools.
      const sessionRes = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: ctx.familyId,
          userEmail: ctx.userEmail,
          timezone: ctx.timezone,
          today: new Date().toISOString(),
          members: ctx.members,
          hasGoogleCalendar: !!ctx.googleTokens,
        }),
      })
      const sessionData = await sessionRes.json()
      if (!sessionRes.ok) throw new Error(sessionData.error ?? 'Could not start session')
      const ephemeralKey: string = sessionData.session?.client_secret?.value
      const model: string = sessionData.model
      if (!ephemeralKey) throw new Error('No session token returned')

      // 2. Set up WebRTC.
      const pc = new RTCPeerConnection()
      pcRef.current = pc

      // Remote audio → play it.
      const audioEl = new Audio()
      audioEl.autoplay = true
      audioElRef.current = audioEl
      pc.ontrack = (e) => { audioEl.srcObject = e.streams[0] }

      // Mic → send it.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      stream.getTracks().forEach((t) => pc.addTrack(t, stream))

      // Data channel for events (transcripts, tool calls, etc.).
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onmessage = (e) => {
        try { handleEvent(JSON.parse(e.data)) } catch { /* ignore malformed */ }
      }
      dc.onopen = () => {
        if (activeRef.current) setState('listening')
        // Kick off a brief spoken greeting.
        send({
          type: 'response.create',
          response: { instructions: 'Greet the user warmly in one short sentence and ask how you can help.' },
        })
      }

      // 3. SDP offer/answer handshake with OpenAI.
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp',
        },
      })
      if (!sdpRes.ok) throw new Error('Failed to connect to voice service')
      const answerSdp = await sdpRes.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (e) {
      optsRef.current.onError?.(e instanceof Error ? e.message : 'Could not start voice')
      stop()
    }
  }, [handleEvent, send, stop])

  useEffect(() => () => stop(), [stop])

  return { state, start, stop }
}
