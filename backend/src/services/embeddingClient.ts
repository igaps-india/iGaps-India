/**
 * embeddingClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin HTTP client for the Python microservice /embed endpoint.
 *
 * DESIGN:
 *   - Single exported function, single responsibility.
 *   - Throws a typed error on failure so callers can decide how to handle it
 *     (the llm_rubric branch in evaluationEngine catches and falls back to
 *     static bank rather than crashing the evaluation pipeline).
 *   - Reads PYTHON_MICROSERVICE_URL from config so the URL is configurable
 *     per environment without code changes.
 *   - 8-second timeout — enough for the embedding call which is <50ms after
 *     warm-up, but will fail fast if the Python service is not running.
 */

import { config } from '../config';

const EMBED_URL = `${config.features.pythonMicroserviceUrl}/embed`;
const TIMEOUT_MS = 8_000;

export interface EmbedResult {
  embedding: number[];  // 384-dim float vector (all-MiniLM-L6-v2)
  model: string;        // e.g. "sentence-transformers/all-MiniLM-L6-v2"
}

/**
 * Encodes `text` into a dense vector using the Python microservice's
 * pre-warmed sentence-transformer model.
 *
 * @throws {Error} if the Python service is unavailable or returns an error.
 *   Callers in the scoring pipeline MUST catch this and fall back gracefully.
 */
export async function embedText(text: string): Promise<EmbedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding service returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { embedding?: number[]; model?: string };

    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error('Embedding service returned empty or malformed embedding array');
    }

    return {
      embedding: data.embedding,
      model: data.model ?? 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}
