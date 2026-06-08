/**
 * Evaluation Engine
 *
 * Pipeline:
 *  1. Load active BiasProfile + tree nodes
 *  2. Score each signal node (closed_mapping / numeric_curve / llm_rubric / scrape_threshold / derived)
 *  3. Build signalsMap (flat key→rawScore)
 *  4. Run knockout gate
 *  5. Run contradiction checks (cross-verify claims vs scraped data)
 *  6. Aggregate: per-node → layer → track → composite
 *  7. Apply reconciliation rules
 *  8. Write Evaluation document + update Application status
 */

import { Application } from '../models/Application';
import { Submission } from '../models/Submission';
import { BiasProfile, IBiasProfile } from '../models/BiasProfile';
import { TreeNode } from '../models/TreeNode';
import { Knockout, KnockoutRule, KnockoutPredicate } from '../models/Knockout';
import { Evaluation, EvaluationBand } from '../models/Evaluation';
import { AuditLog } from '../models/AuditLog';
import { scoreWithRubric } from './rubricScorer';
import { getOpenAnswersPlain, resolveOpenAnswerText } from '../utils/openAnswers';
import { CLOSED_QUESTIONS } from '../utils/closedQuestions';
import axios from 'axios';
import type {
  AlgorithmTraceEntry,
  Contradiction,
  KnockoutsResult,
  ReconciliationLogEntry,
  GapReport,
} from '../models/Evaluation';

