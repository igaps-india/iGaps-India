/**
 * KNNRetriever.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieves the K nearest labeled examples for a given signal using
 * brute-force cosine similarity against the SignalExample MongoDB collection.
 *
 * WHY BRUTE-FORCE (for now):
 *   At current corpus size (4–200 examples per signal), brute-force cosine in
 *   Node.js is fast enough (<5ms for 200 vectors of 384 dims). Introducing
 *   Pinecone/Weaviate/pgvector would add infrastructure complexity for a
 *   problem that doesn't need it yet. The interface is clean — when the corpus
 *   grows past ~10,000 examples per signal, swap the internals of
 *   getKNNExamples to call a real vector DB without touching any call sites.
 *
 * INDEXING RULE:
 *   All retrieval is scoped by signalKey. Never query globally — a neighbor
 *   from "team_strength" is meaningless when grounding "evidence_of_demand".
 *   Each signalKey is its own embedding space with its own scoring semantics.
 *
 * EMPTY ARRAY CONTRACT:
 *   getKNNExamples returns [] when no qualifying neighbors exist (cold start,
 *   corpus too sparse, no candidates above threshold). This is NOT an error.
 *   Callers MUST treat [] as "fall back to static rubric bank" — never as
 *   a failure condition. The static bank remains the permanent cold-start path.
 */

import { SignalExample, ISignalExample } from '../models/SignalExample';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KNNNeighbor {
  answerText: string;
  score: number;         // ground-truth confirmed score, 0–100
  reasoning: string;     // LLM reasoning from original scoring, for context
  similarity: number;    // cosine similarity to the query, 0–1
}

export interface KNNConfig {
  k: number;                    // number of neighbors to return
  similarityThreshold: number;  // minimum cosine similarity to qualify
}

const DEFAULT_CONFIG: KNNConfig = {
  k: 3,
  similarityThreshold: 0.75,
};

// ── Core math ─────────────────────────────────────────────────────────────────

/**
 * Computes cosine similarity between two equal-length vectors.
 * Returns 0 if either vector is zero-magnitude (avoids division by zero).
 * Exported for use in the leave-one-out evaluation harness (evaluateKNN.ts).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── KNN retrieval ─────────────────────────────────────────────────────────────

/**
 * Finds the K nearest labeled examples for a given signal.
 *
 * Algorithm:
 *   1. Load all SignalExample documents for this signalKey (filtered in DB).
 *   2. Compute cosine similarity between queryEmbedding and each candidate.
 *   3. Filter by similarityThreshold.
 *   4. Sort descending by similarity, take top-K.
 *
 * Returns [] when:
 *   - No examples exist for this signalKey (cold start).
 *   - No examples score above the similarity threshold (sparse corpus).
 *
 * Callers MUST handle [] by falling back to the static EXAMPLE_BANK.
 */
export async function getKNNExamples(
  queryEmbedding: number[],
  signalKey: string,
  config: KNNConfig = DEFAULT_CONFIG,
): Promise<KNNNeighbor[]> {
  // Load all candidates for this signal. At current scale this is fast.
  // When corpus grows, add .limit() and do approximate NN search instead.
  const candidates = await SignalExample.find({ signalKey }).lean() as unknown as ISignalExample[];

  if (candidates.length === 0) {
    return [];
  }

  const scored = candidates.map((c) => ({
    answerText: c.answerText,
    score:      c.score,
    reasoning:  c.reasoning,
    similarity: cosineSimilarity(queryEmbedding, c.embedding),
  }));

  const qualifying = scored
    .filter((s) => s.similarity >= config.similarityThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, config.k);

  return qualifying;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export interface PersistSignalExampleParams {
  signalKey:      string;
  rubricId:       string;
  applicationId:  string;
  answerText:     string;
  embedding:      number[];
  embeddingModel: string;
  score:          number;
  scoreSource:    'admin_confirmed' | 'high_confidence_auto';
  reasoning:      string;
}

/**
 * Persists a labeled answer as a reusable SignalExample for future KNN retrieval.
 *
 * Uses upsert on the (applicationId, signalKey) unique index so the backfill
 * script can be run multiple times safely — re-running never creates duplicates,
 * it updates in place with the latest confirmed score and reasoning.
 *
 * GATE: scoreSource must be "admin_confirmed" or "high_confidence_auto".
 * Raw LLM-only scores must never be persisted here.
 */
export async function persistSignalExample(params: PersistSignalExampleParams): Promise<void> {
  await SignalExample.findOneAndUpdate(
    // Unique key — prevents duplicate seeding
    { applicationId: params.applicationId, signalKey: params.signalKey },
    {
      $set: {
        rubricId:       params.rubricId,
        answerText:     params.answerText,
        embedding:      params.embedding,
        embeddingModel: params.embeddingModel,
        score:          params.score,
        scoreSource:    params.scoreSource,
        reasoning:      params.reasoning,
      },
    },
    { upsert: true, new: true },
  );
}
