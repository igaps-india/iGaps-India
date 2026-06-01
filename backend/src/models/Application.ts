import { Schema, model, Document, Types } from 'mongoose';

export type ApplicationStatus =
  | 'intake'
  | 'questionnaire_closed'
  | 'questionnaire_uploads'
  | 'questionnaire_open'
  | 'evaluating'
  | 'passed'
  | 'rejected'
  | 'archived';

export interface IApplication extends Document {
  email: string;
  founderName: string;
  coFounders?: string[];
  startupName: string;
  linkedinUrl: string;
  websiteUrl: string;
  cinNumber: string;
  githubUrl?: string;
  sectorTag: 'ai';
  status: ApplicationStatus;
  biasProfileId?: Types.ObjectId;
  magicTokenHash?: string;
  magicTokenExpiry?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApplicationSchema = new Schema<IApplication>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    founderName: { type: String, required: true, trim: true },
    coFounders: [{ type: String, trim: true }],
    startupName: { type: String, required: true, trim: true },
    linkedinUrl: { type: String, required: true, trim: true },
    websiteUrl: { type: String, required: true, trim: true },
    cinNumber: { type: String, required: true, trim: true },
    githubUrl: { type: String, trim: true },
    sectorTag: { type: String, enum: ['ai'], default: 'ai' },
    status: {
      type: String,
      enum: [
        'intake',
        'questionnaire_closed',
        'questionnaire_uploads',
        'questionnaire_open',
        'evaluating',
        'passed',
        'rejected',
        'archived',
      ],
      default: 'intake',
      index: true,
    },
    biasProfileId: { type: Schema.Types.ObjectId, ref: 'BiasProfile' },
    magicTokenHash: { type: String, index: true },
    magicTokenExpiry: { type: Date },
  },
  { timestamps: true },
);

export const Application = model<IApplication>('Application', ApplicationSchema);
