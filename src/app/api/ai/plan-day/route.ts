import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage } from '@/lib/ai'
import {
  DAY_PLAN_MODEL, DAY_PLAN_MAX_TOKENS, DAY_PLAN_SYSTEM_PROMPT,
} from '@/lib/dayPlanPrompt'
import { buildPersonalProfileBlock } from '@/lib/personalProfileContext'
import type {
  PersonalProfile, MomentEnergy, DayPlanItem, DayPlanItemKind, DayPlanStructure,
  FamilyGoal, Reflection,
} from '@/lib/types'

const MODEL = DAY_PLAN_MODEL

type PlanMode = 'draft' | 'refine' | 'replan' | 'suggest'

// Builds and revises today's plan. Shares the cached family-context block with
// the other engines, then appends a mode-specific instruction: draft a fresh
// plan, refine an existing draft from a chat message, or replan the rest of the
// day from where things actually stand.
type PlanDayInput = FamilyContextInput & {
  mode: PlanMode
  personalProfile?: PersonalProfile | null
  energy?: MomentEnergy
  intention?: string
  // The plan as it currently stands (for refine/replan).
  currentItems?: DayPlanItem[]
  // The user's chat instruction (refine) or replan note.
  message?: string
  // When set, the refine is a per-card RESCHEDULE focused on this item's title.
  focusTitle?: string
  // Standing commitments + recent reflections — not part of the shared context
  // block, so the planner renders them itself (see buildCommitments).
  goals?: FamilyGoal[]
  reflections?: Reflection[]
  // Which day to plan. Defaults to today; isToday=false means a future day
  // (plan the whole day, not "from now forward").
  targetDate?: string
  targetDateLabel?: string
  isToday?: boolean
  // How prescriptive: 'flexible' (default) or 'structured' (time-blocked + steps).
  structure?: DayPlanStructure
}

// The structure clause applied to every mode — tells the model which level of
// prescriptiveness to produce.
function structureClause(structure?: DayPlanStructure): string {
  if (structure === 'structured') {
    return ` STRUCTURE = STRUCTURED: produce a strict, time-blocked schedule — set a specific "startTime" on EVERY item (moves included), sequence them back-to-back in realistic order around the anchors using "minutes" so times add up, and break each non-trivial move into 2–5 concrete ordered "steps". Be directive and concrete, but still humane (buffers + rest, not an airless grid).`
  }
  return ` STRUCTURE = FLEXIBLE: anchors carry times; moves do NOT get clock times and each gets ONE tiny "firstStep" (no "steps" array).`
}

