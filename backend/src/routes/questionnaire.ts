import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { Application } from '../models/Application';
import { Submission } from '../models/Submission';
import { hashToken } from '../utils/tokens';
import { getQueue } from '../queue';
import { CLOSED_QUESTIONS } from '../utils/closedQuestions';
import { planOpenQuestions } from '../services/questionAgent';
import { isLLMConfigured } from '../llm';
import { mergeOpenAnswers } from '../utils/openAnswers';
import {
  extractUploadText,
  isAllowedUpload,
  saveUploadFile,
} from '../utils/uploadStorage';

const router = Router();

// ── File upload ────────────────────────────────────────────────────────────────
// MVP: store locally; swap R2 upload path later
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter(_req, file, cb) {
    cb(null, isAllowedUpload(file.mimetype, file.originalname));
  },
});

function handleMulterUpload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  upload.array('files', 5)(req, res, (err: unknown) => {
    if (err) {
      const msg =
        err instanceof multer.MulterError
          ? err.code === 'LIMIT_FILE_SIZE'
            ? 'File exceeds the 50 MB limit.'
            : err.message
          : err instanceof Error
            ? err.message
            : 'Upload failed.';
      res.status(400).json({ error: msg });
      return;
    }
    next();
  });
}

/** Shared auth helper — validates magic token from query params */
async function resolveApplication(appId: string, token: string) {
  if (!appId || !token) return null;
  const tokenHash = hashToken(token);
  return Application.findOne({
    _id: appId,
    magicTokenHash: tokenHash,
    magicTokenExpiry: { $gt: new Date() },
  });
}

// ── GET /api/questionnaire/closed ─────────────────────────────────────────────
router.get('/closed', async (req: Request, res: Response): Promise<void> => {
  const { app: appId, token } = req.query as { app: string; token: string };

  const application = await resolveApplication(appId, token);
  if (!application) {
    res.status(401).json({ error: 'Invalid or expired link.' });
    return;
  }

  const submission = await Submission.findOne({ applicationId: application._id });
  if (!submission) {
    res.status(404).json({ error: 'Submission not found.' });
    return;
  }

  res.json({
    questions: CLOSED_QUESTIONS,
    savedAnswers: submission.closedAnswers,
    status: application.status,
  });
});

// ── POST /api/questionnaire/closed ────────────────────────────────────────────
router.post('/closed', async (req: Request, res: Response): Promise<void> => {
  const { app: appId, token } = req.query as { app: string; token: string };
  const { answers } = req.body as { answers: Record<string, unknown> };

  const application = await resolveApplication(appId, token);
  if (!application) {
    res.status(401).json({ error: 'Invalid or expired link.' });
    return;
  }

  const submission = await Submission.findOne({ applicationId: application._id });
  if (!submission) {
    res.status(404).json({ error: 'Submission not found.' });
    return;
  }

  // Merge saved answers (allow partial saves for resume)
  submission.closedAnswers = { ...submission.closedAnswers, ...answers };
  await submission.save();

  application.status = 'questionnaire_closed';
  await application.save();

  res.json({ saved: true });
});

