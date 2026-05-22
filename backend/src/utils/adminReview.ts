import { CLOSED_QUESTIONS } from './closedQuestions';
import { getOpenAnswersPlain, resolveOpenAnswerText } from './openAnswers';
import type { AlgorithmTraceEntry, GapReport, IEvaluation } from '../models/Evaluation';
import type { ISubmission, OpenQPlan } from '../models/Submission';

export interface LinkedSignalScore {
  signalKey: string;
  nodeName: string;
  category: string;
  sourceType: string;
  score: number;
  maxScore: number;
  rawScore: number;
  siblingWeight: number;
  categoryMultiplier: number;
  weightedContribution: number;
  llmEvidence?: string;
  llmWeaknesses?: string[];
}

export interface ClosedAnswerReview {
  questionId: string;
  questionText: string;
  hint?: string;
  answer: unknown;
  answerDisplay: string;
  linkedScores: LinkedSignalScore[];
}

export interface OpenAnswerReview {
  slotKey: string;
  slotId: number;
  questionText: string;
  sourceIds: string[];
  answer: string;
  wordCount: number;
  linkedScores: LinkedSignalScore[];
}

export interface EnrichedTraceEntry extends AlgorithmTraceEntry {
  sourceRef: string;
  sourceQuestionText?: string;
  founderAnswer?: unknown;
  founderAnswerDisplay?: string;
  isGap: boolean;
  gapReason?: string;
  suggestedReviewerQuestion?: string;
}

export interface AdminReviewPayload {
  closedAnswers: ClosedAnswerReview[];
  openAnswers: OpenAnswerReview[];
  enrichedTrace: EnrichedTraceEntry[];
  consistencyChecks: GapReport['consistencyChecks'];
  contradictions: GapReport['contradictions'];
}

interface TreeNodeLite {
  signalKey?: string;
  sourceRef?: string;
  nodeId: string;
}

function formatClosedAnswer(questionId: string, answer: unknown): string {
  const q = CLOSED_QUESTIONS.find((c) => c.id === questionId);
  if (!q) {
    if (answer === null || answer === undefined) return '—';
    if (typeof answer === 'object') return JSON.stringify(answer);
    return String(answer);
  }

  if (q.type === 'select_one' || q.type === 'boolean_branch') {
    const opt = q.options?.find((o) => o.value === answer);
    return opt?.label ?? String(answer ?? '—');
  }

  if (q.type === 'select_many' || q.type === 'select_many_ranked') {
    const arr = Array.isArray(answer) ? (answer as string[]) : [];
    if (arr.length === 0) return '—';
    return arr
      .map((v, i) => {
        const label = q.options?.find((o) => o.value === v)?.label ?? v;
        return q.type === 'select_many_ranked' ? `${i + 1}. ${label}` : label;
      })
      .join('; ');
  }

  if (
    q.type === 'number_with_currency' &&
    typeof answer === 'object' &&
    answer !== null &&
    'amount' in answer
  ) {
    const a = answer as { amount: number; currency: string };
    return `${a.currency} ${a.amount}`;
  }

  if (typeof answer === 'number') {
    return q.unit ? `${answer} ${q.unit}` : String(answer);
  }

  if (typeof answer === 'string') return answer || '—';
  return JSON.stringify(answer);
}

function traceToLinkedScore(t: AlgorithmTraceEntry): LinkedSignalScore {
  return {
    signalKey: t.signalKey,
    nodeName: t.nodeName,
    category: t.category,
    sourceType: t.sourceType,
    score: Math.round(t.normalizedScore * 10) / 10,
    maxScore: 100,
    rawScore: t.rawScore,
    siblingWeight: t.siblingWeight,
    categoryMultiplier: t.categoryMultiplier,
    weightedContribution: t.weightedContribution,
    llmEvidence: t.llmEvidence,
    llmWeaknesses: t.llmWeaknesses,
  };
}

function scoresForSourceRef(
  sourceRef: string,
  trace: AlgorithmTraceEntry[],
  nodeBySignal: Map<string, TreeNodeLite>,
): LinkedSignalScore[] {
  return trace
    .filter((t) => {
      const node = nodeBySignal.get(t.signalKey);
      if (node?.sourceRef === sourceRef) return true;
      return t.signalKey.startsWith(sourceRef + '_') || t.signalKey === sourceRef;
    })
    .map(traceToLinkedScore);
}

