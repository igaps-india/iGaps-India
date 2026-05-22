import { config } from '../config';
import { GeminiProvider } from './GeminiProvider';
import { LLMProvider } from './types';

export * from './types';

let _provider: LLMProvider | null = null;

const PLACEHOLDER_KEY_FRAGMENTS = ['your_gemini_api_key', 'xxxx', 'changeme', 'placeholder'];

/** True when a real (non-placeholder) Gemini API key is configured. */
export function isLLMConfigured(): boolean {
  const key = config.llm.geminiApiKey?.trim() ?? '';
  if (!key) return false;
  const lower = key.toLowerCase();
  return !PLACEHOLDER_KEY_FRAGMENTS.some((frag) => lower.includes(frag));
}

export function getLLMProvider(): LLMProvider {
  if (!isLLMConfigured()) {
    throw new Error('[LLM] GEMINI_API_KEY is not configured');
  }
  if (!_provider) {
    switch (config.llm.provider) {
      case 'gemini':
        _provider = new GeminiProvider();
        break;
      default:
        throw new Error(`[LLM] Unknown provider: ${config.llm.provider}`);
    }
    console.info(`[LLM] Using provider: ${_provider.providerName} / model: ${_provider.defaultModel}`);
  }
  return _provider;
}
