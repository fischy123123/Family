import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode } from '@/lib/google/oauth'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const code = request.nextUrl.searchParams.get('code')
  const error = request.nextUrl.searchParams.get('error')

  if (error || !code) {
    return NextResponse.redirect(`${base}/dashboard?google=error`)
  }

  try {
    const tokens = await exchangeCode(code)
    const cookieStore = await cookies()
    cookieStore.set('google_tokens_pending', JSON.stringify(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 120,
      path: '/',
      sameSite: 'lax',
    })
    return NextResponse.redirect(`${base}/dashboard?google=connected`)
  } catch (e) {
    console.error('OAuth callback error:', e)
    return NextResponse.redirect(`${base}/dashboard?google=error`)
  }
}
