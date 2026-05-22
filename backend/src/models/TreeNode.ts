import { Schema, model, Document, Types } from 'mongoose';

export type NodeKind = 'track' | 'layer' | 'signal';
export type NodeCategory = 'required' | 'must_have' | 'good_to_have' | 'not_required';
export type SourceType = 'closed_q' | 'open_q' | 'scraped' | 'upload_parse' | 'derived';
export type ScoringRuleType =
  | 'closed_mapping'
  | 'numeric_curve'
  | 'llm_rubric'
  | 'scrape_threshold'
  | 'derived_formula';

export interface ScoringRule {
  type: ScoringRuleType;
  rubric?: string;       // rubric template ID e.g. 'rubric.causality.v1'
  model?: string;        // LLM model override
  mapping?: Record<string, number>;  // for closed_mapping
  curve?: Record<string, number>;    // for numeric_curve: { "0": 0, "1": 50, "5": 100 }
  formula?: string;      // for derived_formula
  thresholds?: Record<string, number>; // for scrape_threshold
}

export interface ITreeNode extends Document {
  biasProfileId: Types.ObjectId;
  nodeId: string;          // stable dot-notation ID e.g. trackA.L1.causality_chain_coherence
  parentId?: string;       // parent nodeId
  kind: NodeKind;
  name: string;
  description?: string;
  category: NodeCategory;
  weight: number;          // % within parent; siblings sum to 100
  enabled: boolean;
  sourceType?: SourceType;
  sourceRef?: string;      // e.g. 'closedQ1', 'openQ3', 'scrape.linkedin'
  signalKey?: string;      // flat signalsMap key this node writes to
  scoringRule?: ScoringRule;
  flags: string[];         // e.g. ['tar_pit_check', 'inarticulate_genius_check']
  order: number;           // display/processing order among siblings
  yamlHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const ScoringRuleSchema = new Schema<ScoringRule>(
  {
    type: { type: String, required: true },
    rubric: String,
    model: String,
    mapping: { type: Schema.Types.Mixed },
    curve: { type: Schema.Types.Mixed },
    formula: String,
    thresholds: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const TreeNodeSchema = new Schema<ITreeNode>(
  {
    biasProfileId: { type: Schema.Types.ObjectId, ref: 'BiasProfile', required: true, index: true },
    nodeId: { type: String, required: true },
    parentId: String,
    kind: { type: String, enum: ['track', 'layer', 'signal'], required: true },
    name: { type: String, required: true },
    description: String,
    category: {
      type: String,
      enum: ['required', 'must_have', 'good_to_have', 'not_required'],
      required: true,
    },
    weight: { type: Number, required: true, min: 0, max: 100 },
    enabled: { type: Boolean, default: true },
    sourceType: {
      type: String,
      enum: ['closed_q', 'open_q', 'scraped', 'upload_parse', 'derived'],
    },
    sourceRef: String,
    signalKey: String,
    scoringRule: ScoringRuleSchema,
    flags: [String],
    order: { type: Number, default: 0 },
    yamlHash: { type: String, required: true },
  },
  { timestamps: true },
);

TreeNodeSchema.index({ biasProfileId: 1, nodeId: 1 }, { unique: true });

export const TreeNode = model<ITreeNode>('TreeNode', TreeNodeSchema);
