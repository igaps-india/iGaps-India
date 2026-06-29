/**
 * evaluateKNN.ts — Leave-One-Out Evaluation Harness
 * ─────────────────────────────────────────────────────────────────────────────
 * Measures how well KNN-grounded scoring would perform at different K values,
 * using leave-one-out cross-validation against the SignalExample corpus.
 *
 * HOW IT WORKS:
 *   For each (signalKey, K) pair:
 *   - Hold out one labeled example at a time.
 *   - Find its K nearest neighbors from the remaining pool.
 *   - Score the held-out answer against those neighbors via LLM.
 *   - Compare predicted score to ground-truth score.
 *   - Average the absolute error across all held-out runs.
 *
 * HOW TO READ THE OUTPUT:
 *   meanAbsoluteError   : average point-difference between predicted and true.
 *                         Lower is better. Compare across K=1, 2, 3.
 *   runsWithZeroNeighbors: how many held-out examples found NO qualifying neighbors
 *                          (similarity < threshold). High count = sparse corpus.
 *   totalRuns           : total examples in corpus for that signal.
 *
 * IMPORTANT — DO NOT ACT ON RESULTS YET IF CORPUS IS SMALL:
 *   When totalRuns < 15 per signal, error numbers are too noisy to be
 *   meaningful. Record them for the baseline but do NOT change K based on them.
 *   Re-run this script every time the corpus grows by ~10 new confirmed evals.
 *
 * USAGE:
 *   npx ts-node src/scripts/evaluateKNN.ts
 *   npx ts-node src/scripts/evaluateKNN.ts --signals openQ1_causality_coherence_score
 *
 * PREREQUISITE:
 *   - SignalExample collection must be seeded (run backfillSignalExamples.ts first)
 *   - Python microservice must NOT be needed here — embeddings already stored
 *   - LLM API key must be set (uses the live LLM for scoring, costs real tokens)
 */

import { config } from '../config';
import { SignalExample } from '../models/SignalExample';
import { cosineSimilarity } from '../services/KNNRetriever';
import { scoreWithRubric } from '../services/rubricScorer';
import type { KNNNeighbor } from '../services/KNNRetriever';


// ── Config ─────────────────────────────────────────────────────────────────────

const DEFAULT_SIGNALS_TO_TEST = [
  'openQ1_causality_coherence_score',
  'openQ2_non_obvious_insight_score',
  'openQ5_discovery_quality_score',
  'openQ6_need_gap_precision_score',
  'openQ7_switching_reason_score',
  'openQ8_hard_problem_score',
  'openQ9_pivot_quality_score',
  'openQ10_market_proof_score',
];

const K_VALUES = [1, 2, 3];
const SIMILARITY_THRESHOLD = 0.75;

// Minimum totalRuns before error numbers are statistically meaningful.
// Below this, report results but flag them as provisional.
const MIN_RUNS_FOR_MEANINGFUL_RESULTS = 15;

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvalResult {
  signalKey:              string;
  k:                      number;
  meanAbsoluteError:      number;    // NaN if no runs were scoreable
  runsWithZeroNeighbors:  number;
  scoredRuns:             number;
  totalRuns:              number;
  provisional:            boolean;   // true when corpus is too small to trust results
}

// ── Core evaluation ───────────────────────────────────────────────────────────

