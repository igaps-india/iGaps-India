/**
 * test_knn_live.js — test embedding + KNN similarity for a sample answer
 */
const mongoose = require('mongoose');
require('./node_modules/dotenv').config();
const dns = require('dns');
const axios = require('axios');

dns.setDefaultResultOrder('ipv4first');

function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main() {
  // 1. Test embedding service
  console.log('--- Step 1: Testing embedding service ---');
  let testEmbedding = null;
  try {
    const res = await axios.post('http://127.0.0.1:8000/embed', {
      text: 'We pivoted 3 times before finding PMF with blockchain credentials.'
    }, { timeout: 8000 });
    testEmbedding = res.data.embedding;
    console.log(`✅ Embedding service: OK — vector length=${testEmbedding.length}`);
  } catch (e) {
    console.error(`❌ Embedding service ERROR: ${e.message}`);
    process.exit(1);
  }

  // 2. Connect to MongoDB
  console.log('\n--- Step 2: Connecting to MongoDB ---');
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/igaps';
  await mongoose.connect(uri);
  console.log('✅ Connected');

  const SignalExampleSchema = new mongoose.Schema({
    signalKey: String,
    answerText: String,
    embedding: [Number],
    score: Number,
    reasoning: String,
  });
  const SignalExample = mongoose.models.SignalExample ||
    mongoose.model('SignalExample', SignalExampleSchema);

  // 3. Test KNN retrieval for 'openQ9_pivot_quality_score'
  console.log('\n--- Step 3: Testing KNN for openQ9_pivot_quality_score ---');
  const candidates = await SignalExample.find({ signalKey: 'openQ9_pivot_quality_score' }).lean();
  console.log(`Found ${candidates.length} candidates in DB`);

  const scored = candidates.map(c => ({
    answerText: String(c.answerText ?? '').slice(0, 60),
    score: c.score,
    embLen: (c.embedding ?? []).length,
    similarity: cosineSimilarity(testEmbedding, c.embedding ?? []),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  console.log('\nTop similarities:');
  for (const s of scored) {
    const flag = s.similarity >= 0.55 ? '✅ QUALIFIES' : '❌ below 0.55';
    console.log(`  sim=${s.similarity.toFixed(4)} score=${s.score} embLen=${s.embLen} ${flag}`);
    console.log(`  text: ${s.answerText}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
