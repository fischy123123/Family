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

  // refine with a focused item — a per-card RESCHEDULE
  if (input.focusTitle?.trim()) {
    return `\n\nTASK — RESCHEDULE ONE ITEM (reorganize intelligently around it): Here is the current plan (✓ = already done):\n${current}\nThe user wants to change the timing/placement of THIS item: "${input.focusTitle.trim()}". Their feedback: "${(input.message ?? '').trim().slice(0, 500)}"\nRules:\n- Re-time/move that one item to honor the request.\n- You MAY shift items that would otherwise conflict with it, or that depend on it, to keep the day sensible — but keep every UNRELATED item exactly as it is (same title, time, order, steps).\n- ALWAYS account for required TRAVEL/DRIVE TIME to and from locations (use event locations when shown) — leave realistic time to get places; never schedule back-to-back items in different locations without travel time, and add a leave-by buffer before anything the user must drive to.\n- NEVER move or re-time an anchor (calendar event) — anchors keep their real times.\n- NEVER modify or remove an item marked ✓ done.\nReturn the COMPLETE plan as JSON, plus a short "reply" (1 sentence) naming what you moved and how you adjusted around it.${struct}`
  }

  // refine — a SURGICAL edit, not a re-plan
  return `\n\nTASK — SURGICAL EDIT (make the SMALLEST change that satisfies the request — do NOT rebuild the plan): Here is the current plan (✓ = already done):\n${current}\nThe user wants this ONE change: "${(input.message ?? '').trim().slice(0, 500)}"\nRules:\n- Make ONLY that change. Keep EVERY other item exactly as it is — same title, same startTime, same order, same steps. Do NOT re-time, re-sequence, reword, merge, or drop anything the change doesn't require.\n- NEVER move or re-time an anchor (calendar event) — anchors always keep their real times.\n- NEVER modify or remove an item marked ✓ done.\n- If the change ADDS something, slot it into a sensible existing gap with an appropriate time, without shifting the other items' times.\nReturn the COMPLETE plan (all the untouched items, exactly as given, PLUS the one change) as JSON, plus a short "reply" (1 sentence) naming only what you changed.${struct}`
}

const KINDS: DayPlanItemKind[] = ['anchor', 'move']
const CATS = ['family', 'personal', 'rest', 'admin', 'connection']

function coerceItems(raw: unknown): DayPlanItem[] {
  if (!Array.isArray(raw)) return []
  const out: DayPlanItem[] = []
  for (let i = 0; i < raw.length && out.length < 12; i++) {
    const r = raw[i] as Record<string, unknown>
    if (!r || typeof r !== 'object') continue
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title) continue
    const kind: DayPlanItemKind = KINDS.includes(r.kind as DayPlanItemKind) ? (r.kind as DayPlanItemKind) : 'move'
    const category = typeof r.category === 'string' && CATS.includes(r.category) ? (r.category as DayPlanItem['category']) : undefined
    const minutes = typeof r.minutes === 'number' && r.minutes > 0 && r.minutes < 600 ? Math.round(r.minutes) : undefined
    const srcTypes = ['event', 'task', 'reminder', 'inferred']
    const sourceType = typeof r.sourceType === 'string' && srcTypes.includes(r.sourceType) ? (r.sourceType as DayPlanItem['sourceType']) : undefined
    out.push({
      id: `dp-${i}`,
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
    })
  }
  return out
}

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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const msg = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: DAY_PLAN_MAX_TOKENS,
        system: [
          { type: 'text', text: DAY_PLAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: timeHeader + aboutMe + commitments + modeInstruction },
          ],
        }],
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
