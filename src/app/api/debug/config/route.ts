import { NextResponse } from 'next/server'

export async function GET() {
  const vars = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
    'ANTHROPIC_API_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'NEXT_PUBLIC_APP_URL',
    // Server-side admin (needed for Copilot writes, delete-family, cron)
    'FIREBASE_SERVICE_ACCOUNT',
    'CRON_SECRET',
    'NEXT_PUBLIC_FIREBASE_VAPID_KEY',
  ]

  const status: Record<string, boolean> = {}
  for (const v of vars) {
    status[v] = !!process.env[v]
  }

  // Verify the service account JSON actually parses (set-but-malformed is a
  // common mistake when pasting the key into Vercel).
  let serviceAccountValid = false
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      serviceAccountValid = !!parsed.project_id && !!parsed.private_key
    } catch {
      serviceAccountValid = false
    }
  }

  return NextResponse.json({ ...status, FIREBASE_SERVICE_ACCOUNT_VALID_JSON: serviceAccountValid })
}
