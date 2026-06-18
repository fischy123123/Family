import { NextRequest, NextResponse } from 'next/server'

// Text-to-speech via OpenAI. Returns MP3 audio for the given text.
export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
  }

  const { text, voice } = (await request.json()) as { text?: string; voice?: string }
  if (!text || !text.trim()) {
    return NextResponse.json({ error: 'No text provided' }, { status: 400 })
  }

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      // "nova" is warm and natural — good for a friendly family assistant
      voice: voice ?? 'nova',
      input: text.slice(0, 4000),
      response_format: 'mp3',
    }),
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`)
    return NextResponse.json({ error: msg }, { status: res.status })
  }

  const audio = await res.arrayBuffer()
  return new Response(audio, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  })
}
