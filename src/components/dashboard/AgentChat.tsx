'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Sparkles, Bot, User } from 'lucide-react'
import { format } from 'date-fns'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { cn } from '@/lib/utils'
import type { FamilyMember } from '@/lib/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: 'user' | 'assistant'
  content: string
  actions?: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXAMPLE_PROMPTS = [
  "What's on this week?",
  'Add milk to shopping',
  'Plan dinner for tonight',
  'What chores are due?',
  'Remind me to call dentist Thursday',
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThinkingIndicator() {
  return (
    <div className="flex items-start gap-2.5 animate-fade-in">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-sm">
        <Bot size={14} className="text-white" />
      </div>
      <div className="bg-white border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0ms]" />
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:150ms]" />
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

function ActionPills({ actions }: { actions: string[] }) {
  if (!actions.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map((action, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          {action}
        </span>
      ))}
    </div>
  )
}

function AssistantMessage({ msg }: { msg: Message }) {
  return (
    <div className="flex items-start gap-2.5 animate-fade-in">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
        <Bot size={14} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 max-w-[85%]">
        <div className="bg-white border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
        </div>
        {msg.actions && <ActionPills actions={msg.actions} />}
      </div>
    </div>
  )
}

function UserMessage({ msg }: { msg: Message }) {
  return (
    <div className="flex items-start gap-2.5 justify-end animate-fade-in">
      <div className="flex-1 min-w-0 max-w-[85%] flex flex-col items-end">
        <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl rounded-tr-sm px-4 py-3 shadow-sm">
          <p className="text-sm text-white leading-relaxed">{msg.content}</p>
        </div>
      </div>
      <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
        <User size={14} className="text-blue-600" />
      </div>
    </div>
  )
}

function EmptyState({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-6 px-4">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-3 shadow-md">
        <Sparkles size={22} className="text-white" />
      </div>
      <p className="text-sm font-semibold text-gray-800 mb-1">Family Assistant</p>
      <p className="text-xs text-gray-400 text-center mb-5 max-w-[220px]">
        Ask me anything about your family schedule, or let me help you get things done.
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPrompt(prompt)}
            className="text-[11px] font-medium bg-gray-50 hover:bg-indigo-50 text-gray-600 hover:text-indigo-700 border border-gray-200 hover:border-indigo-200 rounded-full px-3 py-1.5 transition-all duration-150"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentChat() {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { getFreshTokens } = useGoogleTokens()

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom when messages change or while loading
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      if (!content || loading || !familyId || !user?.email) return

      const userMsg: Message = { role: 'user', content }

      // Optimistically add user message and clear input
      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setLoading(true)

      try {
        // Get fresh google tokens (auto-refreshes if needed)
        const freshTokens = await getFreshTokens()
        const googleTokens = freshTokens
          ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
          : null

        // Build the conversation history for the API (only user/assistant roles)
        // Keep the last 10 messages as context
        const history = [...messages, userMsg].slice(-10)

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
            },
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Request failed' }))
          throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
        }

        const data = await res.json() as { reply: string; actions: string[] }

        const assistantMsg: Message = {
          role: 'assistant',
          content: data.reply || 'Done.',
          actions: data.actions ?? [],
        }

        setMessages((prev) => [...prev, assistantMsg])
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : 'Something went wrong'
        const errorReply: Message = {
          role: 'assistant',
          content: `Sorry, I ran into an error: ${errMsg}`,
          actions: [],
        }
        setMessages((prev) => [...prev, errorReply])
      } finally {
        setLoading(false)
        // Re-focus input after response
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    },
    [input, loading, familyId, user?.email, members, messages, getFreshTokens],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const visibleMessages = messages.slice(-10)
  const isEmpty = messages.length === 0 && !loading

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 px-4 py-3.5 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
          <Sparkles size={15} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white leading-none">Family Assistant</p>
          <p className="text-[11px] text-white/60 mt-0.5">Powered by Claude</p>
        </div>
        {/* Online status */}
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-white/60 font-medium">Online</span>
        </div>
      </div>

      {/* Messages area */}
      <div
        className={cn(
          'flex-1 overflow-y-auto px-4 py-4 space-y-4',
          isEmpty ? 'h-[280px]' : 'max-h-[320px] min-h-[200px]',
        )}
      >
        {isEmpty ? (
          <EmptyState onPrompt={(p) => handleSend(p)} />
        ) : (
          <>
            {visibleMessages.map((msg, i) =>
              msg.role === 'user' ? (
                <UserMessage key={i} msg={msg} />
              ) : (
                <AssistantMessage key={i} msg={msg} />
              ),
            )}
            {loading && <ThinkingIndicator />}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Divider */}
      <div className="border-t border-gray-100" />

      {/* Input area */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={loading ? 'Thinking…' : 'Ask anything or give a command…'}
              disabled={loading || !familyId}
              className={cn(
                'w-full rounded-full border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900',
                'placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-300 focus:bg-white',
                'disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150',
              )}
            />
          </div>
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim() || !familyId}
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all duration-150',
              'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm',
              'hover:from-indigo-600 hover:to-purple-700 hover:shadow-md',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none',
              'active:scale-95',
            )}
            aria-label="Send message"
          >
            <Send size={15} />
          </button>
        </div>

        {/* Quick-prompt chips — shown only after first few messages */}
        {messages.length > 0 && messages.length < 4 && !loading && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {EXAMPLE_PROMPTS.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                onClick={() => handleSend(prompt)}
                disabled={loading}
                className="text-[10px] font-medium bg-gray-50 hover:bg-indigo-50 text-gray-500 hover:text-indigo-600 border border-gray-200 hover:border-indigo-200 rounded-full px-2.5 py-1 transition-all duration-150 disabled:opacity-40"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
