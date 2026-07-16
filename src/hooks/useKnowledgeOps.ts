'use client'

import { useMemo } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { generateId } from '@/lib/utils'
import { resolveMemberRef } from '@/lib/members'
import type { FamilyMember, FamilyMemory, FamilyGoal, FamilyProfile, PersonalProfile, LifeArea, ProspectiveTrigger } from '@/lib/types'

// The client half of the interview system's knowledge pipeline: building the
// "everything we know" digest the engines read, and applying the structured
// ops they emit back into Firestore. Shared by the one-question-a-day card
// and the deep-dive session so knowledge lands identically from both.

export type IngestOp =
  | { op: 'add_memory'; text: string; category?: FamilyMemory['category']; subjectNames?: string[]; expiresAt?: string }
  | { op: 'update_memory'; id: string; text: string }
  | { op: 'expire_memory'; id: string }
  | { op: 'refresh_memory'; id: string }
  | { op: 'deactivate_goal'; id: string }
  | { op: 'add_goal'; text: string; area?: LifeArea; cadence?: string; why?: string }
  | { op: 'add_trigger'; condition: string; action: string }
  | { op: 'update_profile'; patch: Partial<PersonalProfile> }

const PROFILE_KEYS: (keyof PersonalProfile)[] = [
  'goals', 'biggestStruggle', 'energizers', 'drainers', 'startStrategies', 'avoiding',
  'rhythm', 'fixedAnchors', 'householdRoles', 'careSchedule', 'planStyle', 'protectRest',
  'nonNegotiables', 'freeform',
]

const STALE_MS = 45 * 24 * 60 * 60 * 1000

// One human-readable line per applied op — shown in the session's "captured" tray.
export function describeOp(op: IngestOp): string {
  switch (op.op) {
    case 'add_memory': return `Remembered: ${op.text}`
    case 'update_memory': return `Updated: ${op.text}`
    case 'expire_memory': return 'Cleared an outdated fact'
    case 'refresh_memory': return 'Re-confirmed a known fact'
    case 'deactivate_goal': return 'Retired a goal that no longer matters'
    case 'add_goal': return `New goal: ${op.text}`
    case 'add_trigger': return `I'll remind you when ${op.condition}: ${op.action}`
    case 'update_profile': return `Profile updated (${Object.keys(op.patch ?? {}).join(', ')})`
    default: return 'Noted'
  }
}

export function useKnowledgeOps() {
  const { user } = useAuth()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { data: memories, create: createMemory, update: updateMemory } = useFirestore<FamilyMemory>('memories')
  const { data: goals, create: createGoal, update: updateGoal } = useFirestore<FamilyGoal>('goals')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')
  const { data: personalProfiles, create: createPP, update: updatePP } = useFirestore<PersonalProfile>('personalProfiles')
  const { create: createTrigger } = useFirestore<ProspectiveTrigger>('triggers')

  const myKey = user?.email ? user.email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() : null
  const myProfile = useMemo(() => (myKey ? personalProfiles.find((p) => p.id === myKey) ?? null : null), [personalProfiles, myKey])

  function buildDigest(recentQuestions?: string[]) {
    const today = new Date().toISOString().slice(0, 10)
    const active = memories.filter((m) => !m.expiresAt || m.expiresAt >= today)
    return {
      members: members.map((m) => ({ name: m.name, role: m.role })),
      profile: profiles[0] ?? null,
      personalProfile: myProfile,
      memories: active.slice(0, 80).map((m) => {
        const freshest = m.confirmedAt ?? m.createdAt
        return {
          id: m.id, text: m.text, category: m.category,
          notedOn: (freshest ?? '').slice(0, 10),
          aging: !m.pinned && Date.now() - new Date(freshest).getTime() > STALE_MS,
          pinned: m.pinned,
        }
      }),
      goals: goals.filter((g) => g.active).map((g) => ({ id: g.id, text: g.text, area: g.area, cadence: g.cadence })),
      ...(recentQuestions?.length ? { recentQuestions } : {}),
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  async function applyOps(ops: IngestOp[]): Promise<IngestOp[]> {
    const applied: IngestOp[] = []
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    for (const op of ops) {
      try {
        if (op.op === 'add_memory' && op.text?.trim()) {
          const subjectEmails = (op.subjectNames ?? [])
            .map((n) => resolveMemberRef(members, n))
            .filter(Boolean)
            .map((m) => m!.email || m!.id)
          await createMemory({
            id: generateId(), text: op.text.trim(), category: op.category ?? 'fact',
            ...(subjectEmails.length ? { subjectEmails } : {}),
            ...(op.expiresAt ? { expiresAt: op.expiresAt } : {}),
            source: 'manual', createdAt: now,
          } as FamilyMemory)
        } else if (op.op === 'update_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (!m) continue
          await updateMemory({ ...m, text: op.text, confirmedAt: now })
        } else if (op.op === 'expire_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (!m) continue
          await updateMemory({ ...m, expiresAt: today })
        } else if (op.op === 'refresh_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (!m) continue
          await updateMemory({ ...m, confirmedAt: now })
        } else if (op.op === 'deactivate_goal') {
          const g = goals.find((x) => x.id === op.id)
          if (!g) continue
          await updateGoal({ ...g, active: false })
        } else if (op.op === 'add_goal' && op.text?.trim()) {
          await createGoal({
            id: generateId(), text: op.text.trim(), area: (op.area ?? 'personal') as LifeArea,
            ...(op.cadence ? { cadence: op.cadence } : {}), ...(op.why ? { why: op.why } : {}),
            active: true, createdAt: now,
          } as FamilyGoal)
        } else if (op.op === 'add_trigger' && op.condition?.trim() && op.action?.trim()) {
          await createTrigger({
            id: generateId(), condition: op.condition.trim(), action: op.action.trim(),
            ...(user?.email ? { createdBy: user.email } : {}),
            status: 'armed', createdAt: now,
          } as ProspectiveTrigger)
        } else if (op.op === 'update_profile' && op.patch && user?.email && myKey) {
          const patch: Partial<PersonalProfile> = {}
          for (const k of PROFILE_KEYS) {
            if (k in op.patch) (patch as Record<string, unknown>)[k] = (op.patch as Record<string, unknown>)[k]
          }
          const next = { ...(myProfile ?? { id: myKey, email: user.email }), ...patch, id: myKey, email: user.email, updatedAt: now }
          if (myProfile) await updatePP(next as PersonalProfile)
          else await createPP(next as PersonalProfile)
        } else {
          continue
        }
        applied.push(op)
      } catch { /* apply the rest — one failed op shouldn't lose the answer */ }
    }
    return applied
  }

  return { user, myKey, myProfile, members, memories, goals, buildDigest, applyOps }
}
