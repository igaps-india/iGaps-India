import { Schema, model, Document } from 'mongoose';

export type UserRole = 'admin' | 'reviewer';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  name: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'reviewer'], default: 'reviewer' },
    name: { type: String, required: true, trim: true },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

export const User = model<IUser>('User', UserSchema);
