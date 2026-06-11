import { http } from './http';

export interface AiConfig {
  provider: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
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
  async saveConfig(payload: { apiKey?: string; model?: string; enabled?: boolean }): Promise<AiConfig> {
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