// ── Vector Similarity Scorer (calls Python microservice, no external API) ──────
// Falls back to score=0 gracefully if the Python service is not running.
async function scoreWithVectorSimilarity(
  signalKey: string,
  answerText: string,
): Promise<{ score: number; confidence: 'high' | 'medium' | 'low'; simToPerfect: number; simToTerrible: number }> {
  if (!answerText?.trim() || answerText.trim().length < 20) {
    return { score: 0, confidence: 'low', simToPerfect: 0, simToTerrible: 0 };
  }
  try {
    const response = await axios.post<{
      score: number;
      confidence: string;
      sim_to_perfect: number;
      sim_to_terrible: number;
    }>(
      'http://127.0.0.1:8000/score/vector',
      { signal_key: signalKey, answer_text: answerText },
      { timeout: 5_000 },
    );
    const data = response.data;
    return {
      score: Math.min(100, Math.max(0, data.score)),
      confidence: (['high', 'medium', 'low'].includes(data.confidence)
        ? data.confidence
        : 'low') as 'high' | 'medium' | 'low',
      simToPerfect: data.sim_to_perfect ?? 0,
      simToTerrible: data.sim_to_terrible ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Engine] Vector similarity scorer unavailable for ${signalKey}: ${msg}. Falling back to score=0.`);
    return { score: 0, confidence: 'low', simToPerfect: 0, simToTerrible: 0 };
  }
}

// Lean plain-object types (avoid Mongoose document type complexity)
interface LeanTreeNode {
  nodeId: string; parentId?: string; kind: string; name: string; category: string;
  weight: number; enabled: boolean; sourceType?: string; sourceRef?: string;
  signalKey?: string; scoringRule?: Record<string, unknown>; flags?: string[];
}
interface LeanKnockout {
  knockoutId: string; name: string; severity: string; rule: KnockoutRule;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SignalsMap = Record<string, unknown>;

// ── Per-node scoring ──────────────────────────────────────────────────────────

function scoredClosedMapping(
  value: unknown,
  mapping: Record<string, number>,
): number {
  if (value === undefined || value === null) return 0;
  
  if (Array.isArray(value)) {
    if (value.length === 0) return 0;
    const scores = value.map((v) => mapping[String(v)] ?? 0);
    return Math.max(...scores);
  }
  
  const key = String(value);
  return mapping[key] ?? 0;
}

function extractNumericClosedValue(value: unknown): number {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'amount' in value) {
    const { amount, currency } = value as { amount: unknown; currency?: string };
    const n = Number(amount);
    if (isNaN(n)) return NaN;
    // tree.yaml CAC curve is in USD; convert INR at scoring time
    if (currency === 'INR') return n / 83;
    return n;
  }
  return Number(value);
}

function scoredNumericCurve(
  value: unknown,
  curve: Record<string, number>,
): number {
  if (value === undefined || value === null) return 0;
  const num = extractNumericClosedValue(value);
  if (isNaN(num)) return 0;

  const points = Object.entries(curve)
    .map(([k, v]) => ({ x: Number(k), y: v }))
    .sort((a, b) => a.x - b.x);

  if (points.length === 0) return 0;
  if (num <= points[0].x) return points[0].y;
  if (num >= points[points.length - 1].x) return points[points.length - 1].y;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (num >= a.x && num <= b.x) {
      const t = (num - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return 0;
}

function scoredScrapeThreshold(
  value: unknown,
  thresholds: Record<string, number>,
): number {
  if (value === 'unavailable' || value === undefined || value === null) return 0;
  const key = String(value);
  return thresholds[key] ?? 0;
}

/** Evaluate knockout rule DSL against signalsMap */
function evaluateKnockoutRule(rule: KnockoutRule, signals: SignalsMap): boolean {
  if ('any' in rule) {
    return (rule as { any: KnockoutRule[] }).any.some((r) => evaluateKnockoutRule(r, signals));
  }
  if ('all' in rule) {
    return (rule as { all: KnockoutRule[] }).all.every((r) => evaluateKnockoutRule(r, signals));
  }
  if ('not' in rule) {
    return !evaluateKnockoutRule((rule as { not: KnockoutRule }).not, signals);
  }

  // Leaf predicate
  const pred = rule as KnockoutPredicate;
  const val = signals[pred.signal];

  switch (pred.op) {
    case 'equals':
      return String(val) === String(pred.value);
    case 'not_equals':
      return String(val) !== String(pred.value);
    case 'less_than':
      return Number(val) < Number(pred.value);
    case 'greater_than':
      return Number(val) > Number(pred.value);
    case 'in':
      return Array.isArray(pred.value) && (pred.value as unknown[]).includes(val);
    case 'not_in':
      return Array.isArray(pred.value) && !(pred.value as unknown[]).includes(val);
    case 'contains':
      return typeof val === 'string' && val.includes(String(pred.value));
    case 'exists':
      return val !== undefined && val !== null;
    case 'missing':
      return val === undefined || val === null;
    default:
      return false;
  }
}

// ── Category multiplier ───────────────────────────────────────────────────────

function categoryMultiplier(category: string, profile: IBiasProfile): number {
  const m = profile.categoryMultipliers;
  switch (category) {
    case 'required': return m.required;
    case 'must_have': return m.must_have;
    case 'good_to_have': return m.good_to_have;
    case 'not_required': return m.not_required;
    default: return 0;
  }
}

// ── Score band ────────────────────────────────────────────────────────────────

function compositeToband(score: number): EvaluationBand {
  if (score < 40) return 'not_passed';
  if (score < 60) return 'passed_with_gaps';
  if (score < 80) return 'passed';
  return 'priority';
}

// ── Main evaluation ───────────────────────────────────────────────────────────

export async function evaluate(applicationId: string): Promise<void> {
  const application = await Application.findById(applicationId);
  if (!application) throw new Error(`Application ${applicationId} not found`);

  const submission = await Submission.findOne({ applicationId });
  if (!submission) throw new Error(`Submission for ${applicationId} not found`);

  const profile = await BiasProfile.findOne({ isActive: true });
  if (!profile) throw new Error('No active BiasProfile found — run seed first');

  const allNodes = (await TreeNode.find({
    biasProfileId: profile._id,
    enabled: true,
  }).lean()) as unknown as LeanTreeNode[];

  const knockouts = (await Knockout.find({ enabled: true }).lean()) as unknown as LeanKnockout[];

  const closedAnswers = submission.closedAnswers as Record<string, unknown>;
  const openAnswers = getOpenAnswersPlain(submission);
  const scrapedData = submission.scrapedData as Record<string, unknown>;

  const signalsMap: SignalsMap = {};
  const traceEntries: AlgorithmTraceEntry[] = [];

  // ── Score each signal node ─────────────────────────────────────────────────
  const signalNodes = allNodes.filter((n) => n.kind === 'signal');

  for (const node of signalNodes) {
    if (!node.signalKey || !node.scoringRule) continue;

    let rawScore = 0;
    let llmEvidence: string | undefined;
    let llmWeaknesses: string[] | undefined;
    let rawTextEvidence: string | null | undefined;
    let weakness: string | null | undefined;
    let confidence: 'high' | 'medium' | 'low' | undefined;
    let zodValidated: boolean | undefined;
    let scoringMethod = 'unknown';

    try {
      const rule = node.scoringRule as Record<string, unknown>;

      if (rule.type === 'closed_mapping' && rule.mapping) {
        const sourceRef = node.sourceRef ?? '';
        const qId = sourceRef.replace('closedQ', 'closedQ');
        const answer = closedAnswers[qId];
        rawScore = scoredClosedMapping(answer, rule.mapping as Record<string, number>);
        scoringMethod = 'closed_mapping';
      } else if (rule.type === 'numeric_curve' && rule.curve) {
        const sourceRef = node.sourceRef ?? '';
        const answer = closedAnswers[sourceRef];
        rawScore = scoredNumericCurve(answer, rule.curve as Record<string, number>);
        scoringMethod = 'numeric_curve';
      } else if (rule.type === 'llm_rubric' && rule.rubric) {
        const sourceRef = node.sourceRef ?? '';
        const answerText = resolveOpenAnswerText(
          sourceRef,
          openAnswers,
          submission.openQPlan,
        );

        const result = await scoreWithRubric(String(rule.rubric), answerText);
        rawScore = result.score;
        // Legacy fields
        llmEvidence = result.evidence;
        llmWeaknesses = result.weaknesses;
        // New Zod-validated audit fields
        rawTextEvidence = result.rawTextEvidence;
        weakness = result.weakness;
        confidence = result.confidence;
        zodValidated = result.zodValidated;
        scoringMethod = 'llm_rubric';

        // Propagate inarticulate genius flag
        if (result.inarticulateGeniusFlag) {
          signalsMap['flag_inarticulate_genius'] = true;
        }
        if (result.tarPitFlag) {
          signalsMap['flag_tar_pit'] = true;
        }
      } else if (rule.type === 'vector_similarity') {
        // Score using local sentence-transformer embeddings (no external API)
        const sourceRef = node.sourceRef ?? '';
        const answerText = resolveOpenAnswerText(
          sourceRef,
          openAnswers,
          submission.openQPlan,
        );
        const vsResult = await scoreWithVectorSimilarity(node.signalKey, answerText);
        rawScore = vsResult.score;
        confidence = vsResult.confidence;
        // Store sim scores as evidence in the audit trail
        rawTextEvidence = `sim_to_perfect=${vsResult.simToPerfect.toFixed(3)}, sim_to_terrible=${vsResult.simToTerrible.toFixed(3)}`;
        scoringMethod = 'vector_similarity';
        zodValidated = true; // Vector scorer always returns a clean structured result
      } else if (rule.type === 'scrape_threshold' && rule.thresholds) {
        const sourceRef = node.sourceRef ?? '';
        // Map scrape reference to nested scrapedData
        const scrapeKey = sourceRef.replace('scrape.', '');
        const scrapeValue = (scrapedData[scrapeKey] as Record<string, unknown>)?.status ?? (scrapedData[scrapeKey] ? 'found' : 'none');
        rawScore = scoredScrapeThreshold(scrapeValue, rule.thresholds as Record<string, number>);
        scoringMethod = 'scrape_threshold';
      } else if (rule.type === 'derived_formula') {
        // Derived signals computed after all others — placeholder score
        rawScore = 50; // Will be refined in a follow-up iteration
        scoringMethod = 'derived_formula';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Engine] Scoring error for node ${node.nodeId}: ${msg}`);
      rawScore = 0;
    }

    const normalizedScore = Math.min(100, Math.max(0, rawScore));
    const cm = categoryMultiplier(node.category, profile);
    const weightedContribution = (normalizedScore / 100) * (node.weight / 100) * cm;

    signalsMap[node.signalKey] = normalizedScore;

    traceEntries.push({
      nodeId: node.nodeId,
      signalKey: node.signalKey,
      nodeName: node.name,
      category: node.category,
      rawScore,
      normalizedScore,
      categoryMultiplier: cm,
      siblingWeight: node.weight,
      weightedContribution,
      // Legacy fields
      llmEvidence,
      llmWeaknesses,
      // New Zod-validated audit fields
      rawTextEvidence,
      weakness,
      confidence,
      zodValidated,
      scoringMethod,
      flags: node.flags ?? [],
      sourceType: node.sourceType ?? '',
      sourceRef: node.sourceRef ?? '',
    });
  }

  // ── Knockout gate ──────────────────────────────────────────────────────────
  const knockoutsResult = runKnockouts(knockouts, signalsMap);

  // ── Contradiction checks (cross-verify founder claims vs scraped data) ────
  const contradictions = runContradictionChecks(signalsMap, closedAnswers, scrapedData, traceEntries);
  if (contradictions.some((c) => c.severity === 'high')) {
    // At least one high-severity contradiction — ensure route_to_human is set
    knockoutsResult.routeToHuman = true;
    console.warn(
      `[Engine] High-severity contradiction detected for ${applicationId}: ` +
      contradictions.filter((c) => c.severity === 'high').map((c) => c.description).join(' | '),
    );
  }

  // ── Aggregate track scores ─────────────────────────────────────────────────
  const trackScores = aggregateTracks(allNodes, signalNodes, signalsMap, traceEntries, profile);

  // ── Composite score ────────────────────────────────────────────────────────
  const trackNodes = allNodes.filter((n) => n.kind === 'track');
  let composite = 0;
  for (const track of trackNodes) {
    const trackScore = trackScores[track.nodeId.replace('track', '') as keyof typeof trackScores] ?? 0;
    composite += (track.weight / 100) * trackScore;
  }
  composite = Math.min(100, Math.max(0, composite));

  // ── Reconciliation ─────────────────────────────────────────────────────────
  const { finalComposite, reconciliationLog } = applyReconciliation(
    composite,
    trackScores,
    signalsMap,
    profile,
  );

  // ── If hard_stop knockout triggered — force fail ──────────────────────────
  const hardStop = knockoutsResult.evaluated.find(
    (k) => k.triggered && k.severity === 'hard_stop',
  );
  const effectiveScore = hardStop ? 0 : finalComposite;
  const band = hardStop ? 'not_passed' : compositeToband(effectiveScore);

  // ── Build gap report ───────────────────────────────────────────────────────
  const gapReport = buildGapReport(
    band,
    profile.version,
    closedAnswers,
    openAnswers,
    traceEntries,
    knockoutsResult,
    reconciliationLog,
    contradictions,
    submission.openQPlan?.skillVersion ?? 'unknown',
    submission.openQPlan,
  );

  // ── Persist evaluation ─────────────────────────────────────────────────────
  const evaluation = await Evaluation.create({
    applicationId,
    profileVersionUsed: profile.version,
    skillVersionUsed: submission.openQPlan?.skillVersion ?? 'unknown',
    signalsMap,
    knockoutsResult,
    trackScores: {
      A: trackScores.A,
      B: trackScores.B,
      C: trackScores.C,
      D: trackScores.D,
    },
    compositeScore: Math.round(effectiveScore * 100) / 100,
    band,
    gapReport,
    algorithmTrace: traceEntries,
    reconciliationAdjustments: reconciliationLog,
  });

  application.status = band === 'not_passed' ? 'rejected' : 'passed';
  await application.save();

  await AuditLog.create({
    actor: 'system',
    action: 'evaluation_created',
    target: `evaluations/${evaluation._id}`,
    after: { band, compositeScore: effectiveScore },
    at: new Date(),
  });

  console.info(
    `[Engine] Evaluation complete for ${applicationId}: ${band} (${Math.round(effectiveScore)}%)`,
  );
}

