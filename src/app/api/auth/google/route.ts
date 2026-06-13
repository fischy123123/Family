import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/google/oauth'

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email') ?? ''
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 })
  }
  const url = getAuthUrl(email)
  return NextResponse.redirect(url)
}
