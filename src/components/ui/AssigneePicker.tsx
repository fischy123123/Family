'use client'

import { Check, UserPlus } from 'lucide-react'
import type { FamilyMember } from '@/lib/types'
import { assignableMembers } from '@/lib/members'

// A compact, always-visible chip row for assigning a single member by id.
// Used everywhere assignment happens so the UX and identity model are
// consistent across the app. Pass `value` as a member id (or undefined for
// "Anyone") and get the new id back from `onChange`.
export function AssigneePicker({
  members,
  value,
  onChange,
  includePets = true,
  label = 'Assign to',
}: {
  members: FamilyMember[]
  value?: string
  onChange: (memberId: string | undefined) => void
  includePets?: boolean
  label?: string
}) {
  const list = assignableMembers(members).filter((m) => includePets || m.role !== 'pet')

  return (
    <div>
      {label && <p className="text-[11px] font-medium text-slate-500 mb-1.5">{label}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Chip
          selected={!value}
          colorHex="#94a3b8"
          onClick={() => onChange(undefined)}
        >
          <UserPlus size={11} className="shrink-0" />
          Anyone
        </Chip>
        {list.map((m) => (
          <Chip
            key={m.id}
            selected={value === m.id}
            colorHex={m.colorHex}
            onClick={() => onChange(value === m.id ? undefined : m.id)}
          >
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
              style={{ background: `${m.colorHex}25` }}
            >
              {m.emoji}
            </span>
            {m.name}
            {value === m.id && <Check size={11} />}
          </Chip>
        ))}
      </div>
    </div>
  )
}

// Multi-select variant: who is this task FOR / ABOUT (e.g. a child's appointment).
// Value is an array of member ids; "Anyone" = empty array.
export function ForPicker({
  members,
  value,
  onChange,
  label = 'For (about)',
}: {
  members: FamilyMember[]
  value: string[]
  onChange: (memberIds: string[]) => void
  label?: string
}) {
  const list = assignableMembers(members)

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  return (
    <div>
      {label && <p className="text-[11px] font-medium text-slate-500 mb-1.5">{label}</p>}
      <div className="flex flex-wrap gap-1.5">
        {list.map((m) => (
          <Chip
            key={m.id}
            selected={value.includes(m.id)}
            colorHex={m.colorHex}
            onClick={() => toggle(m.id)}
          >
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
              style={{ background: `${m.colorHex}25` }}
            >
              {m.emoji}
            </span>
            {m.name}
            {value.includes(m.id) && <Check size={11} />}
          </Chip>
        ))}
      </div>
    </div>
  )
}

function Chip({
  selected,
  colorHex,
  onClick,
  children,
}: {
  selected: boolean
  colorHex: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all border"
      style={{
        background: selected ? `${colorHex}20` : 'white',
        borderColor: selected ? colorHex : '#e2e8f0',
        color: selected ? '#0f172a' : '#64748b',
        fontWeight: selected ? 600 : 400,
      }}
    >
      {children}
    </button>
  )
}
