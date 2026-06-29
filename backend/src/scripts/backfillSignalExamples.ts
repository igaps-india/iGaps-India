/**
 * backfillSignalExamples.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot backfill script: seeds SignalExample from existing admin-confirmed
 * evaluations so the KNN retriever has a corpus to work with from day one.
 *
 * GATE: only processes evaluations where adminConfirmed === true.
 * Raw LLM-only scores are NEVER backfilled — that would seed the KNN pool
 * with unverified labels and every future score built on them inherits that
 * uncertainty silently.
 *
 * IDEMPOTENT: uses upsert on (applicationId, signalKey) unique index.
 * Safe to re-run after additional admin confirmations — no duplicates created,
 * existing entries updated with latest confirmed score and reasoning.
 *
 * USAGE:
 *   npx ts-node src/scripts/backfillSignalExamples.ts
 *
 * PREREQUISITE:
 *   - Python microservice must be running (for /embed endpoint)
 *   - At least one Evaluation document must have adminConfirmed: true
 *
 * To mark evaluations as confirmed (run in mongosh):
 *   db.evaluations.updateOne({ _id: ObjectId("...") }, { $set: { adminConfirmed: true } })
 */

import { Evaluation } from '../models/Evaluation';
import { Submission } from '../models/Submission';
import { embedText } from '../services/embeddingClient';
import { persistSignalExample } from '../services/KNNRetriever';

// Signals scored by LLM rubric and eligible for backfill.
// closed_mapping / numeric_curve / vector_similarity / scrape_threshold
// are deterministic — KNN grounding only applies to llm_rubric signals.
const LLM_RUBRIC_SCORING_METHOD = 'llm_rubric';

// Map from rubricId to the signalKey used in algorithmTrace.
// Derived from the trace itself — no hardcoding needed.

async function backfill(): Promise<void> {
  console.log('[Backfill] Starting SignalExample backfill from admin-confirmed evaluations...');

  const confirmedEvaluations = await Evaluation.find({ adminConfirmed: true }).lean();

  if (confirmedEvaluations.length === 0) {
    console.warn(
      '[Backfill] No admin-confirmed evaluations found.\n' +
      '  Mark evaluations in MongoDB:\n' +
      '  db.evaluations.updateOne({ _id: ObjectId("...") }, { $set: { adminConfirmed: true } })\n' +
      '  Then re-run this script.',
    );
    process.exit(0);
  }

  console.log(`[Backfill] Found ${confirmedEvaluations.length} confirmed evaluation(s).`);

  let totalSignalsProcessed = 0;
  let totalSignalsSkipped   = 0;
  let totalEmbedErrors      = 0;

  for (const evaluation of confirmedEvaluations) {
    const applicationId = String(evaluation.applicationId);
    const trace = evaluation.algorithmTrace ?? [];

    // Load the linked submission to resolve raw answer text.
    const submission = await Submission.findOne({ applicationId: evaluation.applicationId }).lean();
    if (!submission) {
      console.warn(`[Backfill] No Submission found for evaluation ${evaluation._id} — skipping.`);
      continue;
    }

    for (const traceEntry of trace) {
      // Only backfill llm_rubric signals
      if (traceEntry.scoringMethod !== LLM_RUBRIC_SCORING_METHOD) {
        totalSignalsSkipped++;
        continue;
      }
      if (!traceEntry.signalKey) {
        totalSignalsSkipped++;
        continue;
      }

      // Resolve the rubricId from the trace entry's sourceRef or from the signalKey.
      // The algorithmTrace stores sourceRef which contains the rubricId for llm_rubric signals.
      const rubricId = traceEntry.sourceRef ?? `rubric.${traceEntry.signalKey}`;

      // Resolve the answer text. For llm_rubric, this came from openAnswers.
      // The trace doesn't store the raw answer — we need to re-resolve from the submission.
      const { resolveOpenAnswerText, getOpenAnswersPlain } = await import('../utils/openAnswers');
      const openAnswers = getOpenAnswersPlain(submission as any);
      const answerText  = resolveOpenAnswerText(
        traceEntry.sourceRef ?? '',
        openAnswers,
        submission.openQPlan as any,
      );

      if (!answerText || answerText.trim().length < 10) {
        console.warn(`[Backfill] Empty answer for ${traceEntry.signalKey} in eval ${evaluation._id} — skipping.`);
        totalSignalsSkipped++;
        continue;
      }

      // Embed the answer text
      let embedding: number[];
      let embeddingModel: string;
      try {
        const embedResult = await embedText(answerText);
        embedding      = embedResult.embedding;
        embeddingModel = embedResult.model;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Backfill] Embed failed for ${traceEntry.signalKey}: ${msg}`);
        totalEmbedErrors++;
        continue;
      }

      // Persist (upsert — idempotent)
      await persistSignalExample({
        signalKey:      traceEntry.signalKey,
        rubricId,
        applicationId,
        answerText,
        embedding,
        embeddingModel,
        score:          traceEntry.normalizedScore,
        scoreSource:    'admin_confirmed',
        reasoning:      traceEntry.rawTextEvidence ?? traceEntry.llmEvidence ?? '',
      });

      totalSignalsProcessed++;
      process.stdout.write('.');  // progress indicator
    }
  }

  console.log('\n');
  console.log('─────────────────────────────────────────────');
  console.log(`[Backfill] Complete.`);
  console.log(`  Evaluations processed : ${confirmedEvaluations.length}`);
  console.log(`  Signal examples seeded: ${totalSignalsProcessed}`);
  console.log(`  Signals skipped       : ${totalSignalsSkipped} (non-llm_rubric)`);
  console.log(`  Embed errors          : ${totalEmbedErrors}`);
  console.log('─────────────────────────────────────────────');

  if (totalEmbedErrors > 0) {
    console.warn('[Backfill] Some signals failed to embed. Is the Python microservice running?');
    console.warn('  Start it with: run_microservice_local.bat');
  }

  process.exit(0);
}

// Connect to DB and run
import { connectDb, disconnectDb } from '../db';

connectDb()
  .then(() => backfill())
  .then(() => disconnectDb())
  .catch((err) => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  });
