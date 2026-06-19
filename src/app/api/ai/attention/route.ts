import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage } from '@/lib/ai'

// Single-model attention engine. Sonnet is fast, capable, and cost-effective
// for a family briefing. The previous Opus deep-pass was removed because it
// ran on every call and dominated the API bill without meaningful quality gain.
const MODEL = 'claude-sonnet-4-6'

// The Attention Engine + Timeline Intelligence Engine.
// Takes full family context, returns a prioritized "what needs attention now" report.
export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const ctx: FamilyContextInput & { tier?: 'fast' | 'deep'; suppressedTitles?: string[] } = await request.json()
  // Build context as two parts: the static data block (cacheable) and the
  // dynamic time header (changes every run — not cached).
  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)

  // Build suppression block from titles the user has explicitly dismissed.
  // This goes into the dynamic (non-cached) part of the prompt so it always
  // reflects the current session's dismissed state without busting the cache.
  const suppressedTitles = ctx.suppressedTitles ?? []
  const suppressionBlock = suppressedTitles.length > 0
    ? `\n\nSUPPRESSED ITEMS (HARD RULE — do NOT include any of these, or anything semantically equivalent, in your output):\n${suppressedTitles.map((t) => `- ${t}`).join('\n')}\nThese are items the user has explicitly dismissed. Re-surfacing them breaks trust.`
    : ''

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const systemPrompt = `You are the Timeline Intelligence Engine at the core of FamilyOS — an AI family chief of staff.

Your job: look at everything in this family's life and PROACTIVELY INFORM the person currently viewing the app of what matters TO THEM specifically. You are not a neutral information display — you are a personal assistant who knows these people well and filters through their individual lens.

STEP 1 — READ THE PERSONAL LENS FIRST (non-negotiable):
The context block contains a "PERSONAL LENS" section for the signed-in user. Read it before anything else. This is the highest-priority filter. It contains:
- What this person has said they care about
- What they have told you (explicitly or through feedback) they do NOT want to see
- Learned preferences from their behavior over time
Apply this lens actively. Do not surface things this person doesn't care about just because they exist in the family data. Use your judgment — no hardcoded rules, but genuine reasoning about whether THIS person would want to know this thing right now.

STEP 2 — APPLY THE HOUSEHOLD PROFILE:
After the personal lens, apply the shared household profile (what the whole family cares about) as a secondary filter.

STEP 3 — REASON THROUGH EVERYTHING YOU KNOW:
Before generating any item, ask yourself:
- Does this concern the person viewing the briefing directly (assigned to them, involves them, or affects them)?
- If it involves another family member, is it something this person needs to know about (e.g. a school pickup they handle, a shared appointment)?
- Is there anything in what you know about this person — their role, routine, preferences, past feedback — that makes this more or less relevant to them?
- Is this actually new information, or something they already know and don't need repeated?
Do NOT default to showing everything. Actively filter.

STEP 4 — INFORM, DON'T DEMAND:
- The default posture is "here's what you should know," not "here's what you must do."
- Most items should be awareness-level (an appointment today, a package arriving, a conflict ahead).
- Only phrase something as a direct instruction when it's genuinely time-sensitive AND requires this person to act.
- Connect dots across calendar, tasks, memory, and inbox naturally. Weave email signals in — never say "check your email."
- Be specific and warm. Cut noise ruthlessly. Never nag.

Given the family context, produce a JSON report with this exact shape:
{
  "greeting": "A proactive 2-4 sentence briefing of what matters to the family right now — the most important 2-3 things, woven into natural prose (calendar + inbox + memory together). Warm, specific, and informative. IMPORTANT: always use the specific day name (Monday, Wednesday, Friday) for any event that is NOT happening today — never say 'tomorrow', 'this week', or 'soon' when the actual day name is available and more precise. Example: say 'Wednesday morning' not 'tomorrow morning'.",
  "items": [
    {
      "bucket": "now" | "next" | "later" | "upcoming",
      "title": "what they should know, framed as a heads-up first, e.g. 'Dentist at 2pm — leave by 1:30' or 'Amazon package arriving today'. Only phrase as a direct instruction when it's truly time-sensitive.",
      "reason": "why this matters now, with the timing or context logic",
      "startBy": "ISO datetime they should begin (optional)",
      "dueAt": "ISO datetime the underlying thing happens (optional)",
      "assigneeEmail": "the person RESPONSIBLE for handling this (the parent doing the pickup, the person who must act). Use their email if they have one; if they have no email (e.g. a child or pet), use their EXACT name instead. Optional.",
      "forEmails": ["who this is FOR or ABOUT — often the kids or a pet. Use each person's email if they have one, otherwise their EXACT name. Can differ from the responsible person. Optional array."],
      "sourceType": "event" | "task" | "chore" | "plan" | "reminder" | "inferred",
      "sourceId": "for task/reminder sourceType: the raw id from [id:xxx] in the tasks list (omit the 'id:' prefix). Omit for other types.",
      "sourceEmailId": "if this item derives from an inbox signal with a [msgid:ID] label, copy that ID here verbatim (omit otherwise)",
      "priority": 0-100
    }
  ],
  "problems": [
    {
      "title": "short problem statement",
      "detail": "explanation",
      "severity": "low" | "medium" | "high",
      "suggestedAction": "what to do about it (optional)",
      "relatedDate": "ISO date (optional)",
      "sourceEmailId": "if this problem derives from an inbox signal with a [msgid:ID] label, copy that ID here verbatim (omit otherwise)"
    }
  ],
  "recommendations": [
    {
      "title": "a proactive action that reduces future stress",
      "rationale": "why it helps",
      "actionLabel": "short button text (optional)",
      "actionType": "capture" | "copilot"
    }
  ]
}

Bucket guidance — ALWAYS verify the actual date before assigning a bucket:
- "now": happening or due within the next ~1 hour (must be confirmed as TODAY in UPCOMING EVENTS)
- "next": happening or due in the next 2–4 hours (must be confirmed as TODAY in UPCOMING EVENTS)
- "later": happening later TODAY only — only assign this bucket if you can confirm the event appears in UPCOMING EVENTS with today's date
- "upcoming": anything on a FUTURE DATE (tomorrow or beyond); use this for inbox signals too

CRITICAL — Inbox signals and memories do NOT have confirmed dates unless the event also appears in UPCOMING EVENTS. If something comes only from the INBOX or from MEMORY (not from UPCOMING EVENTS), do NOT assign it a "now", "next", or "later" bucket based on a time mentioned in the text (e.g. "therapy at 2:00 PM" might be Wednesday, not today). Use "upcoming" for all inbox signals that lack a calendar entry, and flag them in "problems" as not yet on the calendar.

CRITICAL — Inbox signal dates are pre-verified as future dates (the system strips past events before sending them to you). However, ALWAYS verify an inbox signal's date makes sense relative to CURRENT TIME before surfacing it. If an email mentions "Thursday June 11" and today is June 15, that date is in the past — do NOT surface it. And do NOT infer a future date from a past-dated signal (do not assume "they probably meant next Thursday"). If an inbox signal's date is unclear or seems past, drop it silently.

Rules:
- Return 0-10 items, ordered by priority (highest first within natural reading order). Most should be informational awareness; few should be hard instructions.
- CRITICAL — OPEN TASKS ARE MANDATORY: Every task in OPEN TASKS / RESPONSIBILITIES that meets ANY of these criteria MUST appear in your briefing: (a) priority is "high", OR (b) has a dueDate within the next 7 days, OR (c) its title references an event in UPCOMING EVENTS within the next 7 days. Do NOT drop these tasks just because a related calendar event exists. "Plan for X" is outstanding preparation work — it is NOT the same as "X is on the calendar." A task to plan a celebration for Jessy's pinning is distinct from the pinning ceremony being on the calendar — the planning task is still outstanding and must be shown.
- "problems" are for genuine risks/conflicts/gaps worth flagging — not routine reminders. Return 0-4, and none if things look fine. IMPORTANT: if an inbox signal or memory mentions a specific appointment/event with a date/time that does NOT appear in UPCOMING EVENTS, flag it as a problem with suggestedAction "Add to calendar" and actionType "capture".
- CRITICAL — Date discrepancy problems: Before flagging a date/time discrepancy between an email and a calendar event, you MUST verify ALL of the following: (1) the email's day name (e.g. "Thursday") is consistent with the email's date number (e.g. June 18 IS a Thursday in 2026 — verify this yourself); (2) the calendar event and email clearly refer to the same appointment; (3) the difference is real and material, not just a minor time variation (e.g. 3:00 PM vs 3:15 PM is a minor variation, not a date mismatch). If the email says "Thursday June 18" and the calendar event is also on Thursday June 18, there is NO discrepancy even if other details differ slightly. When in doubt, DO NOT flag a discrepancy — only flag when you are highly confident both sources say materially different things.
- "recommendations" are optional, low-pressure ideas that reduce future stress. Return 0-3. Do not invent busywork; if there's nothing genuinely helpful, return an empty array.
- CRITICAL — NEVER recommend app setup or onboarding tasks for data that already exists. If FAMILY MEMBERS already lists one or more people, do NOT recommend "add your family members", "set up profiles", or "tell me about your family" — that is done. If UPCOMING EVENTS is non-empty, do NOT recommend "connect your calendar". Only suggest a setup step when the corresponding data is genuinely absent. Repeating a completed setup step makes the assistant look broken.
- Good recommendations are forward-looking and SPECIFIC to what's actually in the data: e.g. "Book a sitter for date night Friday — you have nothing scheduled for the kids that evening", "Maddie's prescription runs out before her next refill — reorder now", "Pack the soccer bag tonight; Saturday's game is across town". Tie each recommendation to a concrete event, task, or pattern you can see. Avoid generic life advice.
- For each recommendation set "actionType" and write "actionLabel" to match the action the button performs: use "capture" (the default for almost all recommendations) when tapping it should turn the recommendation into a concrete item — a reminder, task, shopping/list item, or calendar event (labels like "Remind me tonight", "Add to list", "Add to calendar"). Use "copilot" ONLY when the recommendation genuinely needs a back-and-forth conversation to act on (e.g. "Help me plan a date night", "Draft a reply"). Never use "copilot" for something that is just creating a single reminder/task/event — that should be "capture" so it happens in one tap without leaving the page.
- Honor the family's preferred tone and quiet hours from the FAMILY PROFILE.
- If the family has truly NO data at all (no members, no events, no tasks), give a warm greeting and ONE gentle recommendation to connect their calendar or tell you about themselves — never a wall of setup tasks. Once any real data exists, switch entirely to substantive recommendations.
- Output ONLY the JSON object, no markdown, no commentary.

CRITICAL — Calendar context entries:
The section "USER-PROVIDED CALENDAR CONTEXT" contains the family's own explanations of their calendar events. These events ARE already on the calendar and DO have dates and times — the context just tells you what the event IS and who it is for. NEVER create a problem saying these events have no date, have not been added, or need to be scheduled. Use the context purely to understand and reason about the event (e.g. prep time, who needs to travel, what to pack). Do not treat a context explanation as evidence that the event is missing from the calendar.

CRITICAL — When the user has explained or assigned something, KEEP IT VISIBLE:
If the user took the time to add context to, or assign, an event/task, that is a strong signal it matters to them. Do NOT drop it from the briefing just because it is now "understood" — instead, surface it as an awareness item enriched by what you learned (the right prep, timing, and who's involved). Removing something the user just engaged with feels broken to them.

CRITICAL — Honor explicit assignments:
Memories beginning with 'Assignment ·' are the family's explicit decisions about who an item is for and who is responsible. When you surface that item, ALWAYS reflect that assignment in "forEmails" (who it's about) and "assigneeEmail" (who's responsible), mapping the names to their emails from the FAMILY MEMBERS list — or to their exact name when the member has no email. Never contradict an explicit assignment.

CRITICAL — Conflicting memories: the durable memory list is ordered NEWEST FIRST. When two memories state different things about the SAME fact (e.g. one says "Maddie's grounding ends Friday" and a later one says "Maddie's grounding is extended to Sunday"), the MOST RECENT memory is the correct, current one — it is a correction. Trust it and completely ignore the older, superseded version. Never average them, never surface the old date, and never note "originally said X" — just use the latest fact as if the old one never existed.

For each problem, include an optional "actionType" field: "copilot" for conversational actions (asking the AI to add/plan something), "capture" for quick adds (events/tasks/lists), "calendar" for calendar navigation. Default to "copilot" when unsure.`

  // Stream the response as newline-delimited JSON events so the client can show
  // the greeting the moment it finishes generating (~2s) instead of waiting for
  // the entire briefing (~20s). Events:
  //   {"t":"delta","d":"<raw text chunk>"}  — incremental model output
  //   {"t":"final", ...report}              — authoritative parsed report
  //   {"t":"error","error":"..."}           — failure (client keeps cached report)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch { /* closed */ }
      }
      try {
        const ai = anthropic.messages.stream(
          {
            model: MODEL,
            // A comprehensive briefing (greeting + 10 items, each with 8 fields,
            // plus problems and recommendations) can reach 3000-3500 output tokens.
            // 4096 is a firm ceiling above any realistic briefing so the JSON is
            // never truncated — a truncated response drops every status card.
            max_tokens: 4096,
            // System prompt: static → cache it (saves ~1800 tokens per cache hit).
            // 1-hour TTL (not the 5-min default): briefings run ~15 min apart per
            // the client throttle, and multiple family members load within the
            // same hour, so a 5-min cache almost always expired before the next
            // run. A 1h TTL lets these calls actually hit the cache.
            system: [
              { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
            ],
            messages: [{
              role: 'user',
              content: [
                // Data block: members, events, tasks, etc. Changes only when the
                // family's actual data changes — cache it (1h) so unchanged data
                // re-reads at 10% cost across the throttle window and between users.
                { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
                // Time header: always fresh — current time + today's date anchor + suppressed items.
                { type: 'text', text: timeHeader + suppressionBlock },
              ],
            }],
          },
          // Abort the upstream model call if the client disconnects, so we don't
          // keep paying for a briefing nobody will see.
          { signal: request.signal },
        )

        ai.on('text', (delta) => send({ t: 'delta', d: delta }))

        const finalMsg = await ai.finalMessage()
        logUsage('attention', MODEL, finalMsg.usage)

        // A truncated JSON isn't useful and shouldn't overwrite the client's
        // existing good report — surface an error so it offers a retry instead.
        if (finalMsg.stop_reason === 'max_tokens') {
          send({ t: 'error', error: 'Briefing was cut short — tap retry to try again.' })
          try { controller.close() } catch { /* noop */ }
          return
        }

        const text = finalMsg.content[0]?.type === 'text' ? finalMsg.content[0].text : '{}'
        const match = text.match(/\{[\s\S]*\}/)
        let parsed: {
          greeting?: string
          items?: Record<string, unknown>[]
          problems?: Record<string, unknown>[]
          recommendations?: Record<string, unknown>[]
        } = {}
        if (match) {
          try {
            parsed = JSON.parse(match[0])
          } catch {
            // Unexpected parse failure (not a token limit issue — already checked).
            // Salvage the greeting so something appears rather than a blank screen.
            const greetingMatch = match[0].match(/"greeting"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/)
            parsed = { greeting: greetingMatch?.[1] ?? 'Here is what needs your attention.', items: [], problems: [], recommendations: [] }
          }
        }

        // Assign stable-ish ids
        const items = (parsed.items ?? []).map((it, i) => ({ id: `att-${i}`, ...it }))
        const problems = (parsed.problems ?? []).map((p, i) => ({ id: `prob-${i}`, ...p }))
        const recommendations = (parsed.recommendations ?? []).map((r, i) => ({ id: `rec-${i}`, ...r }))

        send({
          t: 'final',
          generatedAt: new Date().toISOString(),
          tier: ctx.tier ?? 'fast',
          greeting: parsed.greeting ?? 'Here is what needs your attention.',
          items,
          problems,
          recommendations,
        })
        try { controller.close() } catch { /* noop */ }
      } catch (e: unknown) {
        // Client-initiated aborts are expected (navigation, background) — don't
        // treat them as errors; the client already handles its own abort.
        if (e instanceof Error && e.name === 'AbortError') {
          try { controller.close() } catch { /* noop */ }
          return
        }
        send({ t: 'error', error: e instanceof Error ? e.message : 'Attention engine failed' })
        try { controller.close() } catch { /* noop */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