// Standing commitments + recent reflections → a block the planner should mine
// for moves. The shared family-context builder doesn't include these, so we
// render them here. Commitments ("family dinner 4x/week", "monthly date night")
// are exactly the "who we want to be" signals the user felt were being ignored.
function buildCommitmentsBlock(goals?: FamilyGoal[], reflections?: Reflection[]): string {
  const out: string[] = []
  const active = (goals ?? []).filter((g) => g.active)
  if (active.length) {
    const lines = active.map((g) => {
      const bits = [g.text]
      if (g.cadence) bits.push(`(${g.cadence})`)
      if (g.why) bits.push(`— why it matters: ${g.why}`)
      return `  - [${g.area}] ${bits.join(' ')}`
    })
    out.push(`STANDING COMMITMENTS (the family's ongoing intentions for how they want to live — NOT one-off tasks. Actively look for chances to honor these in today's plan: turn a relevant commitment into a concrete move for today when the day has room and it fits, e.g. a "family dinner 4x/week" commitment → a move to cook or plan dinner tonight; a "move my body daily" commitment → a walk or workout. Don't force every commitment in every day, but never ignore them):\n${lines.join('\n')}`)
  }
  const recent = (reflections ?? [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 2)
  if (recent.length) {
    const lines = recent.map((r) => {
      const parts: string[] = []
      if (r.wentWell) parts.push(`went well: ${r.wentWell}`)
      if (r.wasHard) parts.push(`was hard: ${r.wasHard}`)
      if (r.wouldChange) parts.push(`would change: ${r.wouldChange}`)
      if (r.gratitude) parts.push(`grateful: ${r.gratitude}`)
      return `  - ${parts.join('; ')}`
    })
    out.push(`RECENT REFLECTIONS (what the user has said about how things are really going — use these to shape what today should protect or repair):\n${lines.join('\n')}`)
  }
  return out.length ? `\n\n${out.join('\n\n')}` : ''
}

function fmtItem(it: DayPlanItem): string {
  const bits = [`[${it.kind}] ${it.title}`]
  if (it.startTime) {
    try { bits.push(`at ${new Date(it.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`) } catch { /* ignore */ }
  }
  if (it.minutes) bits.push(`~${it.minutes}m`)
  if (it.done) bits.push('✓ DONE')
  return `  - ${bits.join(' · ')}`
}

function buildModeInstruction(input: PlanDayInput): string {
  const isToday = input.isToday !== false  // default to today when unspecified
  const dayLabel = input.targetDateLabel || (isToday ? 'today' : `${input.targetDate}`)
  const struct = structureClause(input.structure)
  const aboutEnergy = input.energy
    ? `\n${isToday ? 'Energy right now' : `Expected energy on ${dayLabel}`}: ${input.energy}.`
    : ''
  const aboutIntention = input.intention?.trim()
    ? `\nWhat's on their mind for ${dayLabel} (honor this): "${input.intention.trim().slice(0, 600)}"`
    : ''

  if (input.mode === 'draft') {
    const scope = isToday
      ? `the REMAINDER OF TODAY ONLY — from the current time until the user winds down tonight. Pull anchors from today's calendar (only events on today's date that start at or after now) and choose moves for the time left today.`
      : `the FULL DAY of ${dayLabel} — this is a FUTURE day, so the entire day is ahead (morning through evening). Pull anchors ONLY from the calendar events dated ${dayLabel}, and plan moves across that whole day.`
    return `\n\nTASK — DRAFT THE PLAN FOR ${dayLabel.toUpperCase()}: Build a fresh, realistic plan for ${scope} The plan must stay strictly within ${dayLabel} — do NOT include anything from any other day. If there's genuinely little to do, a short honest plan is correct rather than padding it.${struct}${aboutEnergy}${aboutIntention}\nReturn the full plan as JSON. No "reply" field for an initial draft.`
  }

  const current = (input.currentItems ?? []).map(fmtItem).join('\n') || '  (empty)'

  if (input.mode === 'suggest') {
    return `\n\nTASK — SUGGEST OPTIONAL ADDITIONS (do NOT modify the plan, do NOT output items): Here is ${dayLabel}'s plan so far:\n${current}\nLooking hard at the user's GOALS, STANDING COMMITMENTS, recent reflections, and overall life balance, propose up to 4 OPTIONAL things they could consider fitting into the time still available ${isToday ? 'today' : `on ${dayLabel}`} that are NOT already in the plan. Strongly favor things that advance a stated goal or honor a standing commitment, or that restore an obviously neglected balance (movement, connection, rest, a put-off priority). Each is short and concrete with a one-line "why" that names the goal/commitment/benefit it serves. Be realistic about the time actually left — if the day is genuinely full or nothing meaningful fits, return fewer or an empty list. Never invent busywork or repeat anything already planned.\nOutput ONLY this JSON and nothing else: {"suggestions":[{"title":"...","why":"..."}]}`
  }

  if (input.mode === 'replan') {
    return `\n\nTASK — REPLAN THE REST OF TODAY: The day has shifted. Here is the current plan with completion state:\n${current}${aboutEnergy}\nKeep everything already marked DONE exactly as-is, and rebuild ONLY the remaining (not-done) part of TODAY around the CURRENT time — drop what no longer fits, resequence, lighten if energy is low. Stay within today only: do NOT pull in anything dated tomorrow or later. If little time remains, a short wind-down is the right answer. Return the COMPLETE updated plan (done items first, then the new go-forward items) as JSON, with a short "reply" acknowledging the reset.${struct}${input.message?.trim() ? `\nThey also said: "${input.message.trim().slice(0, 400)}"` : ''}`
  }

  const numbered = fmtNumberedItems(input.currentItems ?? [])
  const msg = (input.message ?? '').trim().slice(0, 500)

  // refine with a focused item — a per-card RESCHEDULE
  if (input.focusTitle?.trim()) {
    return `\n\nTASK — RESCHEDULE ONE ITEM (reorganize intelligently around it): Here is the current plan (numbered; ✓ = done):\n${numbered}\nThe user wants to change the timing/placement of THIS item: "${input.focusTitle.trim()}". Their feedback: "${msg}"\n- Find that item's number and emit a "retime" op to honor the request.\n- You MAY also "retime" items that would otherwise conflict with it — but touch as FEW as possible and leave every unrelated item alone.\n- ALWAYS account for TRAVEL/DRIVE TIME to/from locations (use event locations when shown): leave realistic time to get places; add a leave-by buffer before anything they must drive to.\n- NEVER retime an [anchor], and NEVER touch a ✓ done item.${struct}\n${OPS_SPEC}`
  }

  // refine — a SURGICAL edit, returned as a tiny patch (not a full re-emit)
  return `\n\nTASK — SURGICAL EDIT (make the SMALLEST change that satisfies the request): Here is the current plan (numbered; ✓ = done):\n${numbered}\nThe user wants this ONE change: "${msg}"\n- ADD something → ONE "add" op, giving it a startTime in a sensible open gap (factor in travel time).\n- REMOVE something → ONE "remove" op.\n- MOVE / re-time something → "retime" op(s).\n- REWORD or change a field → a "replace" op.\nLeave EVERY other item untouched. NEVER retime/remove an [anchor], and NEVER touch a ✓ done item.${struct}\n${OPS_SPEC}`
}

const KINDS: DayPlanItemKind[] = ['anchor', 'move']
const CATS = ['family', 'personal', 'rest', 'admin', 'connection']

function coerceOneItem(raw: unknown, idx = 0): DayPlanItem | null {
  const r = raw as Record<string, unknown>
  if (!r || typeof r !== 'object') return null
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return null
  const kind: DayPlanItemKind = KINDS.includes(r.kind as DayPlanItemKind) ? (r.kind as DayPlanItemKind) : 'move'
  const category = typeof r.category === 'string' && CATS.includes(r.category) ? (r.category as DayPlanItem['category']) : undefined
  const minutes = typeof r.minutes === 'number' && r.minutes > 0 && r.minutes < 600 ? Math.round(r.minutes) : undefined
  const srcTypes = ['event', 'task', 'reminder', 'inferred']
  const sourceType = typeof r.sourceType === 'string' && srcTypes.includes(r.sourceType) ? (r.sourceType as DayPlanItem['sourceType']) : undefined
  return {
    id: `dp-${idx}`,
    title,
    why: typeof r.why === 'string' && r.why.trim() ? r.why.trim() : undefined,
    kind,
    startTime: typeof r.startTime === 'string' ? r.startTime : undefined,
    minutes,
    category,
    firstStep: typeof r.firstStep === 'string' && r.firstStep.trim() ? r.firstStep.trim() : undefined,
    steps: Array.isArray(r.steps)
      ? r.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()).slice(0, 8)
      : undefined,
    sourceType,
    sourceId: typeof r.sourceId === 'string' && r.sourceId.trim() ? r.sourceId.trim() : undefined,
    done: false,
  }
}

