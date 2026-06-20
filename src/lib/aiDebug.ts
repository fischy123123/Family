// AI debugging mode — a user-toggled diagnostic flag.
//
// When enabled, the Copilot agent is instructed to cite the source of every
// fact it states: which tool it called, which memory [id:xxx] it read, which
// member-profile field, or which calendar event. This helps the user trace
// where the AI got a piece of information when something looks wrong (e.g. a
// stale grounding date, a fact that isn't visible anywhere in the UI).
//
// The flag lives in localStorage so it persists across sessions and is read
// client-side at send time, so toggling it takes effect on the next message.

export const AI_DEBUG_KEY = 'fam-ai-debug'

export function isAiDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(AI_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export function setAiDebugEnabled(on: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (on) localStorage.setItem(AI_DEBUG_KEY, '1')
    else localStorage.removeItem(AI_DEBUG_KEY)
  } catch {
    /* ignore */
  }
}
