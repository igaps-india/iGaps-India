/**
 * LLM Rubric Scoring Service
 *
 * Loads a rubric template from backend/src/rubrics/<id>.md,
 * formats the answer text into the prompt, calls LLMProvider,
 * validates the JSON output, and returns a typed score result.
 *
 * All calls use temperature=0 + response caching for determinism.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getLLMProvider } from '../llm';

const RUBRICS_DIR = join(__dirname, '..', 'rubrics');

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
      rawJson: { mock: true },
    };
  }

  const rubricContent = loadRubric(rubricId);
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

  const parsed = response.json as Record<string, unknown>;

  const score = clamp(Number(parsed.score ?? 0), 0, 100);
  const band = normalizeBand(String(parsed.band ?? ''));

  return {
    rubricId,
    score,
    band,
    evidence: String(parsed.evidence ?? ''),
    weaknesses: (parsed.weaknesses as string[]) ?? [],
    inarticulateGeniusFlag: parsed.inarticulate_genius_flag === true,
    tarPitFlag: parsed.tar_pit_flag === true,
    contradictionFlag: parsed.contradiction_flag === true,
    rawJson: parsed,
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
    rawJson: { auto_scored: true, reason },
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
