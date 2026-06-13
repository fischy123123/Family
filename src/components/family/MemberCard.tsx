import { Pencil } from 'lucide-react'
import type { FamilyMember } from '@/lib/types'

interface MemberCardProps {
  member: FamilyMember
  onEdit: () => void
}

export function MemberCard({ member, onEdit }: MemberCardProps) {
  return (
    <div
      className="relative rounded-xl p-4 flex flex-col items-center gap-2 border border-gray-100 shadow-sm"
      style={{ backgroundColor: `${member.colorHex}15` }}
    >
      <button
        onClick={onEdit}
        className="absolute top-2 right-2 p-1 rounded-lg hover:bg-white/60 text-gray-400"
      >
        <Pencil size={12} />
      </button>
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center text-3xl border-2"
        style={{ borderColor: member.colorHex, backgroundColor: `${member.colorHex}25` }}
      >
        {member.emoji}
      </div>
      <p className="font-semibold text-gray-900 text-sm">{member.name}</p>
      <span
        className="text-xs px-2 py-0.5 rounded-full text-white font-medium"
        style={{ backgroundColor: member.colorHex }}
      >
        {member.role}
      </span>
    </div>
  )
}
