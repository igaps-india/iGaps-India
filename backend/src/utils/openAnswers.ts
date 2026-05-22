import type { ISubmission } from '../models/Submission';
import type { OpenQPlan } from '../models/Submission';

/** Read openAnswers as a plain object (handles legacy Map storage). */
export function getOpenAnswersPlain(submission: ISubmission): Record<string, string> {
  const raw = submission.openAnswers as unknown;
  if (raw instanceof Map) {
    return Object.fromEntries(raw.entries()) as Record<string, string>;
  }
  if (raw && typeof raw === 'object') {
    return { ...(raw as Record<string, string>) };
  }
  return {};
}

/** Merge and persist open answers as a plain object (avoids Mongoose Map spread bugs). */
export function mergeOpenAnswers(
  submission: ISubmission,
  incoming: Record<string, string>,
): void {
  submission.set('openAnswers', { ...getOpenAnswersPlain(submission), ...incoming });
}

/**
 * Resolve founder text for an open-question rubric (e.g. sourceRef "openQ1").
 * Frontend stores answers as slot_1 … slot_10; plan may reorder originals.
 */
export function resolveOpenAnswerText(
  sourceRef: string,
  openAnswers: Record<string, string>,
  openQPlan?: OpenQPlan | null,
): string {
  if (openAnswers[sourceRef]) return openAnswers[sourceRef];

  const legacyKey = `slot_${sourceRef}`;
  if (openAnswers[legacyKey]) return openAnswers[legacyKey];

  if (openQPlan?.slots?.length) {
    const slot = openQPlan.slots.find((s) => s.sourceIds?.includes(sourceRef));
    if (slot) {
      const bySlotId = openAnswers[`slot_${slot.slotId}`];
      if (bySlotId) return bySlotId;
    }
  }

  const numMatch = sourceRef.match(/^openQ(\d+)$/i);
  if (numMatch) {
    return openAnswers[`slot_${numMatch[1]}`] ?? '';
  }

  return '';
}
