/**
 * confirmAndBackfill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot script to:
 *   1. Mark ALL existing Evaluation documents as adminConfirmed = true
 *   2. Immediately run the SignalExample backfill (seeds the KNN corpus)
 *
 * WHY ONE SCRIPT:
 *   backfillSignalExamples.ts requires adminConfirmed === true.
 *   For the initial 12-company corpus, we trust these evaluations by definition.
 *   This script collapses the two-step process into one safe idempotent run.
 *
 * SAFE TO RE-RUN:
 *   - updateMany with $set is idempotent (already-confirmed evals stay confirmed)
 *   - persistSignalExample uses upsert on (applicationId, signalKey) — no duplicates
 *
 * PREREQUISITE:
 *   - Python microservice MUST be running (for /embed endpoint)
 *     Start it with: run_microservice_local.bat
 *   - At least one Evaluation document must exist in MongoDB
 *
 * USAGE:
 *   npx ts-node src/scripts/confirmAndBackfill.ts
 */

import { Evaluation } from '../models/Evaluation';
import { Submission } from '../models/Submission';
import { embedText } from '../services/embeddingClient';
import { persistSignalExample } from '../services/KNNRetriever';
import { getOpenAnswersPlain, resolveOpenAnswerText } from '../utils/openAnswers';

const LLM_RUBRIC_SCORING_METHOD = 'llm_rubric';

async function run(): Promise<void> {
  // ── Step 1: Confirm all evaluations ───────────────────────────────────────
  console.log('\n[Step 1] Marking all evaluations as admin-confirmed...');

  const allEvals = await Evaluation.find({}).lean();
  if (allEvals.length === 0) {
    console.error(
      '[Error] No evaluations found in MongoDB.\n' +
      '  You must run at least one company through the evaluation pipeline first.\n' +
      '  Once evaluations exist, re-run this script.',
    );
    process.exit(1);
  }

  const confirmResult = await Evaluation.updateMany(
    { adminConfirmed: { $ne: true } },
    { $set: { adminConfirmed: true } },
  );
  console.log(
    `[Step 1] Done. ` +
    `${confirmResult.modifiedCount} newly confirmed, ` +
    `${allEvals.length - confirmResult.modifiedCount} already confirmed. ` +
    `Total: ${allEvals.length} evaluations.`,
  );

  // ── Step 2: Backfill SignalExample corpus ──────────────────────────────────
  console.log('\n[Step 2] Seeding SignalExample corpus from confirmed evaluations...');
  console.log('         (Python microservice must be running on port 8000)\n');

  const confirmedEvaluations = await Evaluation.find({ adminConfirmed: true }).lean();

  let totalProcessed = 0;
  let totalSkipped   = 0;
  let totalErrors    = 0;

  for (const evaluation of confirmedEvaluations) {
    const applicationId = String(evaluation.applicationId);
    const trace = evaluation.algorithmTrace ?? [];

    const submission = await Submission.findOne({ applicationId: evaluation.applicationId }).lean();
    if (!submission) {
      console.warn(`  [Skip] No Submission for eval ${evaluation._id}`);
      continue;
    }

    const openAnswers = getOpenAnswersPlain(submission as never);

    for (const traceEntry of trace) {
      // Only KNN-ground llm_rubric signals — others are deterministic
      if (traceEntry.scoringMethod !== LLM_RUBRIC_SCORING_METHOD) {
        totalSkipped++;
        continue;
      }
      if (!traceEntry.signalKey) {
        totalSkipped++;
        continue;
      }

      const rubricId   = traceEntry.sourceRef ?? `rubric.${traceEntry.signalKey}`;
      const answerText = resolveOpenAnswerText(
        traceEntry.sourceRef ?? '',
        openAnswers,
        submission.openQPlan as never,
      );

      if (!answerText || answerText.trim().length < 10) {
        totalSkipped++;
        continue;
      }

      // Embed and persist
      try {
        const { embedding, model } = await embedText(answerText);

        await persistSignalExample({
          signalKey:      traceEntry.signalKey,
          rubricId,
          applicationId,
          answerText,
          embedding,
          embeddingModel: model,
          score:          traceEntry.normalizedScore,
          scoreSource:    'admin_confirmed',
          reasoning:      traceEntry.rawTextEvidence ?? traceEntry.llmEvidence ?? '',
        });

        totalProcessed++;
        process.stdout.write('.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  [EmbedError] ${traceEntry.signalKey}: ${msg}`);
        totalErrors++;
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════');
  console.log('  KNN Corpus Seeding Complete');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Evaluations confirmed : ${confirmedEvaluations.length}`);
  console.log(`  Signal examples seeded: ${totalProcessed}  ← these are now in MongoDB`);
  console.log(`  Signals skipped       : ${totalSkipped}  (non llm_rubric — expected)`);
  console.log(`  Embed errors          : ${totalErrors}`);
  console.log('──────────────────────────────────────────────────');

  if (totalErrors > 0) {
    console.warn('\n  ⚠  Some signals failed to embed.');
    console.warn('     Is the Python microservice running?');
    console.warn('     Start it with: run_microservice_local.bat\n');
  } else if (totalProcessed === 0) {
    console.warn('\n  ⚠  Zero signals seeded. Possible reasons:');
    console.warn('     - Evaluations exist but have no llm_rubric signal traces');
    console.warn('     - All answer texts were too short (< 10 chars)');
    console.warn('     - algorithmTrace array is empty on all Evaluation documents\n');
  } else {
    console.log('\n  ✅  KNN corpus is live. Next evaluations will use these as anchors.');
    console.log('  ✅  KNN_GROUNDING_ENABLED=true is already set in .env\n');
  }

  process.exit(0);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
import { connectDb, disconnectDb } from '../db';

connectDb()
  .then(() => run())
  .then(() => disconnectDb())
  .catch((err) => {
    console.error('[Fatal]', err);
    process.exit(1);
  });