function resolveFounderAnswer(
  sourceRef: string,
  closedAnswers: Record<string, unknown>,
  openAnswers: Record<string, string>,
  openQPlan: OpenQPlan | null | undefined,
  scrapedData: Record<string, unknown>,
): { value: unknown; display: string; questionText?: string } {
  if (sourceRef.startsWith('closedQ')) {
    const q = CLOSED_QUESTIONS.find((c) => c.id === sourceRef);
    const value = closedAnswers[sourceRef];
    return {
      value,
      display: formatClosedAnswer(sourceRef, value),
      questionText: q?.text,
    };
  }

  if (sourceRef.startsWith('openQ')) {
    const text = resolveOpenAnswerText(sourceRef, openAnswers, openQPlan);
    const slot = openQPlan?.slots?.find((s) => s.sourceIds?.includes(sourceRef));
    return {
      value: text,
      display: text || '—',
      questionText: slot?.text ?? sourceRef,
    };
  }

  if (sourceRef.startsWith('scrape.')) {
    const key = sourceRef.replace('scrape.', '');
    const raw = scrapedData[key];
    if (raw === 'unavailable' || raw === undefined) {
      return { value: raw, display: 'Unavailable (scraper not configured or failed)' };
    }
    return { value: raw, display: JSON.stringify(raw).slice(0, 500) };
  }

  if (sourceRef.startsWith('derived.')) {
    return { value: null, display: 'Derived signal — computed from other answers' };
  }

  return { value: null, display: '—' };
}

export function buildAdminReview(
  submission: Pick<
    ISubmission,
    'closedAnswers' | 'openAnswers' | 'openQPlan' | 'scrapedData'
  >,
  evaluation: IEvaluation | null,
  treeNodes: TreeNodeLite[],
): AdminReviewPayload {
  const closedAnswers = (submission.closedAnswers ?? {}) as Record<string, unknown>;
  const openAnswers = getOpenAnswersPlain(submission as ISubmission);
  const openQPlan = submission.openQPlan;
  const scrapedData = (submission.scrapedData ?? {}) as Record<string, unknown>;
  const trace = evaluation?.algorithmTrace ?? [];
  const gapReport = evaluation?.gapReport;

  const nodeBySignal = new Map<string, TreeNodeLite>();
  for (const n of treeNodes) {
    if (n.signalKey) nodeBySignal.set(n.signalKey, n);
  }

  const gapByNodeId = new Map(
    (gapReport?.gaps ?? []).map((g) => [g.nodeId, g]),
  );

  const closedAnswerReviews: ClosedAnswerReview[] = CLOSED_QUESTIONS.filter(
    (q) => closedAnswers[q.id] !== undefined,
  ).map((q) => ({
    questionId: q.id,
    questionText: q.text,
    hint: q.hint,
    answer: closedAnswers[q.id],
    answerDisplay: formatClosedAnswer(q.id, closedAnswers[q.id]),
    linkedScores: scoresForSourceRef(q.id, trace, nodeBySignal),
  }));

  // Dependent text fields (e.g. closedQ9_role_text)
  for (const [key, val] of Object.entries(closedAnswers)) {
    if (CLOSED_QUESTIONS.some((q) => q.id === key)) continue;
    closedAnswerReviews.push({
      questionId: key,
      questionText: key.replace(/_/g, ' '),
      answer: val,
      answerDisplay: formatClosedAnswer(key, val),
      linkedScores: scoresForSourceRef(key, trace, nodeBySignal),
    });
  }

  const openAnswerReviews: OpenAnswerReview[] = [];

  if (openQPlan?.slots?.length) {
    for (const slot of openQPlan.slots) {
      const slotKey = `slot_${slot.slotId}`;
      const answer = openAnswers[slotKey] ?? '';
      const sourceIds = slot.sourceIds ?? [];
      const linkedScores = trace
        .filter((t) => sourceIds.some((id) => t.signalKey.startsWith(id + '_')))
        .map(traceToLinkedScore);

      openAnswerReviews.push({
        slotKey,
        slotId: slot.slotId,
        questionText: slot.text,
        sourceIds,
        answer,
        wordCount: answer.split(/\s+/).filter(Boolean).length,
        linkedScores,
      });
    }
  } else {
    for (const [slotKey, answer] of Object.entries(openAnswers)) {
      const slotId = Number(slotKey.replace('slot_', '')) || 0;
      openAnswerReviews.push({
        slotKey,
        slotId,
        questionText: `Open question ${slotKey}`,
        sourceIds: [`openQ${slotId}`],
        answer,
        wordCount: answer.split(/\s+/).filter(Boolean).length,
        linkedScores: scoresForSourceRef(`openQ${slotId}`, trace, nodeBySignal),
      });
    }
  }

  const enrichedTrace: EnrichedTraceEntry[] = trace.map((t) => {
    const node = nodeBySignal.get(t.signalKey);
    const sourceRef = node?.sourceRef ?? '';
    const gap = gapByNodeId.get(t.nodeId);
    const resolved = sourceRef
      ? resolveFounderAnswer(sourceRef, closedAnswers, openAnswers, openQPlan, scrapedData)
      : { value: undefined, display: '—', questionText: undefined };

    return {
      ...t,
      sourceRef,
      sourceQuestionText: resolved.questionText ?? node?.sourceRef,
      founderAnswer: resolved.value,
      founderAnswerDisplay: resolved.display,
      isGap: Boolean(gap),
      gapReason: gap?.reason,
      suggestedReviewerQuestion: gap?.suggestedReviewerQuestion,
    };
  });

  return {
    closedAnswers: closedAnswerReviews,
    openAnswers: openAnswerReviews,
    enrichedTrace,
    consistencyChecks: gapReport?.consistencyChecks ?? [],
    contradictions: gapReport?.contradictions ?? [],
  };
}
