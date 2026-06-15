/**
 * PitchDeckVectorStore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * In-process pitch deck chunker, classifier, and hybrid retriever.
 *
 * ARCHITECTURE:
 *   1. CHUNK   — Split the raw parsedText from the Submission upload into
 *                overlapping text windows (~300 words each).
 *   2. CLASSIFY— Tag every chunk with a slide_type (problem/market/solution/
 *                traction/team/financials/competition/other) using keyword
 *                matching (Fix 4.1 from master prompt).
 *   3. EMBED   — Call the Python microservice /score/vector endpoint to get
 *                a dense similarity score between a query and each chunk.
 *   4. RERANK  — Apply hybridRerank() (Fix 4.3) which combines the dense
 *                score (70%) with a BM25 keyword score (30%).
 *   5. ROUTE   — Only search slide types relevant to the current signal
 *                (Fix 4.2 — signal-to-slide routing map).
 *
 * WHY IN-PROCESS (not Pinecone/Chroma):
 *   At this stage, using an external vector DB would require infra setup and
 *   API keys. The parsedText is already stored in MongoDB on the Submission
 *   document. Chunking + BM25 + dense scoring via the Python microservice
 *   gives 80% of the benefit with zero new infra dependencies.
 *   When you have 500+ submissions, swap the embed step for a real vector DB.
 *
 * USAGE:
 *   const store = new PitchDeckVectorStore(parsedText, submissionId);
 *   const chunks = await store.retrieveForSignal('stated_traction', 3);
 *   // chunks are top-3 hybrid-ranked, slide-type-filtered text blocks
 */

import axios from 'axios';
import { hybridRerank, bm25Score } from './RAGRetriever';
import type { Chunk } from './RAGRetriever';

// ── Slide-type classifier (Fix 4.1) ──────────────────────────────────────────

const SLIDE_TYPE_KEYWORDS: Record<string, string[]> = {
  problem:     ['problem', 'pain', 'challenge', 'why now', 'broken', 'inefficient', 'fail', 'losing', 'struggle', 'issue'],
  market:      ['TAM', 'SAM', 'SOM', 'billion', 'million', 'CAGR', 'addressable', 'market size', 'segment', 'opportunity'],
  solution:    ['product', 'platform', 'how it works', 'demo', 'features', 'workflow', 'technology', 'architecture', 'built', 'we offer'],
  traction:    ['revenue', 'MRR', 'ARR', 'customers', 'growth', 'paying', 'enterprise', 'pilots', 'LOI', 'signed', 'traction', 'retention'],
  team:        ['founder', 'co-founder', 'advisor', 'background', 'previously', 'experience', 'team', 'years', 'worked at'],
  financials:  ['raise', 'use of funds', 'runway', 'burn rate', 'valuation', 'ask', 'funding', 'investment', 'equity'],
  competition: ['competitor', 'landscape', ' vs ', 'differentiation', 'moat', 'alternative', 'incumbent', 'better than'],
};

type SlideType = keyof typeof SLIDE_TYPE_KEYWORDS | 'other';

function classifyChunk(text: string): SlideType {
  const textLower = text.toLowerCase();
  let bestType: SlideType = 'other';
  let bestCount = 0;

  for (const [slideType, keywords] of Object.entries(SLIDE_TYPE_KEYWORDS)) {
    const count = keywords.filter(kw => textLower.includes(kw.toLowerCase())).length;
    if (count > bestCount) {
      bestCount = count;
      bestType = slideType as SlideType;
    }
  }
  return bestType;
}

// ── Signal → slide-type routing map (Fix 4.2) ────────────────────────────────

const SIGNAL_SLIDE_MAP: Record<string, SlideType[]> = {
  // Track B — Problem & Market
  'openQ4_problem_customer_language_score': ['problem'],
  'openQ4_persona_vividity_score':          ['problem', 'team'],
  'openQ5_discovery_quality_score':         ['problem'],
  'openQ6_need_gap_precision_score':        ['problem', 'competition'],
  'stated_traction':                        ['traction', 'financials'],
  'market_context':                         ['market', 'problem'],
  'customer_urgency':                       ['problem', 'traction'],

  // Track C — Solution
  'openQ7_solution_persona_fit_score':      ['solution'],
  'openQ7_switching_reason_score':          ['solution', 'competition'],
  'technical_coherence':                    ['solution', 'team'],
  'competitive_advantage':                  ['competition', 'solution'],
  'business_model':                         ['financials', 'traction'],

  // Track A — Founder
  'openQ1_causality_coherence_score':       ['team', 'problem'],
  'openQ2_non_obvious_insight_score':       ['problem', 'market', 'competition'],
  'openQ3_leverage_specificity_score':      ['team'],
  'openQ9_pivot_quality_score':             ['traction', 'team'],

  // Track D — Traction / Reality
  'openQ10_customer_initiated_score':       ['traction'],
};