async function leaveOneOutEval(
  signalKey: string,
  kValues: number[],
): Promise<EvalResult[]> {
  const allExamples = await SignalExample.find({ signalKey }).lean();
  const results: EvalResult[] = [];

  if (allExamples.length === 0) {
    console.warn(`  [${signalKey}] No examples in corpus — skipping.`);
    return [];
  }

  console.log(`  [${signalKey}] ${allExamples.length} examples in corpus.`);

  for (const k of kValues) {
    let totalError        = 0;
    let zeroNeighborRuns  = 0;
    let scoredRuns        = 0;

    for (let i = 0; i < allExamples.length; i++) {
      const heldOut       = allExamples[i];
      // Leave-one-out: exclude self from the candidate pool
      const remainingPool = allExamples.filter((_, idx) => idx !== i);

      if (remainingPool.length === 0) {
        // Only one example in corpus — can never find a neighbor
        zeroNeighborRuns++;
        continue;
      }

      // Compute similarities against remaining pool (no DB needed — embeddings in memory)
      const neighbors: KNNNeighbor[] = remainingPool
        .map((c) => ({
          answerText: c.answerText,
          score:      c.score,
          reasoning:  c.reasoning,
          similarity: cosineSimilarity(heldOut.embedding, c.embedding),
        }))
        .filter((c) => c.similarity >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, k);

      if (neighbors.length === 0) {
        zeroNeighborRuns++;
        // Can't score without grounding — exclude from error calc
        continue;
      }

      // Score via LLM using KNN neighbors as grounding (burns real tokens)
      try {
        const result = await scoreWithRubric(
          heldOut.rubricId,
          heldOut.answerText,
          undefined,  // contextHint
          undefined,  // pitchDeckText
          undefined,  // submissionId
          neighbors,  // KNN grounding
        );

        const error = Math.abs(result.score - heldOut.score);
        totalError += error;
        scoredRuns++;

        if (process.env.VERBOSE_EVAL === 'true') {
          console.log(
            `    [k=${k}] held-out score=${heldOut.score}, predicted=${result.score}, ` +
            `error=${error.toFixed(1)}, neighbors=${neighbors.length}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`    [k=${k}] LLM scoring failed for held-out example: ${msg}`);
      }
    }

    results.push({
      signalKey,
      k,
      meanAbsoluteError:      scoredRuns > 0 ? totalError / scoredRuns : NaN,
      runsWithZeroNeighbors:  zeroNeighborRuns,
      scoredRuns,
      totalRuns:              allExamples.length,
      provisional:            allExamples.length < MIN_RUNS_FOR_MEANINGFUL_RESULTS,
    });
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Allow overriding signals via CLI: --signals openQ1_foo,openQ2_bar
  const signalsArg = process.argv.find((a) => a.startsWith('--signals='));
  const signalsToTest = signalsArg
    ? signalsArg.replace('--signals=', '').split(',').map((s) => s.trim())
    : DEFAULT_SIGNALS_TO_TEST;

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  KNN Leave-One-Out Evaluation Harness');
  console.log(`  Signals: ${signalsToTest.length}`);
  console.log(`  K values: ${K_VALUES.join(', ')}`);
  console.log(`  Similarity threshold: ${SIMILARITY_THRESHOLD}`);
  console.log(`  Provisional threshold: totalRuns < ${MIN_RUNS_FOR_MEANINGFUL_RESULTS}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  const allResults: EvalResult[] = [];

  for (const signalKey of signalsToTest) {
    console.log(`\nEvaluating signal: ${signalKey}`);
    const results = await leaveOneOutEval(signalKey, K_VALUES);
    allResults.push(...results);
  }

  // ── Summary table ────────────────────────────────────────────────────────

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Results Summary');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  console.table(
    allResults.map((r) => ({
      signalKey:             r.signalKey.slice(0, 35).padEnd(35),
      k:                     r.k,
      MAE:                   isNaN(r.meanAbsoluteError) ? 'N/A' : r.meanAbsoluteError.toFixed(2),
      zeroNeighbors:         r.runsWithZeroNeighbors,
      scoredRuns:            r.scoredRuns,
      totalRuns:             r.totalRuns,
      provisional:           r.provisional ? '⚠ YES' : 'no',
    })),
  );

  // ── Provisional warning ──────────────────────────────────────────────────

  const provisionalSignals = [...new Set(
    allResults.filter((r) => r.provisional).map((r) => r.signalKey),
  )];

  if (provisionalSignals.length > 0) {
    console.log('');
    console.log('⚠  PROVISIONAL RESULTS WARNING');
    console.log(`   The following signals have fewer than ${MIN_RUNS_FOR_MEANINGFUL_RESULTS} examples.`);
    console.log('   Error numbers are too noisy to be meaningful at this corpus size.');
    console.log('   Do NOT adjust K based on these numbers.');
    console.log('   Re-run this script after each batch of ~10 new admin-confirmed evaluations.');
    console.log('');
    provisionalSignals.forEach((s) => console.log(`   • ${s}`));
  }

  // ── Best K per signal ────────────────────────────────────────────────────

  const nonProvisional = allResults.filter((r) => !r.provisional && !isNaN(r.meanAbsoluteError));
  if (nonProvisional.length > 0) {
    console.log('');
    console.log('✓  RECOMMENDED K PER SIGNAL (non-provisional only):');
    const signalsWithResults = [...new Set(nonProvisional.map((r) => r.signalKey))];
    for (const sig of signalsWithResults) {
      const best = nonProvisional
        .filter((r) => r.signalKey === sig)
        .reduce((a, b) => a.meanAbsoluteError < b.meanAbsoluteError ? a : b);
      console.log(`   ${sig}: K=${best.k} (MAE=${best.meanAbsoluteError.toFixed(2)})`);
    }
  }

  console.log('');
}

// Connect and run
import { connectDb, disconnectDb } from '../db';

connectDb()
  .then(() => main())
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[EvalKNN] Fatal error:', err);
    process.exit(1);
  });

