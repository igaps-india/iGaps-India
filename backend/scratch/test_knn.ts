import mongoose from 'mongoose';
import { embedText } from '../src/services/embeddingClient';
import { getKNNExamples } from '../src/services/KNNRetriever';

async function run() {
  await mongoose.connect('mongodb://localhost:27017/igaps');
  require('../src/models/SignalExample');
  const { embedding } = await embedText('We are a highly scaled b2b saas company with $2M ARR');
  
  const res = await getKNNExamples(embedding, 'openQ1_causality_coherence_score', { k: 10, similarityThreshold: 0.0 });
  
  console.log('Got results:', res.length);
  res.forEach(r => console.log(`Sim: ${r.similarity.toFixed(4)}, Score: ${r.score}`));
  
  process.exit(0);
}
run().catch(console.error);
