import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
  }

  const formData = await request.formData()
  const audio = formData.get('audio') as File | null
  if (!audio) {
    return NextResponse.json({ error: 'No audio provided' }, { status: 400 })
  }

  const whisperForm = new FormData()
  whisperForm.append('file', audio)
  whisperForm.append('model', 'whisper-1')
  // Hint Whisper toward English — reduces hallucinations on short clips
  whisperForm.append('language', 'en')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: whisperForm,
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`)
    return NextResponse.json({ error: msg }, { status: res.status })
  }

  const data = (await res.json()) as { text?: string }
  return NextResponse.json({ text: data.text ?? '' })
}
