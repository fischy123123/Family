import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Transcribes audio using OpenAI Whisper.
// Accepts multipart/form-data with:
//   audio — the audio file (webm, mp4/m4a — whatever MediaRecorder produces)
//   prompt — optional hint string to improve recognition of names/terms
export async function POST(request: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Transcription not configured' }, { status: 503 })
  }

  const form = await request.formData()
  const audio = form.get('audio') as File | null
  const prompt = (form.get('prompt') as string | null) ?? ''

  if (!audio || audio.size === 0) {
    return NextResponse.json({ error: 'No audio provided' }, { status: 400 })
  }

  const whisperForm = new FormData()
  whisperForm.append('file', audio)
  whisperForm.append('model', 'whisper-1')
  whisperForm.append('response_format', 'json')
  // Prompt hint: seeding Whisper with family names and context dramatically
  // improves accuracy for proper nouns that the base model wouldn't guess.
  if (prompt) whisperForm.append('prompt', prompt)

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: whisperForm,
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    console.error('[transcribe] Whisper error:', res.status, err)
    return NextResponse.json({ error: 'Transcription failed' }, { status: 502 })
  }

  const data = await res.json() as { text?: string }
  return NextResponse.json({ text: (data.text ?? '').trim() })
}
