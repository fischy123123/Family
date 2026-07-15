'use client'

import { useState, useRef, useEffect } from 'react'
import { X, Mic, Square, Send, Loader2, Sparkles, Clock, ChevronDown, ChevronUp, GraduationCap } from 'lucide-react'
import { useKnowledgeOps, describeOp, type IngestOp } from '@/hooks/useKnowledgeOps'

type ChatMsg = { role: 'user' | 'assistant'; text: string }
type Stage = 'pick' | 'chat' | 'summary'

const DURATIONS = [
  { minutes: 15, label: '15 min', blurb: 'A focused pass on the biggest gaps' },
  { minutes: 30, label: '30 min', blurb: 'Work, family, and how your week really flows' },
  { minutes: 60, label: '1 hour', blurb: 'The full picture — a real life-mapping session' },
]

// The "train the AI on me" session. The user picks how long they've got, the
// AI runs a genuine interview paced to that clock, and everything it learns is
// filed into structured knowledge (memories / goals / profile) live, turn by
// turn — visible in the "captured" tray and summarized at the end.
export function DeepDiveSheet({ onClose, onFinished }: {
  onClose: () => void
  onFinished?: (captured: number) => void
}) {
  const { buildDigest, applyOps } = useKnowledgeOps()

  const [stage, setStage] = useState<Stage>('pick')
  const [minutes, setMinutes] = useState(30)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [topic, setTopic] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [ending, setEnding] = useState(false)
  const [captured, setCaptured] = useState<string[]>([])
  const [trayOpen, setTrayOpen] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Context is frozen at session start: the conversation itself carries what's
  // being learned, and a byte-stable context block is what keeps the prompt
  // cache warm across every turn.
  const digestRef = useRef<Record<string, unknown> | null>(null)
  const startedAtRef = useRef<number>(0)
  const [nowTick, setNowTick] = useState(0)

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  useEffect(() => {
    if (stage !== 'chat') return
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [stage])

  const elapsedMin = startedAtRef.current ? (Date.now() - startedAtRef.current) / 60_000 : 0
  void nowTick

  async function callEngine(conversation: ChatMsg[], wrapUp: boolean) {
    const res = await fetch('/api/ai/interview-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation: conversation.map((m) => ({ role: m.role, text: m.text })),
        sessionMinutes: minutes,
        elapsedMinutes: startedAtRef.current ? (Date.now() - startedAtRef.current) / 60_000 : 0,
        wrapUp,
        ...(digestRef.current ?? {}),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Session engine failed')
    return data as { say: string; topic?: string; ops?: IngestOp[]; done?: boolean }
  }

  async function handleTurn(data: { say: string; topic?: string; ops?: IngestOp[]; done?: boolean }) {
    if (data.topic) setTopic(data.topic)
    if (data.ops?.length) {
      const applied = await applyOps(data.ops)
      if (applied.length) setCaptured((cur) => [...cur, ...applied.map(describeOp)])
    }
    if (data.done) {
      setClosing(data.say)
      setStage('summary')
      onFinished?.(captured.length + (data.ops?.length ?? 0))
    } else {
      setMessages((cur) => [...cur, { role: 'assistant', text: data.say }])
    }
  }

  async function start(mins: number) {
    setMinutes(mins)
    setError(null)
    setSending(true)
    setStage('chat')
    digestRef.current = buildDigest()
    startedAtRef.current = Date.now()
    try {
      // minutes state hasn't flushed yet — the engine call reads it, so pass explicitly via closure state
      const res = await fetch('/api/ai/interview-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: [], sessionMinutes: mins, elapsedMinutes: 0, ...(digestRef.current ?? {}) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to start')
      await handleTurn(data)
    } catch {
      setError('Couldn’t start the session — try again.')
      setStage('pick')
    } finally {
      setSending(false)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    const next = [...messages, { role: 'user' as const, text }]
    setMessages(next)
    setInput('')
    setSending(true)
    setError(null)
    try {
      await handleTurn(await callEngine(next, false))
    } catch {
      setError('That didn’t go through — your answer is safe, tap send to retry.')
      setInput(text)
      setMessages(messages)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  async function endSession() {
    if (ending) return
    setEnding(true)
    setError(null)
    try {
      const pending = input.trim()
      const conv = pending ? [...messages, { role: 'user' as const, text: pending }] : messages
      const data = await callEngine(conv, true)
      let appliedCount = 0
      if (data.ops?.length) {
        const applied = await applyOps(data.ops)
        appliedCount = applied.length
        if (applied.length) setCaptured((cur) => [...cur, ...applied.map(describeOp)])
      }
      setClosing(data.say)
      setStage('summary')
      onFinished?.(captured.length + appliedCount)
    } catch {
      // Everything was captured turn-by-turn already — a failed goodbye loses nothing.
      setClosing(null)
      setStage('summary')
      onFinished?.(captured.length)
    } finally {
      setEnding(false)
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        setRecording(false)
        if (blob.size === 0) return
        setTranscribing(true)
        try {
          const fd = new FormData()
          fd.append('file', blob, 'clip.webm')
          const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
          const data = await res.json()
          if (res.ok && data.text) setInput((cur) => (cur.trim() ? `${cur.trim()} ${data.text}` : data.text))
        } catch { /* keep typed text */ } finally { setTranscribing(false) }
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch { /* mic denied — typing still works */ }
  }

  const remaining = Math.max(0, Math.round(minutes - elapsedMin))

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-50">
      {/* ── Header ── */}
      <header className="shrink-0 bg-white border-b border-slate-100 px-4 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-3 h-14">
          <div className="w-8 h-8 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
            <GraduationCap size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-bold text-slate-800 leading-tight">Deep dive</h1>
            {stage === 'chat' && (
              <p className="text-[11px] text-slate-400 leading-tight truncate">
                {topic ? <>Exploring: <span className="text-teal-600 font-semibold">{topic}</span> · </> : null}
                <Clock size={10} className="inline -mt-0.5" /> ~{remaining} min left
              </p>
            )}
          </div>
          {stage === 'chat' && (
            <button
              onClick={endSession}
              disabled={ending || sending}
              className="shrink-0 text-xs font-semibold text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
            >
              {ending ? <Loader2 size={13} className="animate-spin" /> : 'End session'}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-2 -mr-2 text-slate-400 hover:text-slate-600 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Captured tray */}
        {stage === 'chat' && captured.length > 0 && (
          <div className="pb-2">
            <button
              onClick={() => setTrayOpen((v) => !v)}
              className="w-full flex items-center gap-1.5 text-[11px] font-semibold text-teal-600"
            >
              <Sparkles size={11} />
              {captured.length} thing{captured.length === 1 ? '' : 's'} captured so far
              {trayOpen ? <ChevronUp size={12} className="ml-auto" /> : <ChevronDown size={12} className="ml-auto" />}
            </button>
            {trayOpen && (
              <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-1">
                {[...captured].reverse().map((c, i) => (
                  <li key={i} className="text-[11px] text-slate-500 leading-snug pl-4 relative">
                    <span className="absolute left-0 top-0.5 text-teal-400">✓</span>{c}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      {/* ── Duration picker ── */}
      {stage === 'pick' && (
        <div className="flex-1 flex flex-col justify-center px-6 pb-16 max-w-md w-full mx-auto">
          <h2 className="text-xl font-bold text-slate-800">Train me on your life</h2>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            A real conversation — I ask, you talk (voice works great), and I turn everything into
            structured knowledge that sharpens your plans, radar, and coaching. How long do you have?
          </p>
          <div className="mt-6 space-y-3">
            {DURATIONS.map((d) => (
              <button
                key={d.minutes}
                onClick={() => start(d.minutes)}
                disabled={sending}
                className="w-full text-left rounded-2xl bg-white shadow-card p-4 border border-transparent hover:border-teal-300 transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <span className="text-base font-bold text-teal-600 w-14 shrink-0">{d.label}</span>
                  <span className="text-xs text-slate-500">{d.blurb}</span>
                </div>
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-red-500 mt-4">{error}</p>}
        </div>
      )}

      {/* ── Conversation ── */}
      {stage === 'chat' && (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            <div className="max-w-md mx-auto space-y-3">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-teal-600 text-white rounded-br-md'
                      : 'bg-white text-slate-800 shadow-card rounded-bl-md'
                  }`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-white shadow-card rounded-2xl rounded-bl-md px-3.5 py-2.5 flex items-center gap-1.5 text-xs text-slate-400">
                    <Loader2 size={12} className="animate-spin" /> Listening…
                  </div>
                </div>
              )}
              {error && <p className="text-[11px] text-red-500 text-center">{error}</p>}
            </div>
          </div>

          <div className="shrink-0 bg-white border-t border-slate-100 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="max-w-md mx-auto flex items-end gap-2">
              <div className="relative flex-1">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  rows={2}
                  placeholder={transcribing ? 'Transcribing…' : recording ? 'Listening — tap the square when done' : 'Talk or type — ramble away, I’ll sort it out…'}
                  className="w-full text-sm rounded-xl pl-3 pr-10 py-2.5 border border-slate-200 focus:outline-none focus:border-teal-300 bg-slate-50 resize-none leading-relaxed"
                  disabled={sending || ending}
                />
                <button
                  onClick={recording ? () => recorderRef.current?.stop() : startRecording}
                  aria-label={recording ? 'Stop recording' : 'Answer by voice'}
                  className={`absolute top-2.5 right-2 w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                    recording ? 'bg-rose-500 text-white animate-pulse' : 'bg-teal-50 text-teal-600 hover:bg-teal-100'
                  }`}
                >
                  {transcribing ? <Loader2 size={13} className="animate-spin" /> : recording ? <Square size={12} /> : <Mic size={13} />}
                </button>
              </div>
              <button
                onClick={send}
                disabled={!input.trim() || sending || ending}
                className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center disabled:opacity-40 transition-opacity shrink-0"
                aria-label="Send"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Summary ── */}
      {stage === 'summary' && (
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="max-w-md mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-teal-600 text-white flex items-center justify-center mb-4">
              <Sparkles size={22} />
            </div>
            <h2 className="text-xl font-bold text-slate-800">
              {captured.length ? `I learned ${captured.length} thing${captured.length === 1 ? '' : 's'} about you` : 'Session ended'}
            </h2>
            {closing && <p className="text-sm text-slate-600 mt-3 leading-relaxed whitespace-pre-wrap">{closing}</p>}
            {captured.length > 0 && (
              <ul className="mt-5 space-y-2">
                {captured.map((c, i) => (
                  <li key={i} className="text-xs text-slate-600 leading-snug bg-white shadow-card rounded-xl px-3 py-2.5 relative pl-8">
                    <span className="absolute left-3 top-2.5 text-teal-500">✓</span>{c}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-slate-400 mt-5 leading-relaxed">
              All of this now feeds your day plans, the radar, and the coach. Anything can be edited or removed under Family → Memories.
            </p>
            <button
              onClick={onClose}
              className="mt-6 w-full py-3 rounded-xl bg-teal-600 text-white text-sm font-semibold"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
