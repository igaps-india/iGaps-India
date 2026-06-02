import { Schema, model, Document, Types } from 'mongoose';

export interface OpenQSlot {
  slotId: number;
  source: 'original' | 'merged' | 'generated';
  sourceIds: string[];
  text: string;
  targetSignals: string[];
  rationale: string;
}

export interface OpenQPlan {
  slots: OpenQSlot[];
  skillVersion: string;
  llmProvider: string;
  llmModel: string;
  generatedAt: Date;
  degraded: boolean; // true if fallback to original 10 was used
}

export interface Upload {
  type: 'pitch_deck' | 'standout_doc';
  r2Key: string;
  originalName: string;
  mimeType: string;
  parsedText?: string;
  parsedAt?: Date;
  parseStatus: 'pending' | 'success' | 'failed';
}

export interface ScrapedData {
  linkedin?: Record<string, unknown> | { status: string; [key: string]: unknown };
  github?: Record<string, unknown> | { status: string; [key: string]: unknown };
  zauba?: Record<string, unknown> | { status: string; [key: string]: unknown };
  press?: Record<string, unknown> | { status: string; [key: string]: unknown };
  patents?: Record<string, unknown> | { status: string; [key: string]: unknown };
  /** License signals fetched alongside patents via the Google CSE pipeline. */
  licenses?: Record<string, unknown> | { status: string; [key: string]: unknown };
}

export interface ISubmission extends Document {
  applicationId: Types.ObjectId;
  closedAnswers: Record<string, unknown>;
  openAnswers: Record<string, string>;
  uploads: Upload[];
  scrapedData: ScrapedData;
  openQPlan?: OpenQPlan;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UploadSchema = new Schema<Upload>(
  {
    type: { type: String, enum: ['pitch_deck', 'standout_doc'], required: true },
    r2Key: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    parsedText: String,
    parsedAt: Date,
    parseStatus: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
    },
  },
  { _id: false },
);

const OpenQSlotSchema = new Schema<OpenQSlot>(
  {
    slotId: { type: Number, required: true },
    source: { type: String, enum: ['original', 'merged', 'generated'], required: true },
    sourceIds: [String],
    text: { type: String, required: true },
    targetSignals: [String],
    rationale: String,
  },
  { _id: false },
);

const SubmissionSchema = new Schema<ISubmission>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true, index: true },
    closedAnswers: { type: Schema.Types.Mixed, default: {} },
    openAnswers: { type: Schema.Types.Mixed, default: {} },
    uploads: [UploadSchema],
    scrapedData: { type: Schema.Types.Mixed, default: {} },
    openQPlan: {
      slots: [OpenQSlotSchema],
      skillVersion: String,
      llmProvider: String,
      llmModel: String,
      generatedAt: Date,
      degraded: Boolean,
    },
    completedAt: Date,
  },
  { timestamps: true },
);

export const Submission = model<ISubmission>('Submission', SubmissionSchema);
