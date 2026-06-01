import { Router, Request, Response } from 'express';
import { Application } from '../models/Application';
import { Submission } from '../models/Submission';
import { Evaluation } from '../models/Evaluation';
import { generateMagicToken, hashToken } from '../utils/tokens';
import { sendMagicLink } from '../utils/email';
import { getQueue } from '../queue';
import { config } from '../config';
import { seedFutureScrapePlaceholders } from '../utils/scrapeStorage';

const router = Router();

// CIN regex: L12345AB1234ABC123456 or U variant — 21 chars
const CIN_REGEX = /^[LUu][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{2,4}[0-9]{6}$/;
const LINKEDIN_REGEX = /^https?:\/\/(www\.)?linkedin\.com\//i;

/**
 * POST /api/applications
 * Creates a new application from the minimal intake form.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { email, founderName, coFounders, startupName, linkedinUrl, websiteUrl, cinNumber, githubUrl } =
    req.body as {
      email: string;
      founderName: string;
      coFounders?: string[];
      startupName: string;
      linkedinUrl: string;
      websiteUrl: string;
      cinNumber: string;
      githubUrl?: string;
    };

  // ── Validation ──────────────────────────────────────────────────────────────
  const errors: string[] = [];

  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.push('A valid email address is required.');

  if (!founderName?.trim()) errors.push('Founder name is required.');
  if (!startupName?.trim()) errors.push('Startup name is required.');

  if (!linkedinUrl?.trim() || !LINKEDIN_REGEX.test(linkedinUrl))
    errors.push('A valid LinkedIn URL is required (must start with https://linkedin.com/).');

  if (!websiteUrl?.trim())
    errors.push('Startup website URL is required.');

  if (!cinNumber?.trim() || !CIN_REGEX.test(cinNumber.trim().toUpperCase()))
    errors.push(
      'A valid CIN number is required (format: L12345AB1234AB123456 — 21 characters).',
    );

  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }

  // ── Check for duplicate ────────────────────────────────────────────────────
  const existing = await Application.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    res.status(409).json({
      error:
        'An application with this email already exists. Check your inbox for your magic link.',
    });
    return;
  }

  // ── Create Application + Submission ────────────────────────────────────────
  const app = await Application.create({
    email: email.toLowerCase().trim(),
    founderName: founderName.trim(),
    coFounders: coFounders?.filter(c => c.trim().length > 0).map(c => c.trim()) || [],
    startupName: startupName.trim(),
    linkedinUrl: linkedinUrl.trim(),
    websiteUrl: websiteUrl.trim(),
    cinNumber: cinNumber.trim().toUpperCase(),
    githubUrl: githubUrl?.trim() || undefined,
    sectorTag: 'ai',
    status: 'intake',
  });

  await Submission.create({
    applicationId: app._id,
    closedAnswers: {},
    openAnswers: {},
    uploads: [],
    scrapedData: {},
  });

  // ── Generate magic link ────────────────────────────────────────────────────
  const { token, hash, expiry } = generateMagicToken();
  app.magicTokenHash = hash;
  app.magicTokenExpiry = expiry;
  await app.save();

  // ── Background scraping (runs while founder fills closed questions) ─────────
  const queue = getQueue();
  const appId = (app._id as { toString(): string }).toString();

  // Reserve direct_relation/ + background/ slots for future LinkedIn + pitch-deck scrapes
  seedFutureScrapePlaceholders(appId);

  // Step 1 (active): ZaubaCorp CIN scrape — no API key required
  await queue.enqueue('scrape:zauba', {
    applicationId: appId,
    cin: cinNumber.trim().toUpperCase(),
  });

  // Step 2 (future): LinkedIn microservice — enqueue when LINKEDIN_SCRAPER_URL is set
  // Step 3 (future): Pitch deck LLM parse — enqueue after uploads on closed-Q complete

  const continueUrl = `${config.frontendUrl}/q/closed?app=${appId}&token=${token}`;

  // Email is a resume backup — do not block the redirect if sending fails
  sendMagicLink({
    to: email.trim(),
    founderName: founderName.trim(),
    applicationId: appId,
    token,
  }).catch((err) => {
    console.error('[Applications] Magic link email failed (non-blocking):', err);
  });

  res.status(201).json({
    message: 'Application received. Continue to the questionnaire.',
    applicationId: appId,
    token,
    continueUrl,
  });
});

/**
 * GET /api/applications/verify
 * Verifies a magic link token and returns the application id + current status.
 */
router.get('/verify', async (req: Request, res: Response): Promise<void> => {
  const { app: appId, token } = req.query as { app: string; token: string };

  if (!appId || !token) {
    res.status(400).json({ error: 'Missing app or token parameter.' });
    return;
  }

  const tokenHash = hashToken(token);
  const application = await Application.findOne({
    _id: appId,
    magicTokenHash: tokenHash,
    magicTokenExpiry: { $gt: new Date() },
  });

  if (!application) {
    res.status(401).json({ error: 'Invalid or expired link. Please re-apply to get a new link.' });
    return;
  }

  res.json({
    applicationId: (application._id as { toString(): string }).toString(),
    status: application.status,
    founderName: application.founderName,
    startupName: application.startupName,
    sectorTag: application.sectorTag,
  });
});

/**
 * GET /api/applications/status
 * Polls for the evaluation result of an application by magic token.
 */
router.get('/status', async (req: Request, res: Response): Promise<void> => {
  const { app: appId, token } = req.query as { app: string; token: string };

  if (!appId || !token) {
    res.status(400).json({ error: 'Missing app or token parameter.' });
    return;
  }

  const tokenHash = hashToken(token);
  const application = await Application.findOne({
    _id: appId,
    magicTokenHash: tokenHash,
    magicTokenExpiry: { $gt: new Date() },
  });

  if (!application) {
    res.status(401).json({ error: 'Invalid or expired link.' });
    return;
  }

  if (application.status === 'passed' || application.status === 'rejected') {
    const evaluation = await Evaluation.findOne({ applicationId: application._id })
      .select('band compositeScore')
      .lean();

    res.json({
      status: application.status,
      band: evaluation?.band,
      compositeScore: evaluation?.compositeScore,
      startupName: application.startupName,
    });
    return;
  }

  res.json({
    status: application.status,
    startupName: application.startupName,
  });
});

export default router;