function coerceItems(raw: unknown): DayPlanItem[] {
  if (!Array.isArray(raw)) return []
  const out: DayPlanItem[] = []
  for (let i = 0; i < raw.length && out.length < 12; i++) {
    const it = coerceOneItem(raw[i], i)
    if (it) out.push(it)
  }
  return out
}

// A surgical-edit patch: tiny ops the client applies to the plan it already
// has, so a small change doesn't cost a full-plan re-emit on output. `ref` is
// the 1-based number of an item in the numbered list sent to the model.
type PlanOp =
  | { action: 'add'; item: DayPlanItem }
  | { action: 'remove'; ref: number }
  | { action: 'retime'; ref: number; startTime: string }
  | { action: 'replace'; ref: number; item: DayPlanItem }

function coerceOps(raw: unknown): PlanOp[] {
  if (!Array.isArray(raw)) return []
  const ops: PlanOp[] = []
  for (const o of raw) {
    const r = o as Record<string, unknown>
    if (!r || typeof r !== 'object') continue
    const ref = typeof r.ref === 'number' ? Math.round(r.ref) : NaN
    if (r.action === 'add') {
      const it = coerceOneItem(r.item, ops.length)
      if (it) ops.push({ action: 'add', item: it })
    } else if (r.action === 'remove' && Number.isInteger(ref)) {
      ops.push({ action: 'remove', ref })
    } else if (r.action === 'retime' && Number.isInteger(ref) && typeof r.startTime === 'string') {
      ops.push({ action: 'retime', ref, startTime: r.startTime })
    } else if (r.action === 'replace' && Number.isInteger(ref)) {
      const it = coerceOneItem(r.item, ops.length)
      if (it) ops.push({ action: 'replace', ref, item: it })
    }
  }
  return ops
}

