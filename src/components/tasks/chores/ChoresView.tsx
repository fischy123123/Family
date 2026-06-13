'use client'

import { useState } from 'react'
import { Plus, CheckCircle2, Dumbbell } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { ChoreForm } from './ChoreForm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Chore, FamilyMember } from '@/lib/types'
import { isChoreDueToday, recurrenceLabel } from '@/lib/recurrence'

export function ChoresView() {
  const { data: chores, create, update, remove } = useFirestore<Chore>('chores')
  const { data: members } = useFirestore<FamilyMember>('members')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Chore>()

  const todayChores = chores.filter(isChoreDueToday)
  const allChores = chores

  async function markDone(chore: Chore) {
    const today = new Date().toISOString().split('T')[0]
    const newStreak = (chore.lastCompletedDate === today ? chore.streak : chore.streak + 1)
    await update({ ...chore, lastCompletedDate: today, streak: newStreak })
  }

  function getMemberName(email: string): string {
    return members.find((m) => m.email === email)?.name ?? email.split('@')[0] ?? 'Anyone'
  }

  function getMemberEmoji(email: string): string {
    return members.find((m) => m.email === email)?.emoji ?? '👤'
  }

  const ChoreCard = ({ chore, showDoneBadge }: { chore: Chore; showDoneBadge?: boolean }) => {
    const doneToday = chore.lastCompletedDate === new Date().toISOString().split('T')[0]
    return (
      <div
        className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm"
        style={{ borderLeftColor: chore.colorHex, borderLeftWidth: 3 }}
      >
        <div className="text-xl shrink-0">{getMemberEmoji(chore.assigneeEmail)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900">{chore.name}</p>
            {chore.streak > 0 && (
              <span className="text-xs text-orange-500 font-medium">🔥{chore.streak}</span>
            )}
            {doneToday && showDoneBadge && <Badge className="text-xs bg-green-100 text-green-700">Done today</Badge>}
          </div>
          <p className="text-xs text-gray-400">
            {getMemberName(chore.assigneeEmail)} · {recurrenceLabel(chore.recurrence)}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {!doneToday && (
            <button
              onClick={() => markDone(chore)}
              className="flex items-center gap-1 text-xs text-green-600 font-medium px-2 py-1 rounded-lg hover:bg-green-50 border border-green-200"
            >
              <CheckCircle2 size={14} /> Done
            </button>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setEditing(chore); setFormOpen(true) }}>
            Edit
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Chores</h1>
        <Button size="sm" onClick={() => { setEditing(undefined); setFormOpen(true) }}>
          <Plus size={16} className="mr-1" /> Add
        </Button>
      </div>

      {todayChores.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Due Today · {todayChores.length}
          </h2>
          <div className="space-y-2">
            {todayChores.map((c) => <ChoreCard key={c.id} chore={c} showDoneBadge />)}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">All Chores</h2>
        {allChores.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Dumbbell size={40} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Add recurring chores for family members</p>
          </div>
        ) : (
          <div className="space-y-2">
            {allChores.map((c) => <ChoreCard key={c.id} chore={c} />)}
          </div>
        )}
      </div>

      <ChoreForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        chore={editing}
        members={members}
        onSave={async (c) => { editing ? await update(c) : await create(c) }}
        onDelete={editing ? async () => await remove(editing.id) : undefined}
      />
    </div>
  )
}