// ── Knockout runner ───────────────────────────────────────────────────────────

function runKnockouts(knockouts: LeanKnockout[], signals: SignalsMap): KnockoutsResult {
  const evaluated = knockouts.map((ko) => {
    const triggered = evaluateKnockoutRule(ko.rule as KnockoutRule, signals);
    return {
      id: ko.knockoutId,
      triggered,
      severity: ko.severity,
      ruleTrace: triggered ? `Knockout ${ko.knockoutId} (${ko.name}) fired` : '',
    };
  });

  const anyTriggered = evaluated.some((e) => e.triggered);
  const routeToHuman = evaluated.some((e) => e.triggered && e.severity === 'route_to_human');

  return { anyTriggered, routeToHuman, evaluated };
}

// ── Track aggregation ─────────────────────────────────────────────────────────

function aggregateTracks(
  allNodes: LeanTreeNode[],
  signalNodes: LeanTreeNode[],
  signalsMap: SignalsMap,
  _trace: AlgorithmTraceEntry[],
  profile: IBiasProfile,
): { A: number; B: number; C: number; D: number } {
  const tracks = { A: 0, B: 0, C: 0, D: 0 };

  for (const trackNode of allNodes.filter((n) => n.kind === 'track')) {
    const trackKey = trackNode.nodeId.replace('track', '') as keyof typeof tracks;
    const layerNodes = allNodes.filter(
      (n) => n.kind === 'layer' && n.parentId === trackNode.nodeId,
    );

    let trackScore = 0;
    let totalLayerWeight = 0;

    for (const layer of layerNodes) {
      const layerSignals = signalNodes.filter((n) => n.parentId === layer.nodeId);
      let layerScore = 0;
      let totalSiblingWeight = 0;

      for (const sig of layerSignals) {
        if (!sig.signalKey) continue;
        const rawScore = Number(signalsMap[sig.signalKey] ?? 0);
        const cm = categoryMultiplier(sig.category, profile);
        const contribution = (rawScore / 100) * cm * (sig.weight / 100);
        layerScore += contribution;
        totalSiblingWeight += sig.weight;
      }

      // Normalise if sibling weights do not sum to 100
      if (totalSiblingWeight > 0 && Math.abs(totalSiblingWeight - 100) > 1) {
        layerScore = layerScore * (100 / totalSiblingWeight);
      }

      // Multiply layer score by category multiplier of the layer itself
      const layerCM = categoryMultiplier(layer.category, profile);
      trackScore += layerScore * layerCM * (layer.weight / 100);
      totalLayerWeight += layer.weight;
    }

    if (totalLayerWeight > 0 && Math.abs(totalLayerWeight - 100) > 1) {
      trackScore = trackScore * (100 / totalLayerWeight);
    }

    tracks[trackKey] = Math.min(100, Math.max(0, trackScore * 100));
  }

  return tracks;
}