// Number the current plan items so the model can reference them by number in
// its ops (cheap) instead of re-emitting them.
function fmtNumberedItems(items: DayPlanItem[]): string {
  if (!items.length) return '  (empty)'
  return items.map((it, i) => {
    const bits = [`${i + 1}. [${it.kind}] ${it.title}`]
    if (it.startTime) {
      try { bits.push(`at ${new Date(it.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`) } catch { /* ignore */ }
    }
    if (it.minutes) bits.push(`~${it.minutes}m`)
    if (it.done) bits.push('✓ DONE')
    return '  ' + bits.join(' · ')
  }).join('\n')
}

// The ops output spec, shared by the surgical-edit and reschedule prompts.
const OPS_SPEC = `Output ONLY a small patch as JSON — do NOT re-emit the whole plan: {"ops":[...],"reply":"<one short sentence>"}. Each op is one of:
  {"action":"add","item":{"title":"...","why":"...","kind":"move","startTime":"<local ISO, no Z>","minutes":N,"category":"family|personal|rest|admin|connection","firstStep":"...","steps":["..."]}}  — a NEW item; give it a startTime in a sensible OPEN gap
  {"action":"retime","ref":N,"startTime":"<local ISO, no Z>"}  — change the time of item N
  {"action":"remove","ref":N}  — drop item N
  {"action":"replace","ref":N,"item":{...full item...}}  — replace item N
N is the NUMBER of an item in the list above. Use the FEWEST ops possible. NEVER emit an op targeting a ✓ done item, and NEVER retime/remove an [anchor] (calendar event).`

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const reqStart = Date.now()
  let ctx: PlanDayInput
  try {
    ctx = (await request.json()) as PlanDayInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)
  const aboutMe = buildPersonalProfileBlock(ctx.personalProfile)
  const commitments = buildCommitmentsBlock(ctx.goals, ctx.reflections)
  const modeInstruction = buildModeInstruction(ctx)

  // Caching layout (most stable → most volatile, so the cached PREFIX stays
  // identical across the many calls in one planning session):
  //   1. system prompt (static)            — cached
  //   2. FAMILY CONTEXT data block         — cached
  //   3. about-me + standing commitments   — cached (stable within a session)
  //   4. time header + mode instruction    — uncached (changes every call/mode)
  // So a draft writes the cache and every subsequent refine/reschedule/replan/
  // suggest reads the whole prefix at ~10% cost.
  const stableContext = aboutMe + commitments
  const volatileTail = timeHeader + modeInstruction
  const userContent: Anthropic.TextBlockParam[] = [
    { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]
  if (stableContext.trim()) {
    userContent.push({ type: 'text', text: stableContext, cache_control: { type: 'ephemeral', ttl: '1h' } })
  }
  userContent.push({ type: 'text', text: volatileTail })

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const msg = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: DAY_PLAN_MAX_TOKENS,
        system: [
          { type: 'text', text: DAY_PLAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{ role: 'user', content: userContent }],
      },
      { signal: request.signal },
    )

    logUsage('plan-day', MODEL, msg.usage)

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    let parsed: Record<string, unknown> = {}
    try { if (match) parsed = JSON.parse(match[0]) } catch { /* handled below */ }

    // Suggest mode returns optional ideas, not a plan.
    if (ctx.mode === 'suggest') {
      const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
      const suggestions = raw
        .map((s) => {
          const r = s as Record<string, unknown>
          const title = typeof r.title === 'string' ? r.title.trim() : ''
          return title ? { title, why: typeof r.why === 'string' ? r.why.trim() : undefined } : null
        })
        .filter(Boolean)
        .slice(0, 4)
      console.log(`[plan-day] wall=${Date.now() - reqStart}ms mode=suggest n=${suggestions.length}`)
      return NextResponse.json({ suggestions, generatedAt: new Date().toISOString() })
    }

    // Refine mode (surgical edit, quick-add, per-card reschedule, chat tweaks)
    // returns a tiny ops PATCH — not the whole plan — so a small change is cheap
    // on output. Falls back to a full-plan return if the model emitted items.
    if (ctx.mode === 'refine') {
      const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : undefined
      const ops = coerceOps(parsed.ops)
      if (ops.length) {
        console.log(`[plan-day] wall=${Date.now() - reqStart}ms mode=refine ops=${ops.length} out=${msg.usage?.output_tokens ?? '?'}`)
        return NextResponse.json({ ops, reply, generatedAt: new Date().toISOString() })
      }
      const fallback = coerceItems(parsed.items)
      if (fallback.length) {
        console.log(`[plan-day] wall=${Date.now() - reqStart}ms mode=refine fallback_items=${fallback.length}`)
        return NextResponse.json({ items: fallback, reply, generatedAt: new Date().toISOString() })
      }
      return NextResponse.json({ error: 'Could not apply that change — try again.' }, { status: 502 })
    }

    const items = coerceItems(parsed.items)
    if (items.length === 0) {
      return NextResponse.json({ error: 'Could not build a plan — try again.' }, { status: 502 })
    }

    // Log which profile signals actually arrived, so "settings aren't used" is
    // verifiable from the server logs rather than guessed at.
    const pp = ctx.personalProfile
    const ppKeys = pp
      ? Object.entries({
          goals: pp.goals?.length, struggle: !!pp.biggestStruggle, adhd: pp.hasAdhd,
          rhythm: !!pp.rhythm, anchors: pp.fixedAnchors?.length, roles: !!pp.householdRoles,
          care: !!pp.careSchedule, style: pp.planStyle, structure: pp.planStructure,
          protectRest: pp.protectRest, nonNegotiables: pp.nonNegotiables?.length,
        }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(',')
      : 'NONE'
    console.log(`[plan-day] wall=${Date.now() - reqStart}ms mode=${ctx.mode} struct=${ctx.structure ?? '-'} items=${items.length} stop=${msg.stop_reason} profile=[${ppKeys}] goals=${ctx.goals?.length ?? 0} aboutMe_chars=${aboutMe.length}`)

    return NextResponse.json({
      headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : '',
      reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : undefined,
      items,
      generatedAt: new Date().toISOString(),
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'aborted' }, { status: 499 })
    }
    const errMsg = e instanceof Error ? e.message : 'Day Planner failed'
    console.error('[plan-day] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
