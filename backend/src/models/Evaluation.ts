import { Schema, model, Document, Types } from 'mongoose';

export type EvaluationBand = 'not_passed' | 'passed_with_gaps' | 'passed' | 'priority';

export interface AlgorithmTraceEntry {
  nodeId: string;
  signalKey: string;
  nodeName: string;
  category: string;
  rawScore: number;
  normalizedScore: number;
  categoryMultiplier: number;
  siblingWeight: number;
  weightedContribution: number;
  // Legacy fields (kept for backward compatibility)
  llmEvidence?: string;
  llmWeaknesses?: string[];
  // New strict audit fields (populated for llm_rubric signals)
  rawTextEvidence?: string | null;   // Exact quote from founder text used as evidence
  weakness?: string | null;          // Specific weakness the LLM identified
  confidence?: 'high' | 'medium' | 'low'; // LLM confidence in this score
  scoringMethod?: string;            // 'llm_rubric' | 'closed_mapping' | 'numeric_curve' | 'scrape_threshold' | 'derived_formula'
  zodValidated?: boolean;            // Whether LLM output passed strict Zod schema
  flags: string[];
  sourceType: string;
  sourceRef?: string;
}

export interface TrackScores {
  A: number;
  B: number;
  C: number;
  D: number;
}

export interface KnockoutTriggered {
  id: string;
  name: string;
  severity: string;
  ruleTrace: string;
}

export interface KnockoutsResult {
  anyTriggered: boolean;
  routeToHuman: boolean;
  evaluated: Array<{
    id: string;
    triggered: boolean;
    severity: string;
    ruleTrace: string;
  }>;
}

export interface GapReportItem {
  nodeId: string;
  name: string;
  category: string;
  reason: string;
  suggestedReviewerQuestion: string;
}

export interface Contradiction {
  signal: string;
  claimedValue: unknown;
  scrapedValue: unknown;
  severity: 'high' | 'medium' | 'low';
  description: string;
}

export interface ConsistencyCheck {
  checkName: string;
  passed: boolean;
  description: string;
}

export interface ReconciliationLogEntry {
  rule: string;
  applied: boolean;
  reason: string;
  multiplier?: number;
}

export interface GapReport {
  generatedAt: Date;
  profileVersion: number;
  overallBand: EvaluationBand;
  founderAnswers: Record<string, { questionText: string; answer: unknown; wordCount?: number }>;
  nodeEvaluations: AlgorithmTraceEntry[];
  contradictions: Contradiction[];
  consistencyChecks: ConsistencyCheck[];
  gaps: GapReportItem[];
  knockoutsResult: KnockoutsResult;
  reconciliationLog: ReconciliationLogEntry[];
}

export interface IEvaluation extends Document {
  applicationId: Types.ObjectId;
  profileVersionUsed: number;
  skillVersionUsed: string;
  signalsMap: Record<string, unknown>;
  knockoutsResult: KnockoutsResult;
  trackScores: TrackScores;
  compositeScore: number;
  band: EvaluationBand;
  gapReport: GapReport;
  algorithmTrace: AlgorithmTraceEntry[];
  reconciliationAdjustments: ReconciliationLogEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const EvaluationSchema = new Schema<IEvaluation>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true, index: true },
    profileVersionUsed: { type: Number, required: true },
    skillVersionUsed: { type: String, default: 'unknown' },
    signalsMap: { type: Schema.Types.Mixed, default: {} },
    knockoutsResult: { type: Schema.Types.Mixed, required: true },
    trackScores: {
      A: { type: Number, required: true },
      B: { type: Number, required: true },
      C: { type: Number, required: true },
      D: { type: Number, required: true },
    },
    compositeScore: { type: Number, required: true, min: 0, max: 100 },
    band: {
      type: String,
      enum: ['not_passed', 'passed_with_gaps', 'passed', 'priority'],
      required: true,
      index: true,
    },
    gapReport: { type: Schema.Types.Mixed, required: true },
    algorithmTrace: { type: Schema.Types.Mixed, default: [] },
    reconciliationAdjustments: { type: Schema.Types.Mixed, default: [] },
  },
  { timestamps: true },
);

export const Evaluation = model<IEvaluation>('Evaluation', EvaluationSchema);
