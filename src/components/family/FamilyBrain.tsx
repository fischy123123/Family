'use client'

import { useState } from 'react'
import { Plus, Users, Copy, Check, Brain, ChevronRight, PawPrint, Crown, Star } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { MemberDetail } from './MemberDetail'
import { MemberForm } from './MemberForm'
import { HouseholdProfile } from './HouseholdProfile'
import { FamilyMemories } from './FamilyMemories'
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
  const { user } = useAuth()
  const [view, setView] = useState<View>({ kind: 'grid' })

  if (view.kind === 'form') {
    return <MemberForm member={view.member} onDone={() => setView({ kind: 'grid' })} />
  }

  if (view.kind === 'detail') {
    const member = members.find((m) => m.id === view.memberId)
    if (member) {
      return (
        <MemberDetail
          member={member}
          isCurrentUser={member.email?.toLowerCase() === user?.email?.toLowerCase()}
          onBack={() => setView({ kind: 'grid' })}
        />
      )
    }
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
        <FamilyTree
          members={members}
          userEmail={user?.email ?? null}
          onSelect={(m) => setView({ kind: 'detail', memberId: m.id })}
          onAdd={() => setView({ kind: 'form' })}
        />
      )}

      {/* Household-level brain: the lens + durable memory the assistant uses */}
      <div className="mt-8">
        <HouseholdProfile />
        <FamilyMemories />
      </div>
    </div>
  )
}

function Header({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Family</h1>
        <p className="text-slate-500 mt-1">Everyone FamilyOS knows and loves</p>
      </div>
      <Button
        onClick={onAdd}
        className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shrink-0"
      >
        <Plus size={18} className="mr-1.5" />
        Add
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

// ── Family Tree ─────────────────────────────────────────────

function FamilyTree({
  members,
  userEmail,
  onSelect,
  onAdd,
}: {
  members: FamilyMember[]
  userEmail: string | null
  onSelect: (m: FamilyMember) => void
  onAdd: () => void
}) {
  const parents = members.filter((m) => m.role === 'parent')
  const children = members.filter((m) => m.role === 'child')
  const pets = members.filter((m) => m.role === 'pet')
  const others = members.filter((m) => m.role === 'other')

  return (
    <div className="space-y-2">
      {parents.length > 0 && (
        <TreeRow
          label="Parents"
          icon={<Crown size={14} />}
          iconColor="text-amber-500"
          members={parents}
          userEmail={userEmail}
          onSelect={onSelect}
          connector="down"
        />
      )}

      {children.length > 0 && (
        <TreeRow
          label="Children"
          icon={<Star size={14} />}
          iconColor="text-blue-500"
          members={children}
          userEmail={userEmail}
          onSelect={onSelect}
          connector={pets.length > 0 || others.length > 0 ? 'down' : undefined}
          indented={parents.length > 0}
        />
      )}

      {pets.length > 0 && (
        <TreeRow
          label="Pets"
          icon={<PawPrint size={14} />}
          iconColor="text-green-500"
          members={pets}
          userEmail={userEmail}
          onSelect={onSelect}
          indented={parents.length > 0 || children.length > 0}
        />
      )}

      {others.length > 0 && (
        <TreeRow
          label="Household"
          icon={<Users size={14} />}
          iconColor="text-purple-500"
          members={others}
          userEmail={userEmail}
          onSelect={onSelect}
        />
      )}

      <button
        onClick={onAdd}
        className="mt-4 w-full flex items-center justify-center gap-2 p-3 rounded-2xl border-2 border-dashed border-slate-200 text-sm font-medium text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-all"
      >
        <Plus size={16} />
        Add family member or pet
      </button>
    </div>
  )
}

function TreeRow({
  label,
  icon,
  iconColor,
  members,
  userEmail,
  onSelect,
  connector,
  indented,
}: {
  label: string
  icon: React.ReactNode
  iconColor: string
  members: FamilyMember[]
  userEmail: string | null
  onSelect: (m: FamilyMember) => void
  connector?: 'down'
  indented?: boolean
}) {
  return (
    <div className={indented ? 'ml-0 sm:ml-4' : ''}>
      {/* Section label */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <span className={`${iconColor}`}>{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        <span className="flex-1 h-px bg-slate-100" />
      </div>

      {/* Member cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {members.map((m) => (
          <MemberTreeCard
            key={m.id}
            member={m}
            isMe={!!userEmail && m.email?.toLowerCase() === userEmail.toLowerCase()}
            onClick={() => onSelect(m)}
          />
        ))}
      </div>

      {/* Connector to next section */}
      {connector === 'down' && (
        <div className="flex justify-center mt-2 mb-0">
          <div className="w-px h-5 bg-slate-200" />
        </div>
      )}
    </div>
  )
}

function MemberTreeCard({
  member,
  isMe,
  onClick,
}: {
  member: FamilyMember
  isMe: boolean
  onClick: () => void
}) {
  const count = entryCount(member)
  return (
    <button
      onClick={onClick}
      className="group text-left bg-white rounded-2xl shadow-card border border-slate-100 p-4 flex items-center gap-3 transition-all hover:-translate-y-0.5 hover:shadow-md relative"
    >
      {/* "YOU" badge */}
      {isMe && (
        <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white leading-none">
          YOU
        </span>
      )}

      <div
        className="h-12 w-12 rounded-full flex items-center justify-center text-2xl shrink-0"
        style={{ backgroundColor: `${member.colorHex}40` }}
      >
        {member.emoji}
      </div>
      <div className="flex-1 min-w-0 pr-6">
        <p className="font-bold text-slate-900 truncate">{member.name}</p>
        {member.species ? (
          <p className="text-sm text-slate-500 truncate">{member.species}</p>
        ) : (
          <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
            <Brain size={11} />
            {count} {count === 1 ? 'entry' : 'entries'}
          </p>
        )}
      </div>
      <ChevronRight size={16} className="text-slate-300 group-hover:text-slate-400 transition-colors shrink-0 absolute right-3 bottom-auto" />
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
        Add the people (and pets!) in your household to start building their profiles.
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
