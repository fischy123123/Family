import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Proxy TTS requests to OpenAI so the API key never reaches the client.
// tts-1 is used over tts-1-hd: same perceived quality for short texts but
// ~40% lower latency, which matters when someone is waiting for audio to start.
// Voice: "nova" — warm and natural, well-suited for a family assistant.
export async function POST(request: NextRequest) {
  const { text } = await request.json() as { text?: string }

  if (!text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'TTS not configured' }, { status: 503 })
  }

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova',
      input: text.slice(0, 4096),   // hard cap — OpenAI limit is 4096 chars
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    console.error('[tts] OpenAI error:', res.status, err)
    return NextResponse.json({ error: 'TTS generation failed' }, { status: 502 })
  }

  const audio = await res.arrayBuffer()
  return new NextResponse(audio, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  })
}
