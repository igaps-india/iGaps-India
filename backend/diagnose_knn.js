/**
 * diagnose_knn.js — check what signal keys are in SignalExample collection
 */
const mongoose = require('mongoose');
require('./node_modules/dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

async function main() {
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/igaps';
  await mongoose.connect(uri);
  console.log('Connected to MongoDB\n');

  // Inline schema to avoid TypeScript model issues
  const SignalExampleSchema = new mongoose.Schema({
    signalKey: String,
    rubricId: String,
    applicationId: String,
    answerText: String,
    embedding: [Number],
    embeddingModel: String,
    score: Number,
    scoreSource: String,
    reasoning: String,
  });
  const SignalExample = mongoose.models.SignalExample ||
    mongoose.model('SignalExample', SignalExampleSchema);

  const total = await SignalExample.countDocuments();
  console.log(`Total SignalExample documents: ${total}\n`);

  const keys = await SignalExample.aggregate([
    { $group: { _id: '$signalKey', count: { $sum: 1 }, avgScore: { $avg: '$score' } } },
    { $sort: { count: -1 } }
  ]);

  console.log('Signal keys in DB:');
  for (const k of keys) {
    console.log(`  "${k._id}" → ${k.count} examples, avg score ${(k.avgScore ?? 0).toFixed(0)}`);
  }

  const sample = await SignalExample.findOne().lean();
  if (sample) {
    console.log(`\nSample document:`);
    console.log(`  signalKey:        ${sample.signalKey}`);
    console.log(`  score:            ${sample.score}`);
    console.log(`  embedding length: ${(sample.embedding ?? []).length}`);
    console.log(`  answerText[:80]:  ${String(sample.answerText ?? '').slice(0, 80)}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