// ── Reconciliation ────────────────────────────────────────────────────────────

function applyReconciliation(
  composite: number,
  trackScores: { A: number; B: number; C: number; D: number },
  signalsMap: SignalsMap,
  profile: IBiasProfile,
): { finalComposite: number; reconciliationLog: ReconciliationLogEntry[] } {
  let adjusted = composite;
  const log: ReconciliationLogEntry[] = [];

  const rec = profile.reconciliation;

  // 1. Leverage × Market Fit Amplifier
  if (rec.leverageMarketAmplifier.enabled) {
    const a3Score = trackScores.A; // Track A approximates leverage
    const bAvg = (trackScores.B + trackScores.C) / 2;
    if (a3Score >= rec.leverageMarketAmplifier.thresholdTrackAL3 &&
        bAvg >= rec.leverageMarketAmplifier.thresholdTrackBL3L4Avg) {
      const m = rec.leverageMarketAmplifier.multiplier;
      adjusted *= m;
      log.push({
        rule: 'leverage_market_amplifier',
        applied: true,
        reason: `Track A ${a3Score.toFixed(0)}% ≥ ${rec.leverageMarketAmplifier.thresholdTrackAL3} and avg(B,C) ${bAvg.toFixed(0)}% ≥ ${rec.leverageMarketAmplifier.thresholdTrackBL3L4Avg}`,
        multiplier: m,
      });
    } else {
      log.push({ rule: 'leverage_market_amplifier', applied: false, reason: 'Threshold not met' });
    }
  }

  // 2. Inarticulate Genius flag
  if (rec.inarticulateGenius.enabled && signalsMap['flag_inarticulate_genius'] === true) {
    const trackAScore = trackScores.A;
    const trackBScore = trackScores.B;
    if (trackAScore < rec.inarticulateGenius.thresholdTrackABelow &&
        trackBScore > rec.inarticulateGenius.thresholdTrackBAbove) {
      log.push({
        rule: 'inarticulate_genius',
        applied: true,
        reason: `Track A ${trackAScore.toFixed(0)}% < ${rec.inarticulateGenius.thresholdTrackABelow} but Track B ${trackBScore.toFixed(0)}% > ${rec.inarticulateGenius.thresholdTrackBAbove} — route to human review`,
      });
    } else {
      log.push({ rule: 'inarticulate_genius', applied: false, reason: 'Conditions not met' });
    }
  }

  // 3. Tar pit flag
  if (rec.tarPit.enabled && signalsMap['flag_tar_pit'] === true) {
    const m = rec.tarPit.multiplier;
    adjusted *= m;
    log.push({
      rule: 'tar_pit',
      applied: true,
      reason: 'Non-obvious insight rubric flagged potential tar pit',
      multiplier: m,
    });
  }

  return { finalComposite: Math.min(100, Math.max(0, adjusted)), reconciliationLog: log };
}

