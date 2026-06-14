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
  ]

  const status: Record<string, boolean> = {}
  for (const v of vars) {
    status[v] = !!process.env[v]
  }

  return NextResponse.json(status)
}
