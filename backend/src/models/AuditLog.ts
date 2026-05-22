import { Schema, model, Document, Types } from 'mongoose';

export type AuditAction =
  | 'yaml_reseed'
  | 'knockout_update'
  | 'bias_profile_update'
  | 'application_status_change'
  | 'admin_login'
  | 'evaluation_created';

export interface IAuditLog extends Document {
  actor: string;         // user email or 'system'
  actorId?: Types.ObjectId;
  action: AuditAction;
  target: string;        // collection + id e.g. 'knockouts/K1'
  before?: unknown;
  after?: unknown;
  at: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId },
    action: {
      type: String,
      enum: [
        'yaml_reseed',
        'knockout_update',
        'bias_profile_update',
        'application_status_change',
        'admin_login',
        'evaluation_created',
      ],
      required: true,
      index: true,
    },
    target: { type: String, required: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

export const AuditLog = model<IAuditLog>('AuditLog', AuditLogSchema);
