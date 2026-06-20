'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, Sparkles, Bot, CheckCircle2, AlertTriangle,
  CalendarDays, ShoppingCart, ListChecks, Plane, AudioLines,
  Paperclip, X, FileText, Bug,
} from 'lucide-react'
import { RealtimeVoiceMode } from '@/components/copilot/RealtimeVoiceMode'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useToast } from '@/contexts/ToastContext'
import { Markdown } from '@/components/ui/Markdown'
import { ProposedActions, type PendingAction, type ActionStatus } from '@/components/copilot/ProposedActions'
import { cn } from '@/lib/utils'
import { isAiDebugEnabled } from '@/lib/aiDebug'
import type { FamilyMember } from '@/lib/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Attachment {
  id: string
  name: string
  mediaType: string
  data: string // base64
  preview?: string // object URL for images
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  isStreaming?: boolean
  actions?: string[]
  pendingActions?: PendingAction[]
  actionStatus?: ActionStatus
}

const ACCEPTED_TYPES = 'image/*,.pdf,.txt,.md,.csv'
const MAX_FILE_MB = 10

// ---------------------------------------------------------------------------
// Example prompts (for the empty-state hero)
// ---------------------------------------------------------------------------

const EXAMPLE_PROMPTS: { text: string; icon: React.ElementType }[] = [
  { text: 'What needs my attention today?', icon: AlertTriangle },
  { text: 'Plan a weekend trip to the coast', icon: Plane },
  { text: "What's everyone doing this weekend?", icon: CalendarDays },
  { text: 'Add milk, eggs, and bread to groceries', icon: ShoppingCart },
  { text: "What am I forgetting to prepare for?", icon: Sparkles },
  { text: 'Summarize the week ahead', icon: ListChecks },
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionPills({ actions }: { actions: string[] }) {
  if (!actions.length) return null
  return (
    <div className="flex flex-wrap gap-2 mt-2.5">
      {actions.map((action, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-100"
        >
          <CheckCircle2 size={13} className="shrink-0" />
          {action}
        </span>
      ))}
    </div>
  )
}

function AssistantBubble({
  msg,
  members,
  availableCalendars,
  onConfirm,
  onCancel,
  onActionChange,
}: {
  msg: Message
  members: FamilyMember[]
  availableCalendars: Array<{ id: string; name: string; primary: boolean }>
  onConfirm: () => void
  onCancel: () => void
  onActionChange: (actionId: string, field: string, value: string) => void
}) {
  return (
    <div className="flex items-start gap-3 animate-slide-up">
      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 shadow-card mt-0.5">
        <Bot size={17} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 max-w-[85%]">
        <div className="bg-white border border-slate-100 shadow-card rounded-2xl rounded-tl-md px-4 py-3">
          <Markdown content={msg.content} />
          {msg.isStreaming && (
            <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 animate-pulse align-middle" />
          )}
        </div>
        {msg.pendingActions && msg.pendingActions.length > 0 && (
          <ProposedActions
            actions={msg.pendingActions}
            members={members}
            availableCalendars={availableCalendars}
            status={msg.actionStatus ?? 'pending'}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onActionChange={onActionChange}
          />
        )}
        {msg.actions && <ActionPills actions={msg.actions} />}
      </div>
    </div>
  )
}

function UserBubble({ msg }: { msg: Message }) {
  return (
    <div className="flex justify-end animate-slide-up">
      <div className="max-w-[80%] flex flex-col items-end gap-2">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-end">
            {msg.attachments.map((a) =>
              a.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={a.id}
                  src={a.preview}
                  alt={a.name}
                  className="h-36 max-w-[200px] rounded-xl object-cover shadow-card border border-white/20"
                />
              ) : (
                <div
                  key={a.id}
                  className="flex items-center gap-2 bg-blue-500/30 border border-white/20 rounded-xl px-3 py-2 text-white text-xs font-medium"
                >
                  <FileText size={14} className="shrink-0" />
                  <span className="truncate max-w-[140px]">{a.name}</span>
                </div>
              ),
            )}
          </div>
        )}
        {msg.content && (
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-2xl rounded-tr-md px-4 py-3 shadow-card">
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function LoadingBubble() {
  return (
    <div className="flex items-start gap-3 animate-slide-up">
      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 shadow-card mt-0.5">
        <Bot size={17} className="text-white" />
      </div>
      <div className="bg-white border border-slate-100 shadow-card rounded-2xl rounded-tl-md px-4 py-4">
        <div className="flex items-center gap-1.5">
          <span className="dot-bounce w-2 h-2 rounded-full bg-blue-400 block" />
          <span className="dot-bounce w-2 h-2 rounded-full bg-blue-400 block" />
          <span className="dot-bounce w-2 h-2 rounded-full bg-blue-400 block" />
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <div className="max-w-2xl mx-auto w-full flex flex-col items-center justify-center min-h-full py-12 animate-slide-up">
      <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center mb-5 shadow-card">
        <Sparkles size={30} className="text-white" />
      </div>
      <h2 className="text-2xl font-bold text-slate-900 mb-2 text-center">
        How can I help your family today?
      </h2>
      <p className="text-slate-500 text-center mb-8 max-w-md">
        I keep track of everyone&apos;s schedules, lists, and plans — so you don&apos;t have to.
        Ask me anything, or tell me what to do.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
        {EXAMPLE_PROMPTS.map(({ text, icon: Icon }) => (
          <button
            key={text}
            onClick={() => onPrompt(text)}
            className="group flex items-center gap-3 text-left bg-white border border-slate-100 shadow-card rounded-2xl px-4 py-3.5 hover:border-blue-200 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
          >
            <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center shrink-0 group-hover:from-blue-100 group-hover:to-purple-100 transition-colors">
              <Icon size={17} className="text-blue-600" />
            </span>
            <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
              {text}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CopilotChat() {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { getFreshTokens } = useGoogleTokens()
  const { toast } = useToast()

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [availableCalendars, setAvailableCalendars] = useState<Array<{ id: string; name: string; primary: boolean }>>([])
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([])
  const [debugMode, setDebugMode] = useState(false)

  // Reflect the AI-debug toggle (set in Settings) in the header so the user
  // knows source-tracing is active. Re-check when the tab regains focus in case
  // they just changed it.
  useEffect(() => {
    const sync = () => setDebugMode(isAiDebugEnabled())
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Seed the conversation from another screen (e.g. tapping the Home briefing).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const seed = sessionStorage.getItem('copilot-seed')
    if (seed) {
      sessionStorage.removeItem('copilot-seed')
      setMessages([{ role: 'assistant', content: seed }])
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [])

  // Auto-scroll to bottom on new messages / loading
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // A "trace" question carried in from a briefing card (debug mode). Unlike the
  // seed above, this is a USER question that we auto-send so the AI answers it
  // with its sources. Fires once, after family/user context is ready.
  const askFiredRef = useRef(false)

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    files.forEach((file) => {
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        toast(`${file.name} exceeds ${MAX_FILE_MB} MB limit`, 'error')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]
        const isImage = file.type.startsWith('image/')
        const attachment: Attachment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          data: base64,
          preview: isImage ? dataUrl : undefined,
        }
        setPendingAttachments((prev) => [...prev, attachment])
      }
      reader.readAsDataURL(file)
    })
  }, [toast])

  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      const hasAttachments = pendingAttachments.length > 0
      if ((!content && !hasAttachments) || loading || !familyId || !user?.email) return

      const attachments = [...pendingAttachments]
      const userMsg: Message = { role: 'user', content, attachments: attachments.length ? attachments : undefined }
      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setPendingAttachments([])
      setLoading(true)

      try {
        const freshTokens = await getFreshTokens()
        const googleTokens = freshTokens
          ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
          : null

        const history = [...messages, userMsg].map((m) => {
          if (!m.attachments?.length) return { role: m.role, content: m.content }
          // Build a content block array: attachments first, then text
          type ContentBlock =
            | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
            | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title: string }
            | { type: 'text'; text: string }
          const blocks: ContentBlock[] = m.attachments.map((a) =>
            a.mediaType.startsWith('image/')
              ? { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
              : { type: 'document', source: { type: 'base64', media_type: a.mediaType || 'application/pdf', data: a.data }, title: a.name },
          )
          if (m.content) blocks.push({ type: 'text', text: m.content })
          return { role: m.role, content: blocks }
        })

        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history,
            familyId,
            userEmail: user.email,
            googleTokens,
            debug: isAiDebugEnabled(),
            context: {
              members,
              today: new Date().toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }),
        })

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: 'Request failed' }))
          throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
        }

        // ── Stream the response ─────────────────────────────────────────────
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamingStarted = false

        type DoneEvent = { type: 'done'; reply: string; pendingActions: PendingAction[]; actions: string[]; availableCalendars?: Array<{ id: string; name: string; primary: boolean }> }
        type SSEEvent = { type: 'token'; token: string } | DoneEvent | { type: 'error'; error: string }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            let event: SSEEvent
            try { event = JSON.parse(line.slice(6)) } catch { continue }

            if (event.type === 'token') {
              if (!streamingStarted) {
                // First token — replace the loading bubble with the live message.
                streamingStarted = true
                setLoading(false)
                setMessages((prev) => [
                  ...prev,
                  { role: 'assistant', content: event.token, isStreaming: true },
                ])
              } else {
                setMessages((prev) => {
                  const msgs = [...prev]
                  const last = msgs[msgs.length - 1]
                  if (last?.role === 'assistant' && last.isStreaming) {
                    msgs[msgs.length - 1] = { ...last, content: last.content + event.token }
                  }
                  return msgs
                })
              }
            } else if (event.type === 'done') {
              const { reply, pendingActions, actions, availableCalendars: cals } = event as DoneEvent
              if (cals?.length) setAvailableCalendars(cals)
              const hasPending = (pendingActions?.length ?? 0) > 0
              setMessages((prev) => {
                const msgs = [...prev]
                const last = msgs[msgs.length - 1]
                if (last?.role === 'assistant') {
                  msgs[msgs.length - 1] = {
                    ...last,
                    isStreaming: false,
                    // Use the authoritative full reply from 'done' in case the
                    // streamed tokens and final reply diverge (e.g. tool-call turns
                    // where the text block is assembled server-side).
                    content: reply || last.content || (hasPending ? "Here's what I'll do — confirm to apply." : 'Done.'),
                    actions: hasPending ? [] : (actions ?? []),
                    pendingActions: pendingActions ?? [],
                    actionStatus: hasPending ? 'pending' : undefined,
                  }
                } else {
                  // No tokens were streamed (pure tool-call response with no text).
                  msgs.push({
                    role: 'assistant',
                    content: reply || (hasPending ? "Here's what I'll do — confirm to apply." : 'Done.'),
                    actions: hasPending ? [] : (actions ?? []),
                    pendingActions: pendingActions ?? [],
                    actionStatus: hasPending ? 'pending' : undefined,
                  })
                }
                return msgs
              })
            } else if (event.type === 'error') {
              throw new Error(event.error)
            }
          }
        }
      } catch (e: unknown) {
        setMessages((prev) => {
          const msgs = [...prev]
          // Remove a stale streaming placeholder if one exists.
          if (msgs[msgs.length - 1]?.isStreaming) msgs.pop()
          return [...msgs, { role: 'assistant', content: 'Sorry, something went wrong.', actions: [] }]
        })
        toast('Something went wrong. Please try again.', 'error')
        // eslint-disable-next-line no-console
        console.error('[copilot] error:', e)
      } finally {
        setLoading(false)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    },
    [input, pendingAttachments, loading, familyId, user?.email, members, messages, getFreshTokens, toast],
  )

  // Auto-send a trace question handed off from a briefing card.
  useEffect(() => {
    if (askFiredRef.current) return
    if (typeof window === 'undefined') return
    if (!familyId || !user?.email) return
    let ask: string | null = null
    try { ask = sessionStorage.getItem('copilot-ask') } catch { /* ignore */ }
    if (ask) {
      try { sessionStorage.removeItem('copilot-ask') } catch { /* ignore */ }
      askFiredRef.current = true
      handleSend(ask)
    }
  }, [familyId, user?.email, handleSend])

  // Resolve the dynamic context the realtime voice session needs (fresh Google
  // tokens, family members, timezone) at the moment the conversation starts.
  const getVoiceContext = useCallback(async () => {
    const freshTokens = await getFreshTokens()
    return {
      familyId: familyId ?? '',
      userEmail: user?.email ?? '',
      members,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      googleTokens: freshTokens
        ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
        : null,
    }
  }, [familyId, user?.email, members, getFreshTokens])

  // Apply the queued actions for a given message after the user confirms
  const handleConfirm = useCallback(
    async (msgIndex: number) => {
      const msg = messages[msgIndex]
      if (!msg?.pendingActions?.length || !familyId || !user?.email) return

      setMessages((prev) =>
        prev.map((m, i) => (i === msgIndex ? { ...m, actionStatus: 'confirming' } : m)),
      )

      try {
        const freshTokens = await getFreshTokens()
        const googleTokens = freshTokens
          ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
          : null

        const res = await fetch('/api/agent/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actions: msg.pendingActions,
            familyId,
            userEmail: user.email,
            googleTokens,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Could not apply changes')

        const failed = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok)
        if (failed.length > 0) {
          const reasons = failed.map((r: { error?: string }) => r.error).filter(Boolean).join('; ')
          toast(reasons ? `Couldn't apply: ${reasons}` : `${failed.length} change(s) couldn't be applied`, 'error')
        } else {
          toast('Changes applied', 'success')
          // Signal CommandCenter to refresh calendar + re-run briefing when the
          // user navigates back home. Any confirmed action may have touched Google
          // Calendar, so we flag it unconditionally rather than inspecting actions.
          try { sessionStorage.setItem('cal-changed', '1') } catch { /* non-fatal */ }
        }

        setMessages((prev) =>
          prev.map((m, i) =>
            i === msgIndex
              ? { ...m, actionStatus: 'done', actions: data.actions ?? [] }
              : m,
          ),
        )
      } catch (e: unknown) {
        toast(e instanceof Error ? e.message : 'Could not apply changes', 'error')
        setMessages((prev) =>
          prev.map((m, i) => (i === msgIndex ? { ...m, actionStatus: 'pending' } : m)),
        )
        // eslint-disable-next-line no-console
        console.error('[copilot] execute error:', e)
      }
    },
    [messages, familyId, user?.email, getFreshTokens, toast],
  )

  const handleCancel = useCallback((msgIndex: number) => {
    setMessages((prev) =>
      prev.map((m, i) => (i === msgIndex ? { ...m, actionStatus: 'cancelled' } : m)),
    )
  }, [])

  const handleActionChange = useCallback((msgIndex: number, actionId: string, field: string, value: string) => {
    setMessages((prev) =>
      prev.map((m, i) => {
        if (i !== msgIndex) return m
        return {
          ...m,
          pendingActions: (m.pendingActions ?? []).map((a) =>
            a.id === actionId ? { ...a, input: { ...a.input, [field]: value } } : a,
          ),
        }
      }),
    )
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const isEmpty = messages.length === 0 && !loading
  // Show the typing-dots bubble only while waiting for the first token.
  const hasStreamingMessage = messages.some((m) => m.isStreaming)

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-100 bg-slate-50/80 backdrop-blur px-5 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 shadow-card">
            <Sparkles size={21} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 leading-tight">Copilot</h1>
              {debugMode && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                  <Bug size={10} /> Debug
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500 leading-tight">
              {debugMode
                ? 'Debugging mode on — I’ll cite where each fact comes from.'
                : 'Your family’s chief of staff. Ask anything, or tell me what to do.'}
            </p>
          </div>
        </div>
      </div>

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-6">
        <div className="max-w-3xl mx-auto h-full">
          {isEmpty ? (
            <EmptyState onPrompt={(p) => handleSend(p)} />
          ) : (
            <div className="space-y-5">
              {messages.map((msg, i) =>
                msg.role === 'user' ? (
                  <UserBubble key={i} msg={msg} />
                ) : (
                  <AssistantBubble
                    key={i}
                    msg={msg}
                    members={members}
                    availableCalendars={availableCalendars}
                    onConfirm={() => handleConfirm(i)}
                    onCancel={() => handleCancel(i)}
                    onActionChange={(actionId, field, value) => handleActionChange(i, actionId, field, value)}
                  />
                ),
              )}
              {/* Typing indicator only while waiting for the first token */}
              {loading && !hasStreamingMessage && <LoadingBubble />}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Sticky input bar */}
      <div className="shrink-0 border-t border-slate-100 bg-slate-50/80 backdrop-blur px-5 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto space-y-2">
          {/* Attachment previews */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pendingAttachments.map((a) => (
                <div key={a.id} className="relative group">
                  {a.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.preview}
                      alt={a.name}
                      className="h-16 w-16 rounded-xl object-cover border border-slate-200 shadow-sm"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm">
                      <FileText size={14} className="text-slate-500 shrink-0" />
                      <span className="text-xs text-slate-700 font-medium truncate max-w-[120px]">{a.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setPendingAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
            {/* Attach button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || !familyId}
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all duration-150',
                'bg-white border border-slate-200 text-slate-500 shadow-sm',
                'hover:border-blue-300 hover:text-blue-600',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'active:scale-95',
              )}
              aria-label="Attach file or image"
            >
              <Paperclip size={17} />
            </button>

            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={loading ? 'Thinking…' : 'Message Copilot…'}
              disabled={loading || !familyId}
              className={cn(
                'flex-1 rounded-full border border-slate-200 bg-white px-5 py-3 text-[15px] text-slate-900 shadow-card',
                'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-300',
                'disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150',
              )}
            />
            {(input.trim() || pendingAttachments.length > 0) ? (
              <button
                onClick={() => handleSend()}
                disabled={loading || !familyId}
                className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all duration-150',
                  'bg-gradient-to-br from-blue-600 to-purple-600 text-white shadow-card',
                  'hover:shadow-md hover:-translate-y-0.5',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0',
                  'active:scale-95',
                )}
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            ) : (
              <button
                onClick={() => setVoiceOpen(true)}
                disabled={loading || !familyId}
                className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all duration-150',
                  'bg-gradient-to-br from-blue-600 to-purple-600 text-white shadow-card',
                  'hover:shadow-md hover:-translate-y-0.5',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0',
                  'active:scale-95',
                )}
                aria-label="Start voice conversation"
              >
                <AudioLines size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {voiceOpen && (
        <RealtimeVoiceMode
          getContext={getVoiceContext}
          onUserText={(t) => setMessages((prev) => [...prev, { role: 'user', content: t }])}
          onAssistantText={(t) => setMessages((prev) => [...prev, { role: 'assistant', content: t }])}
          onClose={() => setVoiceOpen(false)}
          onError={(msg) => toast(msg, 'error')}
        />
      )}
    </div>
  )
}
