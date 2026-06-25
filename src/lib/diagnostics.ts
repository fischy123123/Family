import { getAdminDb } from './firebaseAdmin'

export interface AttentionDiagRun {
  ts: number          // epoch ms
  scope: string       // e.g. "items[Eric,Liam,Family]" | "problems" | "recommendations"
  email: string       // currentUserEmail from context (identifies the family)
  // context sizes sent to the model
  events: number
  tasks: number
  members: number
  inbox: number
  prompt_chars: number
  // timing (ms)
  ctx_ms: number
  ttft_ms: number
  ai_ms: number
  wall_ms: number
  // token usage
  in_tokens: number
  out_tokens: number
  cache_read: number
  cache_write: number
  cache_status: 'HIT' | 'WRITE' | 'MISS'
  tok_per_sec: number
  // output counts
  items: number
  problems: number
  recs: number
  parse_ok: boolean
  stop_reason: string
  error?: string
}

const DOC = '_diagnostics/attention'
const MAX_RUNS = 50

// Fire-and-forget — never awaited so it doesn't add latency to streaming responses.
export function writeDiagnostic(run: AttentionDiagRun): void {
  Promise.resolve().then(async () => {
    try {
      const db = getAdminDb()
      const ref = db.doc(DOC)
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const existing: AttentionDiagRun[] = snap.exists ? (snap.data()?.runs ?? []) : []
        const updated = [...existing, run].slice(-MAX_RUNS)
        tx.set(ref, { runs: updated })
      })
    } catch {
      // Non-fatal — diagnostics must never break the real response
    }
  })
}
