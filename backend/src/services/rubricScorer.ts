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

  const userMessage = [
    `## Answer to evaluate`,
    answerText.trim(),
    contextHint ? `\n## Additional context\n${contextHint}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await llm.complete(
    [
      { role: 'system', content: rubricContent },
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
