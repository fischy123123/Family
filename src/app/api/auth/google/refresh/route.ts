import { NextRequest, NextResponse } from 'next/server'
import { refreshAccessToken } from '@/lib/google/oauth'

export async function POST(request: NextRequest) {
  const { refreshToken } = await request.json()
  if (!refreshToken) return NextResponse.json({ error: 'refreshToken required' }, { status: 400 })
  try {
    const credentials = await refreshAccessToken(refreshToken)
    return NextResponse.json({ accessToken: credentials.access_token, expiryDate: credentials.expiry_date })
  } catch (e) {
    console.error('Token refresh error:', e)
    return NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 })
  }
}
