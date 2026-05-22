/**
 * Print raw submission answers for an application (uses backend MONGODB_URI).
 *
 * Usage:
 *   npx tsx tools/dump-submission.ts
 *   npx tsx tools/dump-submission.ts 6a10acbd51b977eb01827fd9
 */
import { connectDb, disconnectDb } from '../src/db';
import { Application } from '../src/models/Application';
import { Submission } from '../src/models/Submission';
import { Evaluation } from '../src/models/Evaluation';
import mongoose from 'mongoose';

async function main() {
  const appIdArg = process.argv[2];

  await connectDb();
  console.log(`Connected: ${mongoose.connection.host} / db: ${mongoose.connection.name}`);

  const application = appIdArg
    ? await Application.findById(appIdArg)
    : await Application.findOne().sort({ createdAt: -1 });

  if (!application) {
    console.error('No application found.');
    process.exit(1);
  }

  const submission = await Submission.findOne({ applicationId: application._id });
  const evaluation = await Evaluation.findOne({ applicationId: application._id });

  console.log('\n=== Application ===');
  console.log(JSON.stringify({
    id: application._id.toString(),
    startupName: application.startupName,
    email: application.email,
    status: application.status,
  }, null, 2));

  if (!submission) {
    console.error('\nNo submission document found for this application.');
    process.exit(1);
  }

  console.log('\n=== Closed answers ===');
  console.log(JSON.stringify(submission.closedAnswers, null, 2));

  console.log('\n=== Open answers (keys + word counts) ===');
  const open = submission.openAnswers as Record<string, string>;
  for (const [key, text] of Object.entries(open)) {
    const words = String(text).split(/\s+/).filter(Boolean).length;
    console.log(`  ${key}: ${words} words, ${String(text).length} chars`);
  }

  console.log('\n=== Open answers (full text) ===');
  console.log(JSON.stringify(open, null, 2));

  console.log('\n=== Uploads ===');
  console.log(JSON.stringify(submission.uploads, null, 2));

  if (evaluation) {
    console.log('\n=== Evaluation ===');
    console.log(JSON.stringify({
      band: evaluation.band,
      compositeScore: evaluation.compositeScore,
      trackScores: evaluation.trackScores,
    }, null, 2));
  }

  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
