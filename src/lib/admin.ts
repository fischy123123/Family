// Admin allowlist used to gate destructive, cross-family operations.
//
// Server enforcement reads ADMIN_EMAILS (comma-separated) and merges it with
// the defaults below, so the panel works out of the box for the owner without
// requiring an env var. Client-side visibility uses the same defaults (plus an
// optional NEXT_PUBLIC_ADMIN_EMAILS) — but the API is the real gate.

export const DEFAULT_ADMIN_EMAILS = ['ericfsch@gmail.com']

export function adminEmailSet(envValue?: string | null): Set<string> {
  const fromEnv = (envValue ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...DEFAULT_ADMIN_EMAILS.map((e) => e.toLowerCase()), ...fromEnv])
}

export function isAdminEmail(email: string | null | undefined, envValue?: string | null): boolean {
  if (!email) return false
  return adminEmailSet(envValue).has(email.toLowerCase())
}
