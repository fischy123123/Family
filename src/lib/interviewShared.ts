// Shared pieces of the interview system — used by both the one-question-a-day
// engine (/api/ai/interview) and the deep-dive session engine
// (/api/ai/interview-session). Kept out of the route files so Next's route
// export checks stay happy and the two prompts can't drift apart.

export type KnowledgeDigest = {
  members?: { name: string; role?: string }[]
  profile?: Record<string, unknown> | null
  personalProfile?: Record<string, unknown> | null
  memories?: { id: string; text: string; category?: string; notedOn: string; aging?: boolean; pinned?: boolean }[]
  goals?: { id: string; text: string; area?: string; cadence?: string }[]
  recentQuestions?: string[]
  now?: string
  timezone?: string
}

export function buildDigest(ctx: KnowledgeDigest): string {
  const parts: string[] = []
  if (ctx.members?.length) {
    parts.push(`FAMILY: ${ctx.members.map((m) => `${m.name}${m.role ? ` (${m.role})` : ''}`).join(', ')}`)
  }
  if (ctx.personalProfile && Object.keys(ctx.personalProfile).length) {
    parts.push(`SIGNED-IN USER'S PROFILE (their "about me"):\n${JSON.stringify(ctx.personalProfile, null, 1).slice(0, 2400)}`)
  }
  if (ctx.profile) {
    parts.push(`HOUSEHOLD PROFILE:\n${JSON.stringify(ctx.profile, null, 1).slice(0, 1200)}`)
  }
  if (ctx.goals?.length) {
    parts.push(`ACTIVE GOALS/COMMITMENTS:\n${ctx.goals.map((g) => `  - id:${g.id} [${g.area ?? '?'}] ${g.text}${g.cadence ? ` (${g.cadence})` : ''}`).join('\n')}`)
  }
  if (ctx.memories?.length) {
    parts.push(`KNOWN FACTS/MEMORIES (with when they were last noted or confirmed; "AGING" = old enough it may no longer be true):\n${ctx.memories
      .slice(0, 80)
      .map((m) => `  - id:${m.id}${m.category ? ` [${m.category}]` : ''} ${m.text} (${m.notedOn}${m.aging ? ', AGING' : ''}${m.pinned ? ', pinned' : ''})`)
      .join('\n')}`)
  }
  if (ctx.recentQuestions?.length) {
    parts.push(`RECENTLY ASKED (do NOT repeat these or near-duplicates):\n${ctx.recentQuestions.map((q) => `  - ${q}`).join('\n')}`)
  }
  parts.push(`Current time: ${ctx.now ?? new Date().toISOString()}${ctx.timezone ? ` (${ctx.timezone})` : ''}`)
  return parts.join('\n\n')
}

// The knowledge-operation vocabulary — everything the AI is allowed to write
// back into the app's structured knowledge. Shared verbatim by the single-shot
// ingest prompt and the deep-dive session prompt.
export const OPS_SPEC = `Available knowledge ops (emit only what the user's words justify):
- {"op":"add_memory","text":"...","category":"fact|preference|routine|health|logistics|relationship|other","subjectNames":["Name"] (optional),"expiresAt":"YYYY-MM-DD" (only for clearly time-bound facts)}
  · "text" must be a durable, third-person-useful statement ("Eric's top work priority is the Q3 board deck, due mid-August"), not a transcript.
- {"op":"update_memory","id":"<existing id>","text":"<corrected text>"} — when the answer changes an existing fact.
- {"op":"expire_memory","id":"<existing id>"} — when the answer says a fact is no longer true.
- {"op":"refresh_memory","id":"<existing id>"} — when the answer confirms an existing fact unchanged.
- {"op":"deactivate_goal","id":"<goal id>"} — a commitment they say no longer matters.
- {"op":"add_goal","text":"...","area":"health|relationships|kids|finances|home|personal|work-life|fun","cadence":"..." (optional),"why":"..." (optional)} — ONLY when they clearly state an ongoing intention.
- {"op":"update_profile","patch":{...}} — for facts that belong on their personal profile. Allowed keys ONLY: goals (string[]), biggestStruggle, energizers (string[]), drainers (string[]), startStrategies (string[]), avoiding (string[]), rhythm, fixedAnchors (string[]), householdRoles, careSchedule, planStyle ("minimal"|"balanced"|"packed"), protectRest (boolean), nonNegotiables (string[]), freeform. For array keys, return the FULL merged array (existing values plus/minus changes) — the patch replaces the field.
Never duplicate an existing fact; prefer updating/expiring over adding parallel versions.`
