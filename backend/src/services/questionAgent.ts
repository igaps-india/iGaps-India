/**
 * Question Planning Agent
 *
 * Reads:
 *   - backend/src/skills/question-agent.skill.md  (system prompt / skill file)
 *   - Active tree nodes from DB (for signal coverage report)
 *   - Submission.closedAnswers
 *   - Submission.scrapedData
 *   - Submission.uploads[*].parsedText
 *
 * Writes: Submission.openQPlan (frozen — never re-run after set)
 *
 * FALLBACK: If Gemini call fails, slots 1–10 default to the 10 original
 * questions verbatim (degraded: true).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Submission } from '../models/Submission';
import { TreeNode } from '../models/TreeNode';
import { BiasProfile } from '../models/BiasProfile';
import { getLLMProvider, isLLMConfigured } from '../llm';
import type { OpenQPlan, OpenQSlot } from '../models/Submission';

const SKILL_PATH = join(__dirname, '..', 'skills', 'question-agent.skill.md');

function loadSkillFile(): { content: string; version: string } {
  const content = readFileSync(SKILL_PATH, 'utf-8');
  // Extract version from the first line: # question-agent.skill.md — v1
  const match = content.match(/— v(\d+)/);
  const version = match ? `v${match[1]}` : 'v1';
  return { content, version };
}

function hashContext(
  skillVersion: string,
  closedAnswers: Record<string, unknown>,
  scrapedData: Record<string, unknown>,
  parsedUploads: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ skillVersion, closedAnswers, scrapedData, parsedUploads }))
    .digest('hex')
    .slice(0, 16);
}

/** Fallback: original 10 questions verbatim */
function fallbackPlan(skillVersion: string, llmProvider: string): OpenQPlan {
  const ORIGINAL_10: Array<{ id: string; text: string }> = [
    { id: 'openQ1', text: 'How did you get to this point? Tell me everything about your journey.' },
    { id: 'openQ2', text: 'What is the one thing you know about this problem that someone who has not lived your journey would simply not see?' },
    { id: 'openQ3', text: 'What can you do in the next 30 days that someone with more money but less context than you simply could not do?' },
    { id: 'openQ4', text: 'Describe the problem you are solving — in the words of the person experiencing it — and tell me about the specific person whose life is most affected by it.' },
    { id: 'openQ5', text: 'Walk me through your customer discovery — who did you speak to, what surprised you most, and what did you learn that changed your thinking?' },
    { id: 'openQ6', text: 'What specifically is missing between how things work today and how your customer wants them to work?' },
    { id: 'openQ7', text: 'Describe your solution in the words of your persona — and tell me why someone using the best existing alternative today would switch to you.' },
    { id: 'openQ8', text: 'What is the hardest problem — technical, operational, or regulatory — you have solved in building this, and what would a well-funded competitor find hardest to copy?' },
    { id: 'openQ9', text: 'Tell me about a time you got something wrong and had to change direction — what happened and how quickly did you move?' },
    { id: 'openQ10', text: 'What is the proof that the market needs your solution — not a signal you interpreted, but actual evidence?' },
  ];

  const slots: OpenQSlot[] = ORIGINAL_10.map((q, i) => ({
    slotId: i + 1,
    source: 'original',
    sourceIds: [q.id],
    text: q.text,
    targetSignals: [],
    rationale: 'Fallback — LLM unavailable',
  }));

  return {
    slots,
    skillVersion,
    llmProvider,
    llmModel: 'fallback',
    generatedAt: new Date(),
    degraded: true,
  };
}

/** Compute signal coverage report — which signals have closedQ data and which are missing */
function buildSignalCoverageReport(
  nodes: Array<{ signalKey?: string; sourceType?: string; category: string; name: string }>,
  closedAnswers: Record<string, unknown>,
): Record<string, 'covered' | 'missing'> {
  const report: Record<string, 'covered' | 'missing'> = {};
  for (const node of nodes) {
    if (!node.signalKey) continue;
    if (node.sourceType === 'closed_q') {
      // Extract the closedQ prefix e.g. closedQ1 from closedQ1_role_before
      const qId = node.signalKey.replace(/_.*$/, '');
      report[node.signalKey] = closedAnswers[qId] !== undefined ? 'covered' : 'missing';
    } else if (node.sourceType === 'open_q' || node.sourceType === 'scraped') {
      report[node.signalKey] = 'missing'; // always needs to be covered by open Qs or scraping
    } else {
      report[node.signalKey] = 'missing';
    }
  }
  return report;
}

function hasValidPlan(submission: { openQPlan?: OpenQPlan | null }): boolean {
  return Boolean(submission.openQPlan?.slots?.length);
}

/** Plan is frozen once a non-degraded plan exists, or degraded when LLM is unavailable. */
function isPlanFrozen(submission: { openQPlan?: OpenQPlan | null }): boolean {
  const plan = submission.openQPlan;
  if (!plan?.slots?.length) return false;
  // Regenerate fallback plans when a real API key is added after first upload
  if (plan.degraded && isLLMConfigured()) return false;
  return true;
}

