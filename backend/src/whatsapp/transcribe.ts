// Transcripción de audios con Groq Whisper (API compatible con OpenAI).
import { logger } from '../lib/logger';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';

function extFor(mimetype: string): string {
  if (mimetype.includes('ogg') || mimetype.includes('opus')) return 'ogg';
  if (mimetype.includes('m4a') || mimetype.includes('mp4') || mimetype.includes('aac')) return 'm4a';
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return 'mp3';
  if (mimetype.includes('wav')) return 'wav';
  return 'ogg';
}

/** Transcribe un audio a texto en español. Lanza error con .status si falla. */
export async function transcribeAudio(apiKey: string, buffer: Buffer, mimetype: string): Promise<string> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimetype || 'audio/ogg' });
  form.append('file', blob, `audio.${extFor(mimetype || '')}`);
  form.append('model', MODEL);
  form.append('language', 'es');
  form.append('response_format', 'json');

  const res = await fetch(GROQ_WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, text: text.slice(0, 500) }, 'Groq Whisper error');
    if (res.status === 401) throw Object.assign(new Error('Clave de IA inválida.'), { status: 400 });
    if (res.status === 429) throw Object.assign(new Error('Groq: límite de uso alcanzado.'), { status: 429 });
    throw Object.assign(new Error('No se pudo transcribir el audio.'), { status: 502 });
  }

  const data = await res.json() as { text?: string };
  return (data.text || '').trim();
}
