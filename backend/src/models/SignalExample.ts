/**
 * SignalExample.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Persists labeled founder answers at the signal level, forming the corpus
 * that powers KNN-grounded scoring.
 *
 * INDEXING DESIGN:
 *   All retrieval is scoped by signalKey first. A KNN search for
 *   "evidence_of_demand" must NEVER return neighbors from "team_strength" —
 *   they exist in different embedding spaces with different scoring semantics.
 *   The compound index (signalKey, createdAt DESC) supports both the
 *   getKNNExamples fetch (filter by signalKey) and any future
 *   time-ordered pruning.
 *
 * SEEDING GATE:
 *   scoreSource must be "admin_confirmed" or "high_confidence_auto".
 *   Raw unreviewed LLM scores must never be seeded here — that would
 *   propagate unverified labels silently into every future score.
 *
 * EMBEDDING MODEL TRACKING:
 *   embeddingModel records which sentence-transformer produced the vector.
 *   If the model is ever upgraded, all existing vectors must be recomputed
 *   before KNN retrieval will remain meaningful.
 */

import { Schema, model, Document } from 'mongoose';

export interface ISignalExample extends Document {
  signalKey: string;          // e.g. "openQ1_causality_coherence_score" — tree node key
  rubricId: string;           // e.g. "rubric.causality.v1" — for audit traceability
  applicationId: string;      // source application ObjectId as string
  answerText: string;         // the raw founder answer text (stored verbatim)
  embedding: number[];        // vector embedding of answerText
  embeddingModel: string;     // e.g. "sentence-transformers/all-MiniLM-L6-v2"
  score: number;              // 0–100 confirmed ground-truth score
  scoreSource: 'admin_confirmed' | 'high_confidence_auto';
  reasoning: string;          // LLM reasoning string at time of scoring (audit trail)
  createdAt: Date;
}

const SignalExampleSchema = new Schema<ISignalExample>({
  signalKey:      { type: String, required: true, index: true },
  rubricId:       { type: String, required: true },
  applicationId:  { type: String, required: true },
  answerText:     { type: String, required: true },
  // Store as flat array — brute-force cosine in Node.js is fast enough at
  // current corpus size (<300 examples per signal). Swap for Atlas Vector Search
  // or Pinecone later without touching call sites — just swap KNNRetriever internals.
  embedding:      { type: [Number], required: true },
  embeddingModel: { type: String, required: true },
  score:          { type: Number, required: true, min: 0, max: 100 },
  scoreSource:    {
    type: String,
    required: true,
    enum: ['admin_confirmed', 'high_confidence_auto'],
  },
  reasoning:      { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
});

// Compound index: every getKNNExamples call filters by signalKey first,
// then we sort by similarity in process. The secondary sort key is createdAt
// for any future time-ordered pruning (oldest examples first to drop).
SignalExampleSchema.index({ signalKey: 1, createdAt: -1 });

// Prevent duplicate seeding: one entry per (applicationId, signalKey) pair.
// If admin re-confirms, update in place rather than inserting a duplicate.
SignalExampleSchema.index({ applicationId: 1, signalKey: 1 }, { unique: true });

export const SignalExample = model<ISignalExample>('SignalExample', SignalExampleSchema);