export async function planOpenQuestions(applicationId: string, opts: { force?: boolean } = {}): Promise<void> {
  const submission = await Submission.findOne({ applicationId });
  if (!submission) throw new Error(`Submission not found for ${applicationId}`);

  if (!opts.force && isPlanFrozen(submission)) {
    console.info(`[QuestionAgent] Plan already exists for ${applicationId}, skipping`);
    return;
  }

  if (opts.force || (submission.openQPlan?.degraded && isLLMConfigured())) {
    console.info(`[QuestionAgent] Regenerating plan for ${applicationId} (Gemini now available)`);
    submission.openQPlan = undefined;
  }

  let skillContent: string;
  let skillVersion: string;
  try {
    ({ content: skillContent, version: skillVersion } = loadSkillFile());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[QuestionAgent] Skill file load failed for ${applicationId}: ${msg}. Using fallback.`);
    submission.openQPlan = fallbackPlan('v1', 'none');
    await submission.save();
    return;
  }

  if (!isLLMConfigured()) {
    console.warn(`[QuestionAgent] LLM not configured for ${applicationId}. Using fallback plan.`);
    submission.openQPlan = fallbackPlan(skillVersion, 'none');
    await submission.save();
    return;
  }

  let llm;
  try {
    llm = getLLMProvider();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[QuestionAgent] LLM init failed for ${applicationId}: ${msg}. Using fallback.`);
    submission.openQPlan = fallbackPlan(skillVersion, 'none');
    await submission.save();
    return;
  }

  // Get active BiasProfile and tree nodes
  const profile = await BiasProfile.findOne({ isActive: true });
  const nodes = profile
    ? await TreeNode.find({ biasProfileId: profile._id, enabled: true }).lean()
    : [];

  const closedAnswers = submission.closedAnswers as Record<string, unknown>;
  const scrapedData = submission.scrapedData as Record<string, unknown>;

  // Concat all parsed upload text
  const parsedUploads = submission.uploads
    .filter((u) => u.parseStatus === 'success' && u.parsedText)
    .map((u) => `[${u.type}] ${u.parsedText}`)
    .join('\n\n---\n\n');

  const signalCoverage = buildSignalCoverageReport(nodes, closedAnswers);

  const contextPayload = {
    signalCoverage,
    closedAnswers,
    scrapedData,
    parsedUploads: parsedUploads.slice(0, 8000), // limit to avoid token blowout
  };

  const userMessage = `You are planning open-ended interview questions for an AI startup application.

Signal coverage report (what is covered vs. what still needs open-question coverage):
${JSON.stringify(signalCoverage, null, 2)}

Closed-ended answers (as submitted):
${JSON.stringify(closedAnswers, null, 2)}

Scraped data summary:
${JSON.stringify(
    {
      linkedin_available: typeof scrapedData.linkedin !== 'object' || (scrapedData.linkedin as Record<string, unknown>)?.status !== 'unavailable',
      github_available: typeof scrapedData.github !== 'object' || (scrapedData.github as Record<string, unknown>)?.status !== 'unavailable',
      zauba_available: typeof scrapedData.zauba !== 'object' || (scrapedData.zauba as Record<string, unknown>)?.status !== 'unavailable',
    },
    null,
    2,
  )}

Parsed pitch deck text (first 8000 chars):
${parsedUploads.slice(0, 2000)}

Please produce the 10-question plan now.`;

  try {
    const response = await llm.complete(
      [
        { role: 'system', content: skillContent },
        { role: 'user', content: userMessage },
      ],
      {
        task: 'agent',
        temperature: 0,
        topP: 0.1,
        jsonMode: true,
        maxOutputTokens: 16384,
      },
    );

    const parsed = response.json as { slots?: OpenQSlot[] };
    if (!parsed?.slots || !Array.isArray(parsed.slots) || parsed.slots.length !== 10) {
      throw new Error(`Invalid plan response — expected 10 slots, got ${parsed?.slots?.length}`);
    }

    submission.openQPlan = {
      slots: parsed.slots,
      skillVersion,
      llmProvider: llm.providerName,
      llmModel: response.model,
      generatedAt: new Date(),
      degraded: false,
    };

    const ctxHash = hashContext(skillVersion, closedAnswers, scrapedData, parsedUploads);
    console.info(`[QuestionAgent] Plan generated for ${applicationId} (ctx:${ctxHash})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[QuestionAgent] LLM call failed for ${applicationId}: ${msg}. Using fallback.`);
    submission.openQPlan = fallbackPlan(skillVersion, llm.providerName);
  }

  if (!hasValidPlan(submission)) {
    submission.openQPlan = fallbackPlan(skillVersion, llm.providerName);
  }

  await submission.save();
}

/** Worker handler registered on the job queue */
export const questionAgentHandler = async (
  job: import('../queue').Job<{ applicationId: string }>,
) => {
  await planOpenQuestions(job.data.applicationId);
};
