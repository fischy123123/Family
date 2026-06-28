import { NextRequest, NextResponse } from 'next/server'

// Lightweight speech-to-text for the Moment Coach's "what's going on right now"
// capture. The client records a few seconds with MediaRecorder and POSTs the
// audio blob here; we forward it to OpenAI Whisper and return the transcript.
// Deliberately simple (single short clip, no streaming) — distinct from the
// realtime WebRTC voice used elsewhere.
export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
  }

  let inForm: FormData
  try {
    inForm = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 })
  }

  const file = inForm.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
  }
  // Guard against empty/oversized clips (Whisper hard-limits at 25MB).
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty recording' }, { status: 400 })
  }
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: 'Recording too long' }, { status: 413 })
  }

  try {
    const outForm = new FormData()
    // Whisper infers format from the filename extension; default to webm (what
    // MediaRecorder produces in Chrome/Safari) when the blob carries no name.
    const name = (file as File).name || 'clip.webm'
    outForm.append('file', file, name)
    outForm.append('model', 'whisper-1')
    outForm.append('response_format', 'json')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outForm,
      signal: request.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[transcribe] whisper error', res.status, detail.slice(0, 300))
      return NextResponse.json({ error: 'Transcription failed' }, { status: 502 })
    }

    const data = (await res.json()) as { text?: string }
    return NextResponse.json({ text: (data.text ?? '').trim() })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'aborted' }, { status: 499 })
    }
    console.error('[transcribe] error', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
  }
}
