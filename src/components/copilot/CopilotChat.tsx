'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send,
  Sparkles,
  Bot,
  CheckCircle2,
  AlertTriangle,
  CalendarDays,
  ShoppingCart,
  ListChecks,
  Plane,
} from 'lucide-react'
import { format } from 'date-fns'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useToast } from '@/contexts/ToastContext'
import { MicButton } from '@/components/ui/MicButton'
import { Markdown } from '@/components/ui/Markdown'
import { ProposedActions, type PendingAction, type ActionStatus } from '@/components/copilot/ProposedActions'
import { cn } from '@/lib/utils'
import type { FamilyMember } from '@/lib/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: 'user' | 'assistant'
  content: string
  actions?: string[]
  pendingActions?: PendingAction[]
  actionStatus?: ActionStatus
}

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
  onConfirm,
  onCancel,
}: {
  msg: Message
  members: FamilyMember[]
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-start gap-3 animate-slide-up">
      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 shadow-card mt-0.5">
        <Bot size={17} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 max-w-[85%]">
        <div className="bg-white border border-slate-100 shadow-card rounded-2xl rounded-tl-md px-4 py-3">
          <Markdown content={msg.content} />
        </div>
        {msg.pendingActions && msg.pendingActions.length > 0 && (
          <ProposedActions
            actions={msg.pendingActions}
            members={members}
            status={msg.actionStatus ?? 'pending'}
            onConfirm={onConfirm}
            onCancel={onCancel}
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
      <div className="max-w-[80%]">
        <div className="bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-2xl rounded-tr-md px-4 py-3 shadow-card">
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
        </div>
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Seed the conversation from another screen (e.g. tapping the Home briefing).
  // The briefing prose lands as the opening assistant message so the user can
  // immediately ask follow-ups or have the assistant act on it.
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


  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      if (!content || loading || !familyId || !user?.email) return

      const userMsg: Message = { role: 'user', content }

      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setLoading(true)

      try {
        const freshTokens = await getFreshTokens()
        const googleTokens = freshTokens
          ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
          : null

        const history = [...messages, userMsg].map((m) => ({
          role: m.role,
          content: m.content,
        }))

        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history,
            familyId,
            userEmail: user.email,
            googleTokens,
            context: {
              members,
              today: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss (EEEE, MMMM d, yyyy)"),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Request failed' }))
          throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
        }

        const data = (await res.json()) as {
          reply: string
          actions: string[]
          pendingActions?: PendingAction[]
        }

        const hasPending = (data.pendingActions?.length ?? 0) > 0
        const assistantMsg: Message = {
          role: 'assistant',
          content: data.reply || (hasPending ? "Here's what I'll do — confirm to apply." : 'Done.'),
          actions: hasPending ? [] : (data.actions ?? []),
          pendingActions: data.pendingActions ?? [],
          actionStatus: hasPending ? 'pending' : undefined,
        }
        setMessages((prev) => [...prev, assistantMsg])
      } catch (e: unknown) {
        const errorReply: Message = {
          role: 'assistant',
          content: 'Sorry, something went wrong.',
          actions: [],
        }
        setMessages((prev) => [...prev, errorReply])
        toast('Something went wrong. Please try again.', 'error')
        // eslint-disable-next-line no-console
        console.error('[copilot] error:', e)
      } finally {
        setLoading(false)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    },
    [input, loading, familyId, user?.email, members, messages, getFreshTokens, toast],
  )

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
            // Required so Google Calendar events created from queued actions get
            // the user's timezone. Without it Google rejects datetimes that have
            // no UTC offset (which is how the AI emits them).
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Could not apply changes')

        const failed = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok)
        if (failed.length > 0) {
          toast(`${failed.length} change(s) couldn't be applied`, 'error')
        } else {
          toast('Changes applied', 'success')
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const isEmpty = messages.length === 0 && !loading

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-100 bg-slate-50/80 backdrop-blur px-5 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shrink-0 shadow-card">
            <Sparkles size={21} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-slate-900 leading-tight">Copilot</h1>
            <p className="text-sm text-slate-500 leading-tight">
              Your family&apos;s chief of staff. Ask anything, or tell me what to do.
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
                    onConfirm={() => handleConfirm(i)}
                    onCancel={() => handleCancel(i)}
                  />
                ),
              )}
              {loading && <LoadingBubble />}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Sticky input bar */}
      <div className="shrink-0 border-t border-slate-100 bg-slate-50/80 backdrop-blur px-5 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
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
          <MicButton
            size={48}
            className="!rounded-full"
            onText={(spoken) => setInput((prev) => (prev ? prev.trim() + ' ' : '') + spoken)}
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim() || !familyId}
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
        </div>
      </div>
    </div>
  )
}
