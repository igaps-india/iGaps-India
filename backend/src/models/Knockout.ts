import { Schema, model, Document } from 'mongoose';

export type KnockoutSeverity = 'hard_stop' | 'route_to_human' | 'warn_only';

// Rule DSL — mirrors the YAML structure
export interface KnockoutPredicate {
  signal: string;
  op: 'equals' | 'not_equals' | 'less_than' | 'greater_than' | 'in' | 'not_in' | 'contains' | 'exists' | 'missing';
  value?: unknown;
}

export type KnockoutRule =
  | { any: KnockoutRule[] }
  | { all: KnockoutRule[] }
  | { not: KnockoutRule }
  | KnockoutPredicate;

export interface IKnockout extends Document {
  knockoutId: string;  // stable ID e.g. 'K1', 'K2'
  name: string;
  enabled: boolean;
  severity: KnockoutSeverity;
  notes?: string;
  rule: KnockoutRule;
  yamlHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const KnockoutSchema = new Schema<IKnockout>(
  {
    knockoutId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    severity: {
      type: String,
      enum: ['hard_stop', 'route_to_human', 'warn_only'],
      default: 'hard_stop',
    },
    notes: String,
    rule: { type: Schema.Types.Mixed, required: true },
    yamlHash: { type: String, required: true },
  },
  { timestamps: true },
);

export const Knockout = model<IKnockout>('Knockout', KnockoutSchema);
