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
  pitchDeckText?: string,   // NEW: raw parsedText from the Submission upload
  submissionId?: string,    // NEW: used to tag retrieved chunks in audit trail
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

  // ── RAG Grounding: inject real startup examples into the prompt ──────────────
  // This is the Phase 3 upgrade. Instead of the LLM scoring in a vacuum,
  // it now compares the founder's answer against 3 graded real-world examples.
  // This dramatically reduces hallucination and calibration drift.
  const ragExamples = getRAGExamples(rubricId);
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

  const systemContent = LANGUAGE_BIAS_GUARD + rubricContent;

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
