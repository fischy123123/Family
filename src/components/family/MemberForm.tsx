'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { MEMBER_COLORS } from '@/lib/types'
import type { FamilyMember } from '@/lib/types'
import { generateId } from '@/lib/utils'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Check } from 'lucide-react'

const EMOJIS = ['👨', '👩', '🧑', '👦', '👧', '👶', '🧓', '👴', '👵', '🧒']

interface MemberFormProps {
  member?: FamilyMember
  onDone: () => void
}

export function MemberForm({ member, onDone }: MemberFormProps) {
  const { create, update } = useFirestore<FamilyMember>('members')
  const { toast } = useToast()

  const [name, setName] = useState(member?.name ?? '')
  const [email, setEmail] = useState(member?.email ?? '')
  const [role, setRole] = useState<FamilyMember['role']>(member?.role ?? 'parent')
  const [emoji, setEmoji] = useState(member?.emoji ?? '🧑')
  const [colorHex, setColorHex] = useState(member?.colorHex ?? MEMBER_COLORS[0])
  const [birthday, setBirthday] = useState(member?.birthday ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast('Please enter a name', 'error')
      return
    }
    setSaving(true)
    try {
      if (member) {
        const updated: FamilyMember = {
          ...member,
          name: name.trim(),
          email: email.trim(),
          role,
          emoji,
          colorHex,
          ...(birthday ? { birthday } : {}),
        }
        if (!birthday) delete updated.birthday
        await update(updated)
        toast('Member updated', 'success')
      } else {
        await create({
          id: generateId(),
          name: name.trim(),
          email: email.trim(),
          role,
          emoji,
          colorHex,
          ...(birthday ? { birthday } : {}),
        })
        toast('Member added', 'success')
      }
      onDone()
    } catch {
      toast('Could not save member', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-6 animate-slide-up">
      <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 sm:p-8">
        <h2 className="text-2xl font-bold text-slate-900 mb-1">
          {member ? 'Edit member' : 'Add a family member'}
        </h2>
        <p className="text-slate-500 mb-6">
          {member ? 'Update the basics for this person.' : 'Start building their profile in the Family Brain.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Name</label>
            <Input placeholder="e.g. Maya" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Email <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <Input
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
            <Select value={role} onChange={(e) => setRole(e.target.value as FamilyMember['role'])}>
              <option value="parent">Parent</option>
              <option value="child">Child</option>
              <option value="other">Other</option>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Avatar</label>
            <div className="flex flex-wrap gap-2">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  className={`text-2xl h-11 w-11 flex items-center justify-center rounded-xl border-2 transition-all ${
                    emoji === e
                      ? 'border-blue-500 bg-blue-50 scale-105'
                      : 'border-transparent hover:bg-slate-50'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
            <div className="flex flex-wrap gap-2.5">
              {MEMBER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColorHex(c)}
                  className={`h-9 w-9 rounded-full flex items-center justify-center transition-all ${
                    colorHex === c ? 'ring-2 ring-offset-2 ring-slate-900 scale-110' : 'hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={`Color ${c}`}
                >
                  {colorHex === c && <Check size={16} className="text-white" />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Birthday <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onDone} className="flex-1">
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
            >
              {saving ? 'Saving…' : member ? 'Save changes' : 'Add member'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
