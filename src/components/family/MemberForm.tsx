'use client'

import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { MEMBER_COLORS } from '@/lib/types'
import type { FamilyMember } from '@/lib/types'
import { generateId } from '@/lib/utils'

const EMOJIS = ['👨', '👩', '🧑', '👦', '👧', '👶', '🧓', '👴', '👵', '🧒', '🧑‍💼', '🧑‍🍳', '🧑‍🎨', '🧑‍💻', '🧑‍🏫']

interface MemberFormProps {
  open: boolean
  onClose: () => void
  member?: FamilyMember
  onSave: (member: FamilyMember) => Promise<void>
}

export function MemberForm({ open, onClose, member, onSave }: MemberFormProps) {
  const [name, setName] = useState(member?.name ?? '')
  const [email, setEmail] = useState(member?.email ?? '')
  const [role, setRole] = useState<FamilyMember['role']>(member?.role ?? 'parent')
  const [emoji, setEmoji] = useState(member?.emoji ?? '👤')
  const [colorHex, setColorHex] = useState(member?.colorHex ?? MEMBER_COLORS[0])
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave({ id: member?.id ?? generateId(), name, email, role, emoji, colorHex })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={member ? 'Edit Member' : 'Add Family Member'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input placeholder="Google account email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        <Select value={role} onChange={(e) => setRole(e.target.value as FamilyMember['role'])}>
          <option value="parent">Parent</option>
          <option value="child">Child</option>
          <option value="other">Other</option>
        </Select>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Emoji Avatar</p>
          <div className="flex flex-wrap gap-2">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEmoji(e)}
                className={`text-xl p-1 rounded-lg border-2 transition-colors ${emoji === e ? 'border-blue-500 bg-blue-50' : 'border-transparent hover:bg-gray-50'}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Color</p>
          <div className="flex flex-wrap gap-2">
            {MEMBER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColorHex(c)}
                className={`w-7 h-7 rounded-full border-2 transition-all ${colorHex === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving} className="flex-1">{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  )
}
