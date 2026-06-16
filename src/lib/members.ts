// ─────────────────────────────────────────────────────────────
// Member assignment — single source of truth
// ─────────────────────────────────────────────────────────────
// Assignment across the app is keyed on the member's stable `id`, NOT their
// email. Email is unreliable as an identity key because children and pets
// often have no email address — keying on it silently made everyone without
// an email un-assignable. `id` is always present and unique.
//
// For backward-compat with data written before this change (and with the AI
// pipelines, which still reason in names/emails), resolution falls back to
// email when no id is present.

import type { FamilyMember } from './types'

// The shape any assignable record exposes. Both fields are optional; we try
// id first, then email.
export interface Assignable {
  assigneeId?: string
  assigneeEmail?: string
}

/** Resolve the member an item is assigned to, id-first then email-fallback. */
export function resolveAssignee(
  members: FamilyMember[],
  item: Assignable | undefined | null,
): FamilyMember | undefined {
  if (!item) return undefined
  if (item.assigneeId) {
    const byId = members.find((m) => m.id === item.assigneeId)
    if (byId) return byId
  }
  if (item.assigneeEmail) {
    const email = item.assigneeEmail.toLowerCase()
    const byEmail = members.find((m) => m.email && m.email.toLowerCase() === email)
    if (byEmail) return byEmail
  }
  return undefined
}

/** Find a member by id (convenience). */
export function memberById(members: FamilyMember[], id?: string): FamilyMember | undefined {
  if (!id) return undefined
  return members.find((m) => m.id === id)
}

/**
 * Resolve a member from a loose identifier the AI might emit — an id, an email,
 * or a name. Lets us map AI assignments onto emailless members by name.
 */
export function resolveMemberRef(
  members: FamilyMember[],
  ref?: string,
): FamilyMember | undefined {
  if (!ref) return undefined
  const r = ref.trim().toLowerCase()
  return (
    members.find((m) => m.id.toLowerCase() === r) ||
    members.find((m) => m.email && m.email.toLowerCase() === r) ||
    members.find((m) => m.name.toLowerCase() === r) ||
    // first-name match as a last resort ("Jessy" vs "Jessy Smith")
    members.find((m) => m.name.toLowerCase().split(' ')[0] === r)
  )
}

/** Display name for a resolved member, with a graceful fallback. */
export function memberLabel(member: FamilyMember | undefined, fallback = 'Anyone'): string {
  return member?.name ?? fallback
}

/** Everyone can be assigned — no email filter. Sorted parents → kids → others. */
export function assignableMembers(members: FamilyMember[]): FamilyMember[] {
  const rank = (r: FamilyMember['role']) =>
    r === 'parent' ? 0 : r === 'child' ? 1 : r === 'pet' ? 3 : 2
  return [...members].sort((a, b) => rank(a.role) - rank(b.role))
}
