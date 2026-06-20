import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface LinkedSignalScore {
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
  rawTextEvidence?: string | null;
  weakness?: string | null;
  scoringMethod?: string;
}

interface ClosedAnswerReview {
  questionId: string;
  questionText: string;
  hint?: string;
  answer: unknown;
  answerDisplay: string;
  linkedScores: LinkedSignalScore[];
}

interface OpenAnswerReview {
  slotKey: string;
  slotId: number;
  questionText: string;
  sourceIds: string[];
  answer: string;
  wordCount: number;
  linkedScores: LinkedSignalScore[];
}

interface EnrichedTraceEntry {
  nodeId: string;
  signalKey: string;
  nodeName: string;
  category: string;
  rawScore: number;
  normalizedScore: number;
  categoryMultiplier: number;
  siblingWeight: number;
  weightedContribution: number;
  llmEvidence?: string;
  llmWeaknesses?: string[];
  flags: string[];
  sourceType: string;
  sourceRef?: string;
  sourceQuestionText?: string;
  founderAnswer?: unknown;
  founderAnswerDisplay?: string;
  isGap: boolean;
  gapReason?: string;
  suggestedReviewerQuestion?: string;
  rawTextEvidence?: string | null;
  weakness?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  scoringMethod?: string;
  zodValidated?: boolean;
}

interface ReviewPayload {
  closedAnswers: ClosedAnswerReview[];
  openAnswers: OpenAnswerReview[];
  enrichedTrace: EnrichedTraceEntry[];
  consistencyChecks: Array<{ checkName: string; passed: boolean; description: string }>;
  contradictions: Array<{
    signal: string;
    description: string;
    severity: string;
    claimedValue?: unknown;
    scrapedValue?: unknown;
  }>;
}

interface EvaluationData {
  band: string;
  compositeScore: number;
  trackScores: { A: number; B: number; C: number; D: number };
  reconciliationAdjustments: Array<{ rule: string; applied: boolean; reason: string; multiplier?: number }>;
  knockoutsResult: {
    anyTriggered: boolean;
    evaluated: Array<{ id: string; triggered: boolean; severity: string; ruleTrace: string }>;
  };
  gapReport: {
    gaps: Array<{ nodeId: string; name: string; category: string; reason: string; suggestedReviewerQuestion: string }>;
  };
}

interface ApplicationData {
  email: string;
  founderName: string;
  coFounders?: string[];
  startupName: string;
  status: string;
  createdAt: string;
}

interface SubmissionData {
  closedAnswers: Record<string, unknown>;
  openAnswers: Record<string, string>;
  uploads: Array<{ originalName: string; type: string; parseStatus: string; r2Key: string }>;
  completedAt?: string;
}

const TRACK_NAMES: Record<string, string> = {
  A: 'Founding Team',
  B: 'Problem & Market',
  C: 'Solution',
  D: 'Traction',
};

const BAND_CONFIG: Record<string, { label: string; color: string }> = {
  priority: { label: 'Priority', color: 'text-amber-700 bg-amber-50' },
  passed: { label: 'Passed', color: 'text-green-700 bg-green-50' },
  passed_with_gaps: { label: 'Passed with gaps', color: 'text-emerald-700 bg-emerald-50' },
  not_passed: { label: 'Not passed', color: 'text-red-700 bg-red-50' },
};

