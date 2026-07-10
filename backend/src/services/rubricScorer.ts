/**
 * LLM Rubric Scoring Service
 *
 * Loads a rubric template from backend/src/rubrics/<id>.md,
 * formats the answer text into the prompt, calls LLMProvider,
 * validates the JSON output against a strict Zod schema,
 * and returns a typed score result.
 *
 * The Zod schema enforces:
 *   - score: number 0–100 (never a string, never undefined)
 *   - raw_text_evidence: the exact quote used (or null if none found)
 *   - weakness: what was weak (or null)
 *   - confidence: high / medium / low
 * If the LLM returns invalid data, the signal scores 0 and the
 * ZodError reason is saved in evidence — pipeline never crashes.
 *
 * All calls use temperature=0 + response caching for determinism.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { getLLMProvider } from '../llm';
import { getRAGExamples } from './RAGRetriever';
import { PitchDeckVectorStore } from './PitchDeckVectorStore';
import type { KNNNeighbor } from './KNNRetriever';

const RUBRICS_DIR = join(__dirname, '..', 'rubrics');

// ── Strict Zod Schema (every LLM rubric call MUST match this) ─────────────────
// The LLM is not allowed to return free-form text.
// It must fill out this exact structure — or the score is 0.

const RubricLLMOutputSchema = z.object({
  // The numeric score — strictly 0 to 100
  score: z.number().min(0).max(100),

  // The qualitative band matching the score
  band: z.enum(['exceptional', 'strong', 'adequate', 'weak', 'very_weak']),

  // MANDATORY audit field: the exact quote from the founder's text
  // that the LLM used as evidence for the score.
  // Must be null (not empty string) if no evidence was found.
  raw_text_evidence: z.string().nullable(),

  // What was specifically weak in the answer (or null if nothing)
  weakness: z.string().nullable(),

  // How confident is the LLM in this score?
  confidence: z.enum(['high', 'medium', 'low']),

  // Optional flags — only present when rubric explicitly checks for them
  inarticulate_genius_flag: z.boolean().optional(),
  tar_pit_flag: z.boolean().optional(),
  contradiction_flag: z.boolean().optional(),

  // Legacy field — keep for backward compatibility with existing rubric files
  evidence: z.string().optional(),
  weaknesses: z.array(z.string()).optional(),
});

// Infer the TypeScript type from the schema automatically
type RubricLLMOutput = z.infer<typeof RubricLLMOutputSchema>;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScoreBand =
  | 'exceptional'
  | 'strong'
  | 'adequate'
  | 'weak'
  | 'very_weak';

export interface RubricScoreResult {
  rubricId: string;
  score: number;                          // 0–100
  band: ScoreBand;
  evidence: string;
  weaknesses: string[];
  // Strict audit fields — always present after Zod validation
  rawTextEvidence: string | null;         // Exact quote from founder text used as evidence
  weakness: string | null;               // Specific weakness identified
  confidence: 'high' | 'medium' | 'low'; // LLM confidence in this score
  scoringMethod: 'llm_rubric';           // Always llm_rubric for this scorer
  zodValidated: boolean;                 // True if schema passed, false if fallback used
  // Optional flags (present only when rubric defines them)
  inarticulateGeniusFlag?: boolean;
  tarPitFlag?: boolean;
  contradictionFlag?: boolean;
  rawJson: unknown;
}

// ── Rubric loader ─────────────────────────────────────────────────────────────

function loadRubric(rubricId: string): string {
  const path = join(RUBRICS_DIR, `${rubricId}.md`);
  if (!existsSync(path)) {
    throw new Error(`[RubricScorer] Rubric not found: ${rubricId}`);
  }
  return readFileSync(path, 'utf-8');
}

// ── Score an answer ───────────────────────────────────────────────────────────

export async function scoreWithRubric(
  rubricId: string,
  answerText: string,
  contextHint?: string,
  pitchDeckText?: string,   // raw parsedText from the Submission upload
  submissionId?: string,    // used to tag retrieved chunks in audit trail
  knnNeighbors?: KNNNeighbor[], // pre-fetched KNN grounding examples (from evaluationEngine)
): Promise<RubricScoreResult> {
  if (!answerText?.trim() || answerText.trim().length < 10) {
    return emptyScore(rubricId, 'Answer is empty or too short to evaluate.');
  }

  if (process.env.MOCK_LLM_FOR_TESTING === 'true') {
    return {
      rubricId,
      score: 75,
      band: 'strong',
      evidence: '[MOCK] Scored via testing bypass to save API credits.',
      weaknesses: ['[MOCK] No weaknesses identified.'],
      rawTextEvidence: '[MOCK] Testing bypass active — no real evidence extracted.',
      weakness: null,
      confidence: 'high',
      scoringMethod: 'llm_rubric',
      zodValidated: false,
      rawJson: { mock: true },
    };
  }

  let rubricContent = loadRubric(rubricId);

  // ── Grounding: inject real startup examples into the prompt ─────────────────
  // Priority order:
  //   1. KNN neighbors (dynamic, pre-fetched by evaluationEngine) — when corpus exists
  //   2. Static EXAMPLE_BANK (RAGRetriever) — permanent cold-start fallback
  //   3. Nothing — slot placeholder is removed, rubric scores on description alone
  //
  // The KNN path is ONLY taken when the caller passes a non-empty neighbors array.
  // An empty array [] means "no qualifying neighbors found" — fall through to static bank.
  // Never remove getRAGExamples; it is the permanent fallback, not legacy code.
  let ragExamples: string;
  if (knnNeighbors && knnNeighbors.length > 0) {
    ragExamples = formatKNNNeighbors(knnNeighbors);
  } else {
    ragExamples = getRAGExamples(rubricId);
  }

  if (ragExamples) {
    if (rubricContent.includes('{{RAG_EXAMPLES}}')) {
      // New-format rubric: has an explicit injection slot
      rubricContent = rubricContent.replace('{{RAG_EXAMPLES}}', ragExamples);
    } else {
      // Legacy-format rubric: append examples before the JSON output section
      rubricContent = rubricContent.replace(
        '## Output format',
        `## Calibration examples\n${ragExamples}\n## Output format`,
      );
    }
  } else {
    // No examples available — remove the slot placeholder if present
    rubricContent = rubricContent.replace(
      '{{RAG_EXAMPLES}}',
      '(No calibration examples available for this rubric — score based on rubric description alone.)',
    );
  }

  const llm = getLLMProvider();

  // ── Pitch deck hybrid retrieval (Fix 4.1 + 4.2 + 4.3) ───────────────────
  // If a parsed pitch deck is available for this submission, chunk it,
  // classify chunks by slide type, and retrieve the top-3 most relevant
  // chunks for this specific signal using BM25 + dense hybrid reranking.
  // The retrieved excerpts are injected into the prompt so the LLM can
  // cross-check the founder's questionnaire answers against the deck.
  let pitchDeckContext = '';
  if (pitchDeckText && pitchDeckText.trim().length > 100) {
    try {
      const store = new PitchDeckVectorStore(pitchDeckText, submissionId ?? 'unknown');
      // Map rubricId to signal key for routing (strip 'rubric.' prefix + '.v1' suffix)
      const signalKey = rubricId
        .replace(/^rubric\./, '')
        .replace(/\.v\d+$/, '');
      const chunks = await store.retrieveForSignal(signalKey, 3);
      if (chunks.length > 0) {
        pitchDeckContext = PitchDeckVectorStore.formatAsContext(chunks, signalKey);
      }
    } catch (err) {
      // Non-fatal — pitch deck retrieval failure must never crash scoring
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[RubricScorer] Pitch deck retrieval failed for ${rubricId}: ${msg}`);
    }
  }

  // ── Language-bias guard ───────────────────────────────────────────────────
  // This block is prepended to EVERY rubric prompt.
  // It explicitly instructs the LLM to evaluate SUBSTANCE only and never
  // deduct points for informal writing, Hinglish, short sentences, or
  // regional Indian English phrasing.
  // Without this, LLMs trained on formal English silently penalize founders
  // from Tier-2 cities who write in a non-Western pitching style.
  const LANGUAGE_BIAS_GUARD = `## Critical evaluation instruction — read before scoring

You are evaluating Indian startup founders. Many founders from Tier-2 cities,
non-English backgrounds, or technical domains write in informal English, use
short direct sentences, or mix Hindi/regional words into their answers.

**You MUST NOT reduce the score because of:**
- Short or direct sentences (e.g. "We lost the customer. We rebuilt in 3 months.")
- Informal words (e.g. "coz", "gonna", "tbh", "only", "itself" in Indian English sense)
- Hinglish phrases (e.g. "hai", "nahi", "bas", "se")
- Lack of formal business vocabulary or "pitch deck" language
- Grammar that is non-standard but clearly understandable
- Repetition or non-linear sentence structure

**You MUST score based solely on:**
- The SUBSTANCE: Are there real numbers, dates, named people, specific outcomes?
- The EVIDENCE: Does the answer demonstrate actual lived experience?
- The SIGNAL: Does the answer address what the rubric is measuring?

A founder who writes "We lost 40% revenue in month 3, cut team, rebuilt, now profitable"
deserves a HIGH score on execution — regardless of writing style.
A founder who writes "We are very resilient and passionate about our journey and believe
in the mission strongly" deserves a LOW score — regardless of formal grammar.

---

`;

  // ── Maturity benchmark guard ──────────────────────────────────────────────
  // This block teaches the LLM to calibrate scores against BUSINESS MATURITY,
  // not just against answer eloquence. A Pre-Series A founder with ₹2Cr ARR
  // should score higher than a Pre-Seed founder who writes a beautifully
  // articulated but entirely theoretical answer.
  //
  // This is the single most important guard for ensuring the model correctly
  // ranks later-stage companies above earlier-stage ones without hardcoding ranks.
  // It relies on the calibration examples (KNN/RAG) to provide the baseline —
  // the LLM is instructed to read those examples and understand what "good"
  // looks like at different maturity stages.
  const MATURITY_BENCHMARK_GUARD = `## Strict Maturity & Stage-Based Scoring Hierarchy
  
You must strictly scale your score according to the company's maturity stage (provided in the Additional Context). The business stage dictates the absolute ceiling and baseline of the score.

**CRITICAL RANKING RULES BY STAGE:**
1. **Pre-Series A / Series A:** These companies have demonstrated significant revenue, product-market fit, and scale. They MUST receive the HIGHEST baseline scores (e.g., 85-100) if they provide concrete metrics, ignoring any brief or informal writing.
2. **Seed:** These companies have early traction and revenue but lack scale. Their scores MUST BE STRICTLY LOWER than Pre-Series A companies, generally in the mid-range (e.g., 50-80), regardless of how beautifully written their answers are.
3. **Pre-Seed / Idea Stage:** These companies have zero or negligible revenue and rely mostly on theoretical answers. Their scores MUST BE THE LOWEST (e.g., 0-50). Even if a Pre-Seed founder writes a perfect, articulate essay, their score CANNOT exceed that of a Seed company with real traction.

**Core principle: Traction and proven execution IS the substance.**
Do NOT let eloquent writing, jargon, or long answers from a Pre-Seed company outscore a brief, informal, or poorly written answer from a Pre-Series A company that has actual revenue and customers.

**Scoring rule:**
- Look at the "Company Stage" in the Additional Context.
- Enforce the hierarchy: Pre-Series A > Seed > Pre-Seed.
- If an answer is entirely theoretical (common in Pre-Seed), score it very low.
- If an answer has verifiable traction (Pre-Series A), score it very high.

---

`;

  const systemContent = LANGUAGE_BIAS_GUARD + MATURITY_BENCHMARK_GUARD + rubricContent;

  const userMessage = [
    pitchDeckContext ? pitchDeckContext : '',
    `## Answer to evaluate`,
    answerText.trim(),
    contextHint ? `\n## Additional context\n${contextHint}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await llm.complete(
    [
      { role: 'system', content: systemContent },
      { role: 'user', content: userMessage },
    ],
    {
      task: 'rubric',
      temperature: 0,
      topP: 0.1,
      jsonMode: true,
    },
  );

  // ── Strict Zod Validation ──────────────────────────────────────────────────
  // Parse and validate the LLM response against our strict schema.
  // If the LLM returned invalid/missing fields, zodResult.success = false
  // and we fall back to a 0-score result instead of crashing the pipeline.
  const rawParsed = response.json as Record<string, unknown>;
  const zodResult = RubricLLMOutputSchema.safeParse(rawParsed);

  if (!zodResult.success) {
    // LLM returned data that doesn't match our schema.
    // Log the Zod error for debugging and return a safe 0-score fallback.
    const zodError = zodResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    console.warn(
      `[RubricScorer] Zod validation FAILED for rubric ${rubricId}. ` +
      `LLM response did not match schema. Errors: ${zodError}. ` +
      `Raw response: ${JSON.stringify(rawParsed).slice(0, 200)}`,
    );
    return zodValidationFailedScore(rubricId, zodError, rawParsed);
  }

  // Schema passed — use the validated, typed data
  const validated: RubricLLMOutput = zodResult.data;

  return {
    rubricId,
    score: clamp(validated.score, 0, 100),
    band: validated.band,
    // Legacy fields — populated from new fields for backward compatibility
    evidence: validated.raw_text_evidence ?? validated.evidence ?? '',
    weaknesses: validated.weaknesses ?? (validated.weakness ? [validated.weakness] : []),
    // New strict audit fields
    rawTextEvidence: validated.raw_text_evidence,
    weakness: validated.weakness,
    confidence: validated.confidence,
    scoringMethod: 'llm_rubric',
    zodValidated: true,
    // Optional flags
    inarticulateGeniusFlag: validated.inarticulate_genius_flag === true,
    tarPitFlag: validated.tar_pit_flag === true,
    contradictionFlag: validated.contradiction_flag === true,
    rawJson: validated,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyScore(rubricId: string, reason: string): RubricScoreResult {
  return {
    rubricId,
    score: 0,
    band: 'very_weak',
    evidence: reason,
    weaknesses: [reason],
    rawTextEvidence: null,
    weakness: reason,
    confidence: 'low',
    scoringMethod: 'llm_rubric',
    zodValidated: false,
    rawJson: { auto_scored: true, reason },
  };
}

/** Called when the LLM returns data that doesn't match the Zod schema. */
function zodValidationFailedScore(
  rubricId: string,
  zodError: string,
  rawJson: unknown,
): RubricScoreResult {
  return {
    rubricId,
    score: 0,
    band: 'very_weak',
    evidence: `[ZOD_VALIDATION_FAILED] LLM response did not match required schema: ${zodError}`,
    weaknesses: [`Schema validation failed: ${zodError}`],
    rawTextEvidence: null,
    weakness: `LLM schema validation failed: ${zodError}`,
    confidence: 'low',
    scoringMethod: 'llm_rubric',
    zodValidated: false,
    rawJson,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normalizeBand(raw: string): ScoreBand {
  const normalized = raw.toLowerCase().replace(/[^a-z_]/g, '');
  if (['exceptional', 'strong', 'adequate', 'weak', 'very_weak'].includes(normalized)) {
    return normalized as ScoreBand;
  }
  return 'weak';
}

/**
 * Formats KNN neighbors into the same markdown shape as getRAGExamples()
 * so rubric templates need zero changes when switching grounding source.
 *
 * Includes similarity score in the header for LLM awareness and audit trail.
 * KNN neighbors already have a ground-truth score and LLM reasoning from their
 * original evaluation — both are included to maximize grounding quality.
 */
function formatKNNNeighbors(neighbors: KNNNeighbor[]): string {
  const lines: string[] = [
    '> **Note:** The following examples are the closest real founder answers from the',
    '> confirmed evaluation corpus (retrieved by embedding similarity). Use them as',
    '> concrete anchors — the current answer should be scored relative to these.',
    '',
  ];

  neighbors.forEach((n, i) => {
    // Infer a band label from the score for readability
    let band = 'adequate';
    if (n.score >= 80) band = 'strong';
    else if (n.score >= 65) band = 'adequate';
    else if (n.score >= 40) band = 'weak';
    else band = 'very_weak';
    if (n.score >= 90) band = 'exceptional';

    lines.push(`### Example ${i + 1} — Score ${n.score} (${band}) [similarity: ${(n.similarity * 100).toFixed(1)}%]`);
    lines.push(`**Answer:** "${n.answerText}"`);
    if (n.reasoning) {
      lines.push(`**Why this score:** ${n.reasoning}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
