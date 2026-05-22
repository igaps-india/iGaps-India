import { Schema, model, Document } from 'mongoose';

export interface CategoryMultipliers {
  required: number;
  must_have: number;
  good_to_have: number;
  not_required: number;
}

export interface CategoryShares {
  required: number;
  must_have: number;
  good_to_have: number;
  not_required: number;
}

export interface ReconciliationConfig {
  leverageMarketAmplifier: {
    enabled: boolean;
    thresholdTrackAL3: number;
    thresholdTrackBL3L4Avg: number;
    multiplier: number;
  };
  inarticulateGenius: {
    enabled: boolean;
    thresholdTrackABelow: number;
    thresholdTrackBAbove: number;
  };
  tarPit: {
    enabled: boolean;
    multiplier: number;
  };
}

export interface IBiasProfile extends Document {
  name: string;
  description?: string;
  isActive: boolean;
  threshold: number;
  categoryMultipliers: CategoryMultipliers;
  categoryShares: CategoryShares;
  reconciliation: ReconciliationConfig;
  version: number;
  yamlHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BiasProfileSchema = new Schema<IBiasProfile>(
  {
    name: { type: String, required: true, trim: true },
    description: String,
    isActive: { type: Boolean, default: false, index: true },
    threshold: { type: Number, default: 40, min: 0, max: 100 },
    categoryMultipliers: {
      required: { type: Number, default: 0.5 },
      must_have: { type: Number, default: 1.0 },
      good_to_have: { type: Number, default: 0.75 },
      not_required: { type: Number, default: 0 },
    },
    categoryShares: {
      required: { type: Number, default: 35 },
      must_have: { type: Number, default: 35 },
      good_to_have: { type: Number, default: 20 },
      not_required: { type: Number, default: 10 },
    },
    reconciliation: {
      leverageMarketAmplifier: {
        enabled: { type: Boolean, default: true },
        thresholdTrackAL3: { type: Number, default: 70 },
        thresholdTrackBL3L4Avg: { type: Number, default: 70 },
        multiplier: { type: Number, default: 1.1 },
      },
      inarticulateGenius: {
        enabled: { type: Boolean, default: true },
        thresholdTrackABelow: { type: Number, default: 50 },
        thresholdTrackBAbove: { type: Number, default: 75 },
      },
      tarPit: {
        enabled: { type: Boolean, default: true },
        multiplier: { type: Number, default: 0.75 },
      },
    },
    version: { type: Number, default: 1 },
    yamlHash: String,
  },
  { timestamps: true },
);

export const BiasProfile = model<IBiasProfile>('BiasProfile', BiasProfileSchema);