// ── POST /api/questionnaire/uploads ───────────────────────────────────────────
router.post(
  '/uploads',
  handleMulterUpload,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { app: appId, token } = req.query as { app: string; token: string };

      const application = await resolveApplication(appId, token);
      if (!application) {
        res.status(401).json({ error: 'Invalid or expired link.' });
        return;
      }

      const submission = await Submission.findOne({ applicationId: application._id });
      if (!submission) {
        res.status(404).json({ error: 'Submission not found.' });
        return;
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({
          error: 'No files received. Please upload a PDF or PowerPoint file (.pdf, .ppt, .pptx).',
        });
        return;
      }

      for (const file of files) {
        const isPitchDeck =
          file.originalname.toLowerCase().includes('pitch') ||
          file.originalname.toLowerCase().includes('deck') ||
          submission.uploads.length === 0;

        const r2Key = `uploads/${(application._id as { toString(): string }).toString()}/${Date.now()}_${file.originalname}`;

        saveUploadFile(r2Key, file.buffer);

        const { parsedText, parseStatus } = await extractUploadText(
          file.buffer,
          file.mimetype,
          file.originalname,
        );

        submission.uploads.push({
          type: isPitchDeck ? 'pitch_deck' : 'standout_doc',
          r2Key,
          originalName: file.originalname,
          mimeType: file.mimetype,
          parsedText,
          parsedAt: parsedText ? new Date() : undefined,
          parseStatus,
        });
      }

      await submission.save();

      application.status = 'questionnaire_uploads';
      await application.save();

      getQueue().enqueue('plan:open-questions', { applicationId: appId });

      res.json({
        uploaded: files.length,
        message: 'Files received. Your personalised questions are being prepared.',
      });
    } catch (err) {
      console.error('[uploads] Failed:', err);
      res.status(500).json({ error: 'Failed to save uploaded files. Please try again.' });
    }
  },
);

// ── GET /api/questionnaire/open-plan ──────────────────────────────────────────
router.get('/open-plan', async (req: Request, res: Response): Promise<void> => {
  const { app: appId, token } = req.query as { app: string; token: string };

  const application = await resolveApplication(appId, token);
  if (!application) {
    res.status(401).json({ error: 'Invalid or expired link.' });
    return;
  }

  const submission = await Submission.findOne({ applicationId: application._id });
  if (!submission) {
    res.status(404).json({ error: 'Submission not found.' });
    return;
  }

  const planReady = Boolean(submission.openQPlan?.slots?.length);
  const needsRegeneration =
    planReady && submission.openQPlan!.degraded && isLLMConfigured();

  if (!planReady || needsRegeneration) {
    const pastUploads = ['questionnaire_uploads', 'questionnaire_open', 'evaluating', 'passed', 'rejected'].includes(
      application.status,
    );
    if (pastUploads || needsRegeneration) {
      try {
        await planOpenQuestions(appId, { force: needsRegeneration });
        const refreshed = await Submission.findOne({ applicationId: application._id });
        if (refreshed?.openQPlan?.slots?.length) {
          res.json({
            ready: true,
            slots: refreshed.openQPlan.slots,
            degraded: refreshed.openQPlan.degraded,
          });
          return;
        }
      } catch (err) {
        console.error('[open-plan] Sync plan generation failed:', err);
      }
    }

    if (!planReady) {
      res.status(202).json({
        ready: false,
        message: 'Your personalised questions are still being prepared. Please check again shortly.',
      });
      return;
    }
  }

  res.json({
    ready: true,
    slots: submission.openQPlan!.slots,
    degraded: submission.openQPlan!.degraded,
  });
});

// ── POST /api/questionnaire/open ──────────────────────────────────────────────
router.post('/open', async (req: Request, res: Response): Promise<void> => {
  try {
    const { app: appId, token } = req.query as { app: string; token: string };
    const { answers } = req.body as { answers: Record<string, string> };

    const application = await resolveApplication(appId, token);
    if (!application) {
      res.status(401).json({ error: 'Invalid or expired link.' });
      return;
    }

    const submission = await Submission.findOne({ applicationId: application._id });
    if (!submission) {
      res.status(404).json({ error: 'Submission not found.' });
      return;
    }

    if (!submission.openQPlan?.slots?.length) {
      res.status(400).json({ error: 'Question plan not yet ready. Cannot save open answers.' });
      return;
    }

    mergeOpenAnswers(submission, answers ?? {});
    submission.completedAt = new Date();
    await submission.save();

    application.status = 'questionnaire_open';
    await application.save();

    getQueue().enqueue('evaluate:application', { applicationId: appId }).catch((e) =>
      console.error('[Q] Failed to enqueue evaluation:', e),
    );

    res.json({ saved: true });
  } catch (err) {
    console.error('[open] Failed to save answers:', err);
    res.status(500).json({ error: 'Failed to save your answers. Please try again.' });
  }
});

export default router;
