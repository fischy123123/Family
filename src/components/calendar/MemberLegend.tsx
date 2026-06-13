import type { FamilyMember } from '@/lib/types'

export function MemberLegend({ members }: { members: FamilyMember[] }) {
  if (members.length === 0) return null
  return (
    <div className="flex flex-wrap gap-3 mb-3">
      {members.map((m) => (
        <div key={m.id} className="flex items-center gap-1.5 text-xs text-gray-600">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.colorHex }} />
          <span>{m.name}</span>
        </div>
      ))}
    </div>
  )
}
