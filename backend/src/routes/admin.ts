import { Router, Request, Response } from 'express';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { Application } from '../models/Application';
import { Evaluation } from '../models/Evaluation';
import { Submission } from '../models/Submission';
import { Knockout } from '../models/Knockout';
import { AuditLog } from '../models/AuditLog';
import { User } from '../models/User';
import { BiasProfile } from '../models/BiasProfile';
import { TreeNode } from '../models/TreeNode';
import { buildAdminReview } from '../utils/adminReview';
import { signJwt } from '../utils/tokens';
import bcrypt from 'bcryptjs';

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

/** POST /api/admin/login */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  user.lastLoginAt = new Date();
  await user.save();

  await AuditLog.create({
    actor: user.email,
    actorId: user._id,
    action: 'admin_login',
    target: `users/${user._id}`,
    at: new Date(),
  });

  const token = signJwt({
    userId: (user._id as { toString(): string }).toString(),
    email: user.email,
    role: user.role,
  });

  res.json({ token, role: user.role, name: user.name });
});

// ── Applications list ─────────────────────────────────────────────────────────

/** GET /api/admin/applications */
router.get('/applications', requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  const apps = await Application.find()
    .sort({ createdAt: -1 })
    .select('email founderName startupName status sectorTag createdAt')
    .lean();

  res.json({ applications: apps, total: apps.length });
});

// ── Application detail ────────────────────────────────────────────────────────

/** GET /api/admin/applications/:id */
router.get('/applications/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const application = await Application.findById(req.params.id).lean();
  if (!application) {
    res.status(404).json({ error: 'Application not found.' });
    return;
  }

  const evaluation = await Evaluation.findOne({ applicationId: req.params.id })
    .sort({ generatedAt: -1 })
    .lean();
  const submission = await Submission.findOne({ applicationId: req.params.id })
    .select('closedAnswers openAnswers uploads openQPlan scrapedData completedAt')
    .lean();

  let review = null;
  if (submission) {
    const profile = await BiasProfile.findOne({ isActive: true });
    const treeNodes = profile
      ? await TreeNode.find({ biasProfileId: profile._id, enabled: true })
          .select('nodeId signalKey sourceRef')
          .lean()
      : [];
    review = buildAdminReview(
      submission,
      evaluation as import('../models/Evaluation').IEvaluation | null,
      treeNodes as Array<{ nodeId: string; signalKey?: string; sourceRef?: string }>,
    );
  }

  res.json({
    application,
    evaluation: evaluation ?? null,
    submission: submission ?? null,
    review,
  });
});

// ── Knockouts ─────────────────────────────────────────────────────────────────

/** GET /api/admin/knockouts */
router.get('/knockouts', requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  const knockouts = await Knockout.find().sort({ knockoutId: 1 }).lean();
  res.json({ knockouts });
});

/** PATCH /api/admin/knockouts/:id */
router.patch('/knockouts/:id', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { enabled, severity, notes } = req.body as {
    enabled?: boolean;
    severity?: string;
    notes?: string;
  };

  const knockout = await Knockout.findOne({ knockoutId: req.params.id });
  if (!knockout) {
    res.status(404).json({ error: 'Knockout not found.' });
    return;
  }

  const before = { enabled: knockout.enabled, severity: knockout.severity, notes: knockout.notes };

  if (enabled !== undefined) knockout.enabled = enabled;
  if (severity !== undefined) {
    if (!['hard_stop', 'route_to_human', 'warn_only'].includes(severity)) {
      res.status(400).json({ error: 'Invalid severity value.' });
      return;
    }
    knockout.severity = severity as typeof knockout.severity;
  }
  if (notes !== undefined) knockout.notes = notes;

  await knockout.save();

  await AuditLog.create({
    actor: req.user?.email ?? 'unknown',
    actorId: req.user?.userId ? (req.user.userId as unknown as import('mongoose').Types.ObjectId) : undefined,
    action: 'knockout_update',
    target: `knockouts/${knockout.knockoutId}`,
    before,
    after: { enabled: knockout.enabled, severity: knockout.severity, notes: knockout.notes },
    at: new Date(),
  });

  res.json({ knockout });
});

// ── Audit log ─────────────────────────────────────────────────────────────────

/** GET /api/admin/audit */
router.get('/audit', requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  const logs = await AuditLog.find().sort({ at: -1 }).limit(100).lean();
  res.json({ logs });
});

export default router;