// ── Chunker ───────────────────────────────────────────────────────────────────

interface TaggedChunk {
  text:      string;
  slideType: SlideType;
  chunkIdx:  number;
}

/**
 * Split raw PDF text into overlapping windows.
 * Window size: ~300 words. Overlap: ~50 words (for context continuity).
 */
function chunkText(rawText: string): TaggedChunk[] {
  const WINDOW  = 300;   // words per chunk
  const OVERLAP = 50;    // words carried over from previous chunk

  const words = rawText.split(/\s+/).filter(Boolean);
  const chunks: TaggedChunk[] = [];
  let idx = 0;

  for (let start = 0; start < words.length; start += WINDOW - OVERLAP) {
    const slice = words.slice(start, start + WINDOW).join(' ');
    if (slice.trim().length < 50) break;   // skip tiny tail fragments
    chunks.push({
      text:      slice,
      slideType: classifyChunk(slice),
      chunkIdx:  idx++,
    });
  }

  return chunks;
}

// ── Dense scorer (calls Python microservice) ──────────────────────────────────

/**
 * Get a dense similarity score between the signal query and a chunk of text
 * by calling the Python /score/vector endpoint.
 * Falls back to BM25-only score on timeout/error.
 */
async function getDenseScore(
  signalKey: string,
  chunkText: string,
): Promise<number> {
  try {
    const response = await axios.post<{ score: number; error?: string }>(
      'http://127.0.0.1:8000/score/vector',
      { signal_key: signalKey, answer_text: chunkText },
      { timeout: 3_000 },
    );
    const data = response.data;
    // If the Python service returns an error (unsupported signal key),
    // fall back to 0.5 neutral so BM25 can still differentiate chunks.
    if (data.error || data.score === undefined) return 0.5;
    // Normalize 0–100 → 0–1
    return Math.min(1, Math.max(0, data.score / 100));
  } catch {
    // Network error / timeout — BM25 alone will rank chunks
    return 0.5;
  }
}

// ── Main class ────────────────────────────────────────────────────────────────

export class PitchDeckVectorStore {
  private chunks: TaggedChunk[];
  private submissionId: string;

  constructor(parsedText: string, submissionId: string) {
    this.submissionId = submissionId;
    this.chunks = chunkText(parsedText);
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /**
   * Retrieve the top-k most relevant chunks for a signal.
   *
   * Steps:
   *   1. Filter to chunks whose slide_type matches the signal's routing map.
   *   2. Get dense similarity score for each candidate chunk.
   *   3. Apply hybridRerank() to combine dense (70%) + BM25 (30%).
   *   4. Return top k chunks.
   */
  async retrieveForSignal(signalKey: string, k: number = 3): Promise<Chunk[]> {
    if (this.chunks.length === 0) return [];

    // Step 1: Slide-type filter
    const allowedTypes = SIGNAL_SLIDE_MAP[signalKey] ?? [];
    const candidates = allowedTypes.length > 0
      ? this.chunks.filter(c => allowedTypes.includes(c.slideType))
      : this.chunks;    // no routing rule — search all chunks

    // If filtering left nothing, fall back to all chunks
    const pool = candidates.length > 0 ? candidates : this.chunks;

    // Step 2: Dense score each candidate (parallelised, capped at 10 chunks)
    const topPool = pool.slice(0, 10);
    const scoredChunks: Chunk[] = await Promise.all(
      topPool.map(async (c): Promise<Chunk> => ({
        text:       c.text,
        denseScore: await getDenseScore(signalKey, c.text),
        metadata: {
          slideType:    c.slideType,
          chunkIdx:     c.chunkIdx,
          submissionId: this.submissionId,
        },
      })),
    );

    // Step 3: Hybrid rerank (BM25 + dense) — uses our existing implementation
    const reranked = hybridRerank(scoredChunks, signalKey);

    // Step 4: Return top k
    return reranked.slice(0, k);
  }

  /**
   * Format retrieved chunks as a markdown block for injection into rubric prompts.
   */
  static formatAsContext(chunks: Chunk[], signalKey: string): string {
    if (chunks.length === 0) return '';

    const lines = [
      `## Pitch deck evidence for signal: ${signalKey}`,
      `(${chunks.length} most relevant excerpt${chunks.length > 1 ? 's' : ''} retrieved from the uploaded pitch deck)`,
      '',
    ];

    chunks.forEach((c, i) => {
      const slideType = c.metadata?.slideType ?? 'unknown';
      lines.push(`### Excerpt ${i + 1} [slide_type: ${slideType}]`);
      lines.push(c.text.trim());
      lines.push('');
    });

    return lines.join('\n');
  }
}
