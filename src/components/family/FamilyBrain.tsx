'use client'

import { useState } from 'react'
import { Plus, Users, Copy, Check, Brain, ChevronRight } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { MemberDetail } from './MemberDetail'
import { MemberForm } from './MemberForm'
import type { FamilyMember } from '@/lib/types'

function entryCount(m: FamilyMember): number {
  return (
    (m.routines?.length ?? 0) +
    (m.preferences?.length ?? 0) +
    (m.importantInfo?.length ?? 0) +
    (m.memories?.length ?? 0)
  )
}

type View =
  | { kind: 'grid' }
  | { kind: 'detail'; memberId: string }
  | { kind: 'form'; member?: FamilyMember }

export function FamilyBrain() {
  const { data: members, loading } = useFirestore<FamilyMember>('members')
  const [view, setView] = useState<View>({ kind: 'grid' })

  if (view.kind === 'form') {
    return <MemberForm member={view.member} onDone={() => setView({ kind: 'grid' })} />
  }

  if (view.kind === 'detail') {
    const member = members.find((m) => m.id === view.memberId)
    if (member) {
      return <MemberDetail member={member} onBack={() => setView({ kind: 'grid' })} />
    }
    // Member vanished (deleted) — fall back to grid
    setTimeout(() => setView({ kind: 'grid' }), 0)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 animate-fade-in">
      <Header onAdd={() => setView({ kind: 'form' })} />

      <InviteCard />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : members.length === 0 ? (
        <EmptyState onAdd={() => setView({ kind: 'form' })} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger-children">
          {members.map((m) => (
            <MemberGridCard
              key={m.id}
              member={m}
              onClick={() => setView({ kind: 'detail', memberId: m.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Header({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Family</h1>
        <p className="text-slate-500 mt-1">Everything FamilyOS knows about your household</p>
      </div>
      <Button
        onClick={onAdd}
        className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shrink-0"
      >
        <Plus size={18} className="mr-1.5" />
        Add Member
      </Button>
    </div>
  )
}

function InviteCard() {
  const { inviteCode } = useFamily()
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  if (!inviteCode) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteCode!)
      setCopied(true)
      toast('Invite code copied', 'success')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast('Could not copy code', 'error')
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5 mb-6 flex items-center justify-between gap-4 animate-scale-in">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
          Family invite code
        </p>
        <p className="text-2xl font-mono font-bold tracking-[0.3em] bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          {inviteCode}
        </p>
        <p className="text-sm text-slate-500 mt-1.5">Share this code so others can join your family</p>
      </div>
      <Button variant="outline" onClick={copy} className="shrink-0">
        {copied ? <Check size={16} className="mr-1.5 text-green-600" /> : <Copy size={16} className="mr-1.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function MemberGridCard({ member, onClick }: { member: FamilyMember; onClick: () => void }) {
  const count = entryCount(member)
  return (
    <button
      onClick={onClick}
      className="group text-left bg-white rounded-2xl shadow-card border border-slate-100 p-5 flex items-center gap-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div
        className="h-14 w-14 rounded-full flex items-center justify-center text-2xl shrink-0"
        style={{ backgroundColor: `${member.colorHex}40` }}
      >
        {member.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-slate-900 truncate">{member.name}</p>
        <p className="text-sm text-slate-500 capitalize">{member.role}</p>
        <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
          <Brain size={12} />
          {count} {count === 1 ? 'entry' : 'entries'}
        </p>
      </div>
      <ChevronRight size={18} className="text-slate-300 group-hover:text-slate-400 transition-colors shrink-0" />
    </button>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 py-16 px-6 text-center animate-scale-in">
      <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-blue-100 to-purple-100 flex items-center justify-center mx-auto mb-4">
        <Users size={28} className="text-blue-600" />
      </div>
      <h3 className="text-lg font-bold text-slate-900">No family members yet</h3>
      <p className="text-slate-500 mt-1 max-w-sm mx-auto">
        Add the people in your household to start building their profiles in the Family Brain.
      </p>
      <Button
        onClick={onAdd}
        className="mt-5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
      >
        <Plus size={18} className="mr-1.5" />
        Add your first member
      </Button>
    </div>
  )
}