export default function AdminApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [application, setApplication] = useState<ApplicationData | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationData | null>(null);
  const [submission, setSubmission] = useState<SubmissionData | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'answers' | 'trace' | 'gaps' | 'contradictions' | 'knockouts'>('overview');

  const token = localStorage.getItem('igaps_admin_token') ?? '';

  useEffect(() => {
    if (!id) return;
    api.get<{
      application: ApplicationData;
      evaluation: EvaluationData | null;
      submission: SubmissionData | null;
      review: ReviewPayload | null;
    }>(`/admin/applications/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((d) => {
        setApplication(d.application);
        setEvaluation(d.evaluation);
        setSubmission(d.submission);
        setReview(d.review);
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, token]);

  if (loading) return <p className="p-8 text-gray-400 animate-pulse">Loading…</p>;
  if (error) return <p className="p-8 text-red-600">{error}</p>;
  if (!application) return <p className="p-8 text-gray-500">Application not found.</p>;

  const bandConfig = evaluation ? BAND_CONFIG[evaluation.band] : null;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/admin/applications" className="text-sm text-indigo-600 hover:underline">
            ← All applications
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">{application.startupName}</h1>
          <p className="text-gray-500 text-sm">{application.founderName} · {application.email}</p>
        </div>
        {bandConfig && (
          <span className={`px-4 py-2 rounded-full text-sm font-semibold ${bandConfig.color}`}>
            {bandConfig.label}
          </span>
        )}
      </div>

      {evaluation && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Track Scores</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {(Object.entries(evaluation.trackScores) as [string, number][]).map(([k, v]) => (
              <div key={k} className="text-center p-4 bg-gray-50 rounded-xl">
                <div className="text-2xl font-black text-indigo-600">{Math.round(v)}%</div>
                <div className="text-xs text-gray-500 mt-1">Track {k}</div>
                <div className="text-xs text-gray-400">{TRACK_NAMES[k]}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 text-center">
            <span className="text-3xl font-black text-gray-900">{Math.round(evaluation.compositeScore)}%</span>
            <span className="text-gray-400 text-sm ml-2">composite score</span>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-100">
        {(['overview', 'answers', 'trace', 'gaps', 'contradictions', 'knockouts'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition ${
              activeTab === tab
                ? 'bg-white border border-b-white border-gray-100 text-indigo-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <Row label="Status" value={application.status.replace(/_/g, ' ')} />
            <Row label="Applied" value={new Date(application.createdAt).toLocaleString('en-IN')} />
            {application.coFounders && application.coFounders.length > 0 && (
              <Row label="Co-founders" value={application.coFounders.join(', ')} />
            )}
            {evaluation && (
              <>
                <Row label="Composite score" value={`${Math.round(evaluation.compositeScore)}%`} />
                <Row label="Band" value={evaluation.band.replace(/_/g, ' ')} />
                {evaluation.reconciliationAdjustments.filter((r) => r.applied).map((r) => (
                  <div key={r.rule} className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-sm">
                    <span className="font-medium text-amber-700">Reconciliation: {r.rule}</span>
                    <span className="text-amber-600 ml-2">— {r.reason}</span>
                    {r.multiplier && <span className="text-amber-600 ml-2">× {r.multiplier}</span>}
                  </div>
                ))}
              </>
            )}
            {!evaluation && <p className="text-gray-400 text-sm">Evaluation not yet completed.</p>}
          </div>
        )}

        {activeTab === 'answers' && (
          <div className="space-y-8 max-h-[750px] overflow-y-auto">
            {!review && <p className="text-gray-400 text-sm">No submission data found.</p>}

            {review && review.closedAnswers.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-3">
                  Closed questions ({review.closedAnswers.length})
                </h3>
                <div className="space-y-4">
                  {review.closedAnswers.map((item) => (
                    <AnswerCard
                      key={item.questionId}
                      label={item.questionId}
                      question={item.questionText}
                      hint={item.hint}
                      answerDisplay={item.answerDisplay}
                      linkedScores={item.linkedScores}
                    />
                  ))}
                </div>
              </section>
            )}

            {review && review.openAnswers.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-3">
                  Open questions ({review.openAnswers.length})
                </h3>
                <div className="space-y-4">
                  {review.openAnswers.map((item) => (
                    <AnswerCard
                      key={item.slotKey}
                      label={`${item.slotKey}${item.sourceIds.length ? ` · ${item.sourceIds.join(', ')}` : ''}`}
                      question={item.questionText}
                      answerDisplay={item.answer}
                      wordCount={item.wordCount}
                      linkedScores={item.linkedScores}
                    />
                  ))}
                </div>
              </section>
            )}

            {submission && submission.uploads?.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  Uploads ({submission.uploads.length})
                </h3>
                <ul className="space-y-2 text-sm">
                  {submission.uploads.map((u, i) => (
                    <li key={i} className="border border-gray-100 rounded-lg px-4 py-3 flex justify-between gap-4">
                      <span className="text-gray-800 truncate">{u.originalName}</span>
                      <span className="text-xs text-gray-400 shrink-0">{u.type} · {u.parseStatus}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {activeTab === 'trace' && (
          <div className="space-y-4 max-h-[750px] overflow-y-auto">
            {!review?.enrichedTrace.length && (
              <p className="text-gray-400 text-sm">No evaluation trace yet. Complete the questionnaire first.</p>
            )}

            {review && review.consistencyChecks.length > 0 && (
              <div className="border border-gray-100 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-semibold text-gray-800">Consistency checks</h3>
                {review.consistencyChecks.map((c) => (
                  <div key={c.checkName} className="flex items-start gap-2 text-sm">
                    <span className={`shrink-0 w-2 h-2 rounded-full mt-1.5 ${c.passed ? 'bg-green-500' : 'bg-red-500'}`} />
                    <div>
                      <span className="font-medium text-gray-800">{c.checkName}</span>
                      <p className="text-gray-500 text-xs">{c.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {review && review.contradictions.length > 0 && (
              <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-900">Contradictions</h3>
                {review.contradictions.map((c, i) => (
                  <p key={i} className="text-xs text-amber-800">
                    <span className="font-medium">{c.severity}:</span> {c.description}
                  </p>
                ))}
              </div>
            )}

            {review?.enrichedTrace.map((t) => (
              <div
                key={t.nodeId}
                className={`border rounded-lg p-4 text-sm ${
                  t.isGap ? 'border-red-200 bg-red-50/50' : 'border-gray-100 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900">{t.nodeName}</span>
                      <ScoringMethodBadge method={t.scoringMethod} />
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{t.signalKey}</p>
                  </div>
                  <ScoreBadge score={t.normalizedScore} max={100} />
                </div>

                <div className="flex flex-wrap gap-2 mt-2 text-xs text-gray-500">
                  <span className="px-2 py-0.5 bg-gray-100 rounded">{t.category}</span>
                  <span>weight {t.siblingWeight}%</span>
                  <span>×{t.categoryMultiplier} category</span>
                  <span>{t.sourceType}</span>
                  {t.sourceRef && <span className="text-indigo-600">ref: {t.sourceRef}</span>}
                  {t.confidence && (
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      t.confidence === 'high' ? 'bg-green-100 text-green-700' :
                      t.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-600'
                    }`}>
                      {t.confidence} confidence
                    </span>
                  )}
                  {t.zodValidated === false && t.scoringMethod === 'llm_rubric' && (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      ⚠ Schema failed
                    </span>
                  )}
                </div>

                {t.sourceQuestionText && (
                  <div className="mt-3 bg-indigo-50/50 border border-indigo-100 rounded-lg p-3">
                    <p className="text-xs font-medium text-indigo-700 mb-1">Question / source</p>
                    <p className="text-xs text-indigo-900">{t.sourceQuestionText}</p>
                  </div>
                )}

                {t.founderAnswerDisplay && t.founderAnswerDisplay !== '—' && (
                  <div className="mt-2 bg-gray-50 border border-gray-100 rounded-lg p-3">
                    <p className="text-xs font-medium text-gray-600 mb-1">Founder&apos;s answer</p>
                    <p className="text-xs text-gray-800 whitespace-pre-wrap line-clamp-6">
                      {t.founderAnswerDisplay}
                    </p>
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-gray-400">Raw</span> <span className="font-medium">{Math.round(t.rawScore)}/100</span></div>
                  <div><span className="text-gray-400">Normalized</span> <span className="font-medium">{Math.round(t.normalizedScore)}/100</span></div>
                  <div><span className="text-gray-400">Contribution</span> <span className="font-medium">{(t.weightedContribution * 100).toFixed(2)}%</span></div>
                  {t.flags.length > 0 && (
                    <div><span className="text-gray-400">Flags</span> <span className="font-medium">{t.flags.join(', ')}</span></div>
                  )}
                </div>

                {/* Raw Text Evidence (Zod-validated exact quote) */}
                {t.rawTextEvidence && t.rawTextEvidence !== 'N/A' && (
                  <div className="mt-2 bg-indigo-50 border border-indigo-100 rounded-lg p-3">
                    <p className="text-xs font-semibold text-indigo-700 mb-1">📌 Evidence quote (exact text used)</p>
                    <p className="text-xs text-indigo-900 italic">&ldquo;{t.rawTextEvidence}&rdquo;</p>
                  </div>
                )}

                {/* Weakness */}
                {t.weakness && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-gray-600">Weakness identified</p>
                    <p className="text-xs text-red-700 mt-0.5">{t.weakness}</p>
                  </div>
                )}

                {/* Legacy LLM evidence fallback */}
                {!t.rawTextEvidence && t.llmEvidence && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-gray-600">LLM evidence</p>
                    <p className="text-xs text-gray-700 italic mt-0.5">{t.llmEvidence}</p>
                  </div>
                )}

                {t.llmWeaknesses && t.llmWeaknesses.length > 0 && !t.weakness && (
                  <ul className="mt-1 list-disc list-inside text-xs text-red-600">
                    {t.llmWeaknesses.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}

                {t.isGap && t.gapReason && (
                  <p className="mt-2 text-xs text-red-700 bg-red-100/80 rounded px-2 py-1">{t.gapReason}</p>
                )}
                {t.suggestedReviewerQuestion && (
                  <p className="mt-1 text-xs text-indigo-700">→ {t.suggestedReviewerQuestion}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'gaps' && evaluation && (
          <div className="space-y-3">
            {evaluation.gapReport.gaps.length === 0 && (
              <p className="text-gray-400 text-sm">No significant gaps identified.</p>
            )}
            {evaluation.gapReport.gaps.map((g) => (
              <div key={g.nodeId} className="border border-red-100 bg-red-50 rounded-xl p-4 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-800 text-sm">{g.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{g.category}</span>
                </div>
                <p className="text-xs text-red-700">{g.reason}</p>
                <p className="text-xs text-indigo-700 font-medium">→ {g.suggestedReviewerQuestion}</p>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'contradictions' && (
          <div className="space-y-3">
            {(!review?.contradictions || review.contradictions.length === 0) && (
              <div className="text-center py-8">
                <p className="text-2xl mb-2">✅</p>
                <p className="text-gray-500 text-sm font-medium">No contradictions detected</p>
                <p className="text-gray-400 text-xs mt-1">Founder claims are consistent with scraped data</p>
              </div>
            )}
            {review?.contradictions.map((c, i) => (
              <div key={i} className={`border rounded-xl p-4 space-y-2 ${
                c.severity === 'high' ? 'border-red-300 bg-red-50' :
                c.severity === 'medium' ? 'border-amber-200 bg-amber-50' :
                'border-yellow-100 bg-yellow-50'
              }`}>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase ${
                    c.severity === 'high' ? 'bg-red-100 text-red-700' :
                    c.severity === 'medium' ? 'bg-amber-100 text-amber-700' :
                    'bg-yellow-100 text-yellow-700'
                  }`}>{c.severity}</span>
                  <span className="text-sm font-medium text-gray-800">{c.signal}</span>
                </div>
                <p className="text-xs text-gray-700">{c.description}</p>
                {'claimedValue' in c && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-white rounded p-2">
                      <p className="font-medium text-gray-500 mb-0.5">Claimed</p>
                      <p className="text-gray-800">{String(c.claimedValue)}</p>
                    </div>
                    <div className="bg-white rounded p-2">
                      <p className="font-medium text-gray-500 mb-0.5">Scraped</p>
                      <p className="text-gray-800">{String(c.scrapedValue)}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'knockouts' && evaluation && (
          <div className="space-y-3">
            {evaluation.knockoutsResult.evaluated.map((k) => (
              <div
                key={k.id}
                className={`border rounded-xl p-4 text-sm ${k.triggered ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${k.triggered ? 'bg-red-500' : 'bg-green-400'}`} />
                  <span className="font-medium text-gray-800">{k.id}</span>
                  {k.triggered && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">
                      TRIGGERED — {k.severity}
                    </span>
                  )}
                </div>
                {k.ruleTrace && <p className="text-xs text-gray-500 mt-1 ml-5">{k.ruleTrace}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreBadge({ score, max }: { score: number; max: number }) {
  const pct = Math.round(score);
  return (
    <span
      className={`px-2.5 py-1 rounded text-xs font-bold shrink-0 ${
        pct >= 70 ? 'bg-green-100 text-green-700' :
        pct >= 40 ? 'bg-yellow-100 text-yellow-700' :
        'bg-red-100 text-red-600'
      }`}
    >
      {pct} / {max}
    </span>
  );
}

function AnswerCard({
  label,
  question,
  hint,
  answerDisplay,
  wordCount,
  linkedScores,
}: {
  label: string;
  question: string;
  hint?: string;
  answerDisplay: string;
  wordCount?: number;
  linkedScores: LinkedSignalScore[];
}) {
  const avgScore =
    linkedScores.length > 0
      ? Math.round(linkedScores.reduce((s, x) => s + x.score, 0) / linkedScores.length)
      : null;

  return (
    <div className="border border-gray-100 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-indigo-600">{label}</p>
          <p className="text-sm font-semibold text-gray-900 mt-1">{question}</p>
          {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
        </div>
        {avgScore !== null && linkedScores.length > 0 && (
          <ScoreBadge score={avgScore} max={100} />
        )}
      </div>

      <div className="bg-gray-50 border border-gray-100 rounded-lg p-3">
        <p className="text-xs font-medium text-gray-500 mb-1">
          Founder&apos;s answer
          {wordCount !== undefined && ` · ${wordCount} words`}
        </p>
        <p className="text-sm text-gray-800 whitespace-pre-wrap">{answerDisplay}</p>
      </div>

      {linkedScores.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Signal scores from this answer</p>
          {linkedScores.map((s) => (
            <div key={s.signalKey} className="flex items-start justify-between gap-2 text-xs border-t border-gray-50 pt-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-medium text-gray-800">{s.nodeName}</p>
                  <ScoringMethodBadge method={s.scoringMethod} />
                </div>
                <p className="text-gray-400">{s.signalKey} · {s.category} · weight {s.siblingWeight}%</p>
                {s.rawTextEvidence && <p className="text-indigo-700 italic mt-0.5 line-clamp-2">📌 &ldquo;{s.rawTextEvidence}&rdquo;</p>}
                {!s.rawTextEvidence && s.llmEvidence && <p className="text-gray-600 italic mt-0.5 line-clamp-2">{s.llmEvidence}</p>}
                {s.weakness && <p className="text-red-600 mt-0.5 line-clamp-1">⚠ {s.weakness}</p>}
              </div>
              <ScoreBadge score={s.score} max={s.maxScore} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No scored signals linked to this question yet.</p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900">{value}</span>
    </div>
  );
}

function ScoringMethodBadge({ method }: { method?: string }) {
  if (!method || method === 'unknown') return null;
  const config: Record<string, { label: string; color: string }> = {
    llm_rubric: { label: 'LLM', color: 'bg-purple-100 text-purple-700' },
    vector_similarity: { label: 'Vector AI', color: 'bg-blue-100 text-blue-700' },
    closed_mapping: { label: 'Math', color: 'bg-gray-100 text-gray-600' },
    numeric_curve: { label: 'Math', color: 'bg-gray-100 text-gray-600' },
    scrape_threshold: { label: 'Scraper', color: 'bg-orange-100 text-orange-700' },
    derived_formula: { label: 'Formula', color: 'bg-teal-100 text-teal-700' },
  };
  const c = config[method] ?? { label: method, color: 'bg-gray-100 text-gray-500' };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c.color}`}>
      {c.label}
    </span>
  );
}
