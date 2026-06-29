// ── Windows IPv4 fix ──────────────────────────────────────────────────────────
// Node.js on Windows resolves DNS to IPv6 by default, which causes fetch()
// calls to external APIs (Gemini) to fail with "fetch failed". Force IPv4.
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import express from 'express';

import cors from 'cors';
import { config } from './config';
import { connectDb } from './db';
import { runSeed } from './seed/loader';

import applicationRoutes from './routes/applications';
import questionnaireRoutes from './routes/questionnaire';
import adminRoutes from './routes/admin';
import { registerScrapers } from './workers/scrapers';
import { questionAgentHandler } from './services/questionAgent';
import { evaluationWorkerHandler } from './services/evaluationEngine';
import { getQueue } from './queue';
import { isLLMConfigured } from './llm';

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.nodeEnv,
    time: new Date().toISOString(),
    llm: { provider: config.llm.provider, configured: isLLMConfigured() },
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/applications', applicationRoutes);
app.use('/api/questionnaire', questionnaireRoutes);
app.use('/api/admin', adminRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  await connectDb();
  await runSeed(false);

  // Register job handlers before any jobs can fire
  const queue = getQueue();
  registerScrapers(queue);
  queue.register('plan:open-questions', questionAgentHandler);
  queue.register('evaluate:application', evaluationWorkerHandler);

  const server = app.listen(config.port, () => {
    console.log(`[Server] iGaps backend running on port ${config.port} (${config.nodeEnv})`);
    console.log(`[Server] LLM configured: ${isLLMConfigured()}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[Server] Port ${config.port} is already in use. Stop the other backend first:\n` +
          `  netstat -ano | findstr ":${config.port}"\n` +
          `  taskkill /PID <pid> /F`,
      );
      process.exit(1);
    }
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  });
}

boot().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

export default app;
