import { GoogleGenAI } from '@google/genai';
import NodeCache from 'node-cache';
import { createHash } from 'crypto';
import { config } from '../config';
import { LLMMessage, LLMProvider, LLMRequestOptions, LLMResponse, LLMTask } from './types';

// Response cache — keyed by hash(model + messages + opts).
// TTL 1 hour. Prevents duplicate calls for identical rubric evaluations.
const responseCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

function modelForTask(task: LLMTask | undefined): string {
  switch (task) {
    case 'rubric':
      return config.llm.geminiModelRubric;
    case 'agent':
      return config.llm.geminiModelAgent;
    default:
      return config.llm.geminiModel;
  }
}

function maxTokensForTask(task: LLMTask | undefined, override?: number): number {
  if (override !== undefined) return override;
  switch (task) {
    case 'agent':
      return 16384;
    case 'rubric':
      return 4096;
    default:
      return 8192;
  }
}

function cacheKey(model: string, messages: LLMMessage[], opts: LLMRequestOptions): string {
  return createHash('sha256')
    .update(JSON.stringify({ model, messages, opts }))
    .digest('hex');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('high demand')
  );
}

export class GeminiProvider implements LLMProvider {
  readonly providerName = 'gemini';
  readonly defaultModel: string;

  private client: GoogleGenAI;

  constructor() {
    if (!config.llm.geminiApiKey) {
      throw new Error('[LLM] GEMINI_API_KEY is not set');
    }
    this.client = new GoogleGenAI({ apiKey: config.llm.geminiApiKey });
    this.defaultModel = config.llm.geminiModel;
  }

  async complete(messages: LLMMessage[], opts: LLMRequestOptions = {}): Promise<LLMResponse> {
    const model = modelForTask(opts.task);
    const temperature = opts.temperature ?? 0;
    const topP = opts.topP ?? 0.1;
    const jsonMode = opts.jsonMode ?? false;

    // Cache check (only when temperature = 0 for determinism)
    if (temperature === 0) {
      const key = cacheKey(model, messages, opts);
      const cached = responseCache.get<LLMResponse>(key);
      if (cached) {
        return cached;
      }
    }

    // Split messages into system instruction + conversation
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMsgs = messages.filter((m) => m.role !== 'system');

    const contents = conversationMsgs.map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }],
    }));

    const maxAttempts = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.client.models.generateContent({
          model,
          contents,
          config: {
            ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
            temperature,
            topP,
            maxOutputTokens: maxTokensForTask(opts.task, opts.maxOutputTokens),
            responseMimeType: jsonMode ? 'application/json' : 'text/plain',
          },
        });

        const text = result.text ?? '';
        const finishReason = (result as { candidates?: Array<{ finishReason?: string }> }).candidates?.[0]
          ?.finishReason;
        let json: unknown | undefined;

        if (jsonMode) {
          try {
            json = JSON.parse(text);
          } catch {
            const outTokens = result.usageMetadata?.candidatesTokenCount;
            throw new Error(
              `[LLM] Failed to parse JSON response (finish=${finishReason ?? 'unknown'}, outTokens=${outTokens ?? '?'}): ${text.slice(0, 300)}`,
            );
          }
        }

        const response: LLMResponse = {
          text,
          json,
          inputTokens: result.usageMetadata?.promptTokenCount,
          outputTokens: result.usageMetadata?.candidatesTokenCount,
          model,
          provider: this.providerName,
        };

        if (temperature === 0) {
          const key = cacheKey(model, messages, opts);
          responseCache.set(key, response);
        }

        return response;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && isRetryableGeminiError(err)) {
          const delayMs = attempt * 4000;
          console.warn(`[LLM] Gemini attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms…`);
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
