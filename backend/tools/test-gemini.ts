import { config } from '../src/config';
import { getLLMProvider, isLLMConfigured } from '../src/llm';

async function main() {
  console.log('GEMINI_API_KEY set:', Boolean(config.llm.geminiApiKey));
  console.log('isLLMConfigured:', isLLMConfigured());
  console.log('model:', config.llm.geminiModel);

  if (!isLLMConfigured()) {
    console.error('LLM not configured — check GEMINI_API_KEY in .env');
    process.exit(1);
  }

  const llm = getLLMProvider();
  const response = await llm.complete(
    [{ role: 'user', content: 'Reply with JSON only: {"ok":true}' }],
    { jsonMode: true, task: 'agent', temperature: 0 },
  );
  console.log('response:', response.text.slice(0, 200));
  console.log('parsed:', response.json);
  console.log('OK — Gemini is working');
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