// ── Contradiction detection ───────────────────────────────────────────────────
// Cross-checks founder claims against scraper data and internal consistency.
// Each rule compares two or more signals that SHOULD be consistent.
// If they contradict, it means the founder may be exaggerating or the data is incomplete.

function runContradictionChecks(
  signalsMap: SignalsMap,
  closedAnswers: Record<string, unknown>,
  scrapedData: Record<string, unknown>,
  trace: AlgorithmTraceEntry[],
): Contradiction[] {
  const contradictions: Contradiction[] = [];

  // ── Rule 1: Execution Claims vs GitHub Reality ─────────────────────────────
  // If LLM says the founder pivots fast / executes well (pivot_quality > 70)
  // but GitHub shows zero activity, something doesn't add up.
  const pivotQualityScore = Number(signalsMap['openQ9_pivot_quality_score'] ?? 0);
  const githubScore = Number(signalsMap['scrape_github_commits_per_week'] ?? 0);

  if (pivotQualityScore > 70 && githubScore === 0) {
    contradictions.push({
      signal: 'execution_vs_github',
      claimedValue: `Pivot quality LLM score: ${pivotQualityScore}`,
      scrapedValue: `GitHub velocity score: ${githubScore}`,
      severity: 'high',
      description:
        'Founder claims fast execution/pivots, but GitHub shows zero commits. ' +
        'Possible reasons: private repo, non-technical founder, or exaggerated claims. ' +
        'Reviewer should ask: "Can you show us your codebase or deployment history?"',
    });
  }

  // ── Rule 2: Traction Stage vs Scraper Evidence ─────────────────────────────
  // If founder claims paying_customers or higher, but there is zero organic
  // demand (no press, no search traffic), it is suspicious.
  const tractionStage = String(closedAnswers['closedQ17'] ?? '');
  const organicDemandScore = Number(signalsMap['scrape_organic_demand_score'] ?? 0);
  const pressMentionScore = Number(signalsMap['scrape_press_mention_count'] ?? 0);

  const claimsSignificantTraction = ['paying_customers', 'recurring_revenue', 'scaled_revenue'].includes(tractionStage);

  if (claimsSignificantTraction && organicDemandScore === 0 && pressMentionScore === 0) {
    contradictions.push({
      signal: 'traction_vs_organic_signal',
      claimedValue: `Traction stage: ${tractionStage}`,
      scrapedValue: `Organic demand score: ${organicDemandScore}, Press mentions: ${pressMentionScore}`,
      severity: 'medium',
      description:
        'Founder claims paying customers or revenue, but no organic demand signal ' +
        'was found online (no press, no Google Trends signal, no social mentions). ' +
        'Could be a stealth-mode startup, but reviewer should verify: ' +
        '"Can you share a customer reference or invoice?"',
    });
  }

  // ── Rule 3: Domain Experience vs Company Age ───────────────────────────────
  // If founder claims 36+ months of domain exposure, but the company
  // was incorporated very recently AND LinkedIn doesn't show relevant history,
  // the timeline may be inconsistent.
  const domainExposureMonths = Number(closedAnswers['closedQ2'] ?? 0);
  const linkedinData = scrapedData['linkedin'] as Record<string, unknown> | undefined;
  const linkedinStatus = String(linkedinData?.status ?? 'none');
  const zaubaData = scrapedData['zauba'] as Record<string, unknown> | undefined;
  const incorpDateStr = String(zaubaData?.incorporationDate ?? '');

  if (domainExposureMonths >= 36 && incorpDateStr) {
    const incorpDate = new Date(incorpDateStr);
    const monthsSinceIncorp = !isNaN(incorpDate.getTime())
      ? (Date.now() - incorpDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
      : null;

    if (monthsSinceIncorp !== null && monthsSinceIncorp < 18 && linkedinStatus !== 'strong') {
      contradictions.push({
        signal: 'domain_experience_vs_company_age',
        claimedValue: `Domain exposure: ${domainExposureMonths} months`,
        scrapedValue: `Company age: ~${Math.round(monthsSinceIncorp)} months (Zauba), LinkedIn overlap: ${linkedinStatus}`,
        severity: 'high',
        description:
          `Founder claims ${domainExposureMonths} months of domain experience, ` +
          `but the company was incorporated only ~${Math.round(monthsSinceIncorp)} months ago ` +
          'and LinkedIn does not show a strong prior role in the same domain. ' +
          'Reviewer should ask: "What were you doing in this domain before incorporation?"',
      });
    }
  }

  // ── Rule 4: Co-founder Relationship Claims vs LinkedIn Overlap ─────────────
  // If founder says they "built a startup together" or "worked together",
  // but LinkedIn shows no overlapping employment history, it is suspicious.
  const relationshipType = String(closedAnswers['closedQ4'] ?? '');
  const linkedinOverlapScore = Number(signalsMap['scrape_cofounder_overlap_linkedin'] ?? 0);

  const claimsStrongRelationship = ['built_startup_together', 'worked_together'].includes(relationshipType);

  if (claimsStrongRelationship && linkedinOverlapScore === 0) {
    contradictions.push({
      signal: 'cofounder_relationship_vs_linkedin',
      claimedValue: `Relationship type: ${relationshipType}`,
      scrapedValue: `LinkedIn co-founder overlap score: ${linkedinOverlapScore}`,
      severity: 'medium',
      description:
        `Founder claims they "${relationshipType.replace(/_/g, ' ')}" with co-founder, ` +
        'but LinkedIn shows no overlapping employment or education history. ' +
        'Could be a LinkedIn data gap, but reviewer should verify: ' +
        '"Where exactly did you work together, and for how long?"',
    });
  }

  if (contradictions.length > 0) {
    console.info(
      `[Engine] Contradiction check found ${contradictions.length} issue(s): ` +
      contradictions.map((c) => `${c.signal} (${c.severity})`).join(', '),
    );
  }

  return contradictions;
}

// ── Gap report builder ────────────────────────────────────────────────────────

function buildGapReport(
  band: EvaluationBand,
  profileVersion: number,
  closedAnswers: Record<string, unknown>,
  openAnswers: Record<string, string>,
  trace: AlgorithmTraceEntry[],
  knockoutsResult: KnockoutsResult,
  reconciliationLog: ReconciliationLogEntry[],
  contradictions: Contradiction[],
  skillVersion: string,
  openQPlan?: import('../models/Submission').OpenQPlan | null,
): GapReport {
  // Build founderAnswers for the report
  const founderAnswers: GapReport['founderAnswers'] = {};

  for (const [key, val] of Object.entries(closedAnswers)) {
    const q = CLOSED_QUESTIONS.find((c) => c.id === key);
    founderAnswers[key] = {
      questionText: q?.text ?? key,
      answer: val,
    };
  }
  for (const [key, val] of Object.entries(openAnswers)) {
    const slotNum = key.replace('slot_', '');
    const slot = openQPlan?.slots?.find((s) => String(s.slotId) === slotNum);
    founderAnswers[key] = {
      questionText: slot?.text ?? key,
      answer: val,
      wordCount: val?.split(/\s+/).filter(Boolean).length,
    };
  }

  // Identify gaps: required/must_have signals with score < 50
  const gaps: GapReport['gaps'] = trace
    .filter(
      (t) =>
        (t.category === 'required' || t.category === 'must_have') &&
        t.normalizedScore < 50,
    )
    .map((t) => ({
      nodeId: t.nodeId,
      name: t.nodeName,
      category: t.category,
      reason: `Score ${t.normalizedScore.toFixed(0)}% — ${t.llmEvidence ?? 'below threshold'}`,
      suggestedReviewerQuestion: `Ask the founder to elaborate on: ${t.nodeName}`,
    }));

  return {
    generatedAt: new Date(),
    profileVersion,
    overallBand: band,
    founderAnswers,
    nodeEvaluations: trace,
    contradictions,
    consistencyChecks: [
      {
        checkName: 'skill_version',
        passed: skillVersion !== 'unknown',
        description: `Question agent skill: ${skillVersion}`,
      },
      {
        checkName: 'contradiction_check',
        passed: contradictions.length === 0,
        description: contradictions.length === 0
          ? 'No contradictions detected between founder claims and scraped data'
          : `${contradictions.length} contradiction(s) detected — review recommended`,
      },
    ],
    gaps,
    knockoutsResult,
    reconciliationLog,
  };
}

// ── Worker handler ────────────────────────────────────────────────────────────

export const evaluationWorkerHandler = async (
  job: import('../queue').Job<{ applicationId: string }>,
) => {
  await evaluate(job.data.applicationId);
};
