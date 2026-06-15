'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, Bot, Loader2, X } from 'lucide-react'
import { InsightCard } from './InsightCard'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import type { CoachingInsight, FamilyMember } from '@/lib/types'

interface ThreadMsg { role: 'user' | 'assistant'; content: string }

export function InsightCardWithThread({
  insight, onDismiss, onAcknowledge, onAction,
}: {
  insight: CoachingInsight
  onDismiss?: () => void
  onAcknowledge?: () => void
  onAction?: (insight: CoachingInsight) => void
}) {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { getFreshTokens } = useGoogleTokens()

  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<ThreadMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80)
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [thread, loading])

  async function handleSend() {
    const content = input.trim()
    if (!content || loading || !familyId || !user?.email) return

    const userMsg: ThreadMsg = { role: 'user', content }
    setThread(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const freshTokens = await getFreshTokens()
      const googleTokens = freshTokens
        ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
        : null

      // Seed the history with the insight context so the copilot understands what's being discussed.
      const seed = `I'm responding to a coaching insight: "${insight.title}". ${insight.detail}${insight.question ? ` The coach asked: "${insight.question}"` : ''}`
      const history = [
        { role: 'user' as const, content: seed },
        ...thread.map(m => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content },
      ]

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
            today: new Date().toLocaleString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
      })

      const data = await res.json()
      setThread(prev => [...prev, { role: 'assistant', content: data.reply || 'Got it.' }])
    } catch {
      setThread(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong.' }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  return (
    <div>
      <InsightCard
        insight={insight}
        onDismiss={onDismiss}
        onAcknowledge={onAcknowledge}
        onAction={onAction}
        onRespond={() => setOpen(v => !v)}
      />

      {open && (
        <div className="mt-1 rounded-2xl bg-white shadow-card border border-slate-100 overflow-hidden animate-slide-up">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Reply to your coach</p>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-lg text-slate-300 hover:text-slate-500 transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {thread.length > 0 && (
            <div className="px-4 pb-1 space-y-2 max-h-56 overflow-y-auto">
              {thread.map((msg, i) =>
                msg.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="bg-blue-600 text-white text-xs rounded-xl rounded-tr-sm px-3 py-2 max-w-[88%] leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot size={11} className="text-white" />
                    </div>
                    <div className="text-xs text-slate-700 bg-slate-50 rounded-xl rounded-tl-sm px-3 py-2 max-w-[88%] leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                )
              )}
              {loading && (
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0">
                    <Loader2 size={11} className="text-white animate-spin" />
                  </div>
                  <div className="text-xs text-slate-400 italic">thinking…</div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}

          <div className="flex items-end gap-2 px-3 py-3 border-t border-slate-100">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
              }}
              placeholder={insight.question ?? 'Reply to your coach…'}
              rows={2}
              className="flex-1 text-xs resize-none rounded-xl px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50 leading-relaxed"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="w-8 h-8 rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0 disabled:opacity-40 transition-opacity"
            >
              <Send size={13} className="text-white" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
