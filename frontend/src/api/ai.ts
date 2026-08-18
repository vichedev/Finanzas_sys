import { http } from './http';

export interface AiConfig {
  provider: string;          // groq | openrouter
  model: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;           // clave del "cerebro" (análisis/parsing)
  hasTranscribeKey: boolean; // clave de Groq para transcribir audio (Whisper)
}

export interface AiConfigPayload {
  provider?: string;
  apiKey?: string;           // clave del cerebro
  transcribeApiKey?: string; // clave de Groq para audio
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export interface AnalyzeResult {
  analysis: string;
  snapshot: Record<string, unknown>;
  generatedAt: string;
}

export const aiApi = {
  async getConfig(): Promise<AiConfig> {
    const { data } = await http.get<AiConfig>('/ai/config');
    return data;
  },
  async saveConfig(payload: AiConfigPayload): Promise<AiConfig> {
    const { data } = await http.put<AiConfig>('/ai/config', payload);
    return data;
  },
  async clearKey(): Promise<void> {
    await http.delete('/ai/config');
  },
  async analyze(question?: string): Promise<AnalyzeResult> {
    const { data } = await http.post<AnalyzeResult>('/ai/analyze', { question: question || undefined });
    return data;
  }
};
