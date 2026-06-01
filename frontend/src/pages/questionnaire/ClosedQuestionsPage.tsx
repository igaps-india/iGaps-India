import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '@/hooks/useAppContext';
import { api, ApiError } from '@/lib/api';

interface ClosedQOption { value: string; label: string }
interface ClosedQuestion {
  id: string;
  text: string;
  hint?: string;
  type: string;
  options?: ClosedQOption[];
  min?: number;
  max?: number;
  unit?: string;
  required: boolean;
  dependsOn?: { id: string; value: string };
}

type MoneyAnswer = { amount: number; currency: 'INR' | 'USD' };
type Answers = Record<string, unknown>;

function parseMoneyValue(value: unknown): MoneyAnswer {
  if (typeof value === 'object' && value !== null && 'amount' in value) {
    const v = value as MoneyAnswer;
    return {
      amount: typeof v.amount === 'number' ? v.amount : 0,
      currency: v.currency === 'USD' ? 'USD' : 'INR',
    };
  }
  if (typeof value === 'number') return { amount: value, currency: 'INR' };
  return { amount: 0, currency: 'INR' };
}

export default function ClosedQuestionsPage() {
  const { appId, token, isValid } = useAppContext();
  const navigate = useNavigate();

  const [questions, setQuestions] = useState<ClosedQuestion[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [currentGroup, setCurrentGroup] = useState(0);

  useEffect(() => {
    if (!isValid) { setError('Invalid link. Please use the link from your email.'); setLoading(false); return; }

    api.get<{ questions: ClosedQuestion[]; savedAnswers: Answers }>(
      `/questionnaire/closed?app=${appId}&token=${token}`
    )
      .then(({ questions: qs, savedAnswers }) => {
        setQuestions(qs);
        setAnswers(savedAnswers ?? {});
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [appId, token, isValid]);

  function setAnswer(id: string, value: unknown) {
    setAnswers(prev => ({ ...prev, [id]: value }));
  }

  // Auto-save every 30 seconds
  useEffect(() => {
    if (!isValid || Object.keys(answers).length === 0) return;
    const timer = setInterval(() => {
      api.post(`/questionnaire/closed?app=${appId}&token=${token}`, { answers }).catch(() => { });
    }, 30_000);
    return () => clearInterval(timer);
  }, [answers, appId, token, isValid]);

  async function submitAll() {
    setSaving(true);
    setError('');
    try {
      await api.post(`/questionnaire/closed?app=${appId}&token=${token}`, { answers });
      navigate(`/q/uploads?app=${appId}&token=${token}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Visible questions (respects dependsOn) ─────────────────────────────────
  const visible = questions.filter(q => {
    if (!q.dependsOn) return true;
    return answers[q.dependsOn.id] === q.dependsOn.value;
  });

  // Group visible questions into pages of 3
  const groups: ClosedQuestion[][] = [];
  for (let i = 0; i < visible.length; i += 3) groups.push(visible.slice(i, i + 3));

  const isLastGroup = currentGroup >= groups.length - 1;

  if (loading) return <ScreenLoader label="Loading your questionnaire…" />;
  if (error) return <ErrorScreen message={error} />;

  const currentQs = groups[currentGroup] ?? [];

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      {/* Progress */}
      <div className="max-w-2xl mx-auto mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">
            Step 1 of 3 — Structured Questions
          </span>
          <span className="text-sm text-gray-400">
            {currentGroup + 1} / {groups.length}
          </span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-2 bg-indigo-500 rounded-full transition-all"
            style={{ width: `${((currentGroup + 1) / groups.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Questions */}
      <div className="max-w-2xl mx-auto space-y-6">
        {currentQs.map(q => (
          <QuestionCard key={q.id} q={q} value={answers[q.id]} onChange={v => setAnswer(q.id, v)} />
        ))}

        {/* Navigation */}
        <div className="flex gap-3 justify-between pt-2">
          {currentGroup > 0 && (
            <button
              onClick={() => setCurrentGroup(g => g - 1)}
              className="px-6 py-3 rounded-lg border border-gray-200 text-gray-700 font-medium hover:bg-gray-50 transition"
            >
              Back
            </button>
          )}
          <div className="flex-1" />
          {!isLastGroup ? (
            <button
              onClick={() => setCurrentGroup(g => g + 1)}
              className="px-8 py-3 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={submitAll}
              disabled={saving}
              className="px-8 py-3 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-60 transition"
            >
              {saving ? 'Saving…' : 'Continue to Documents →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── QuestionCard ──────────────────────────────────────────────────────────────

function QuestionCard({
  q, value, onChange,
}: { q: ClosedQuestion; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
      <div>
        <p className="text-base font-semibold text-gray-900 leading-snug">{q.text}</p>
        {q.hint && <p className="text-sm text-gray-400 mt-1">{q.hint}</p>}
      </div>

      {(q.type === 'select_one' || q.type === 'boolean_branch') && q.options && (
        <div className="space-y-2">
          {q.options.map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${value === opt.value
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
                }`}
            >
              <input
                type="radio"
                name={q.id}
                value={opt.value}
                checked={value === opt.value}
                onChange={() => onChange(opt.value)}
                className="mt-0.5 accent-indigo-600"
              />
              <span className="text-sm text-gray-700">{opt.label}</span>
            </label>
          ))}
        </div>
      )}

      {q.type === 'select_many' && q.options && (
        <div className="space-y-2">
          {q.options.map(opt => {
            const selected = Array.isArray(value) ? (value as string[]).includes(opt.value) : false;
            return (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
              >
                <input
                  type="checkbox"
                  value={opt.value}
                  checked={selected}
                  onChange={e => {
                    const prev = Array.isArray(value) ? (value as string[]) : [];
                    onChange(
                      e.target.checked ? [...prev, opt.value] : prev.filter(v => v !== opt.value)
                    );
                  }}
                  className="mt-0.5 accent-indigo-600"
                />
                <span className="text-sm text-gray-700">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}

      {q.type === 'select_many_ranked' && q.options && (
        <div className="space-y-2">
          <p className="text-xs text-gray-400">Select all that apply. The order of selection determines your ranking.</p>
          {q.options.map(opt => {
            const selected = Array.isArray(value) ? (value as string[]).includes(opt.value) : false;
            const rank = Array.isArray(value) ? (value as string[]).indexOf(opt.value) + 1 : 0;
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
              >
                {selected && (
                  <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold shrink-0">
                    {rank}
                  </span>
                )}
                <input
                  type="checkbox"
                  value={opt.value}
                  checked={selected}
                  onChange={e => {
                    const prev = Array.isArray(value) ? (value as string[]) : [];
                    onChange(
                      e.target.checked ? [...prev, opt.value] : prev.filter(v => v !== opt.value)
                    );
                  }}
                  className={`accent-indigo-600 ${selected ? 'hidden' : ''}`}
                />
                <span className="text-sm text-gray-700">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}

      {q.type === 'number' && (
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={value as number ?? ''}
            min={q.min}
            max={q.max}
            onChange={e => onChange(Number(e.target.value))}
            className="w-40 px-4 py-3 rounded-lg border border-gray-200 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {q.unit && <span className="text-sm text-gray-500">{q.unit}</span>}
        </div>
      )}

      {q.type === 'number_with_currency' && (() => {
        const money = parseMoneyValue(value);
        return (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={money.currency}
              onChange={e => onChange({ ...money, currency: e.target.value as 'INR' | 'USD' })}
              className="px-4 py-3 rounded-lg border border-gray-200 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value="INR">INR (₹)</option>
              <option value="USD">USD ($)</option>
            </select>
            <input
              type="number"
              value={money.amount}
              min={q.min}
              max={q.max}
              onChange={e => onChange({ ...money, amount: Number(e.target.value) })}
              className="w-40 px-4 py-3 rounded-lg border border-gray-200 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <span className="text-sm text-gray-500">per customer (first 10)</span>
          </div>
        );
      })()}

      {q.type === 'text' && (
        <input
          type="text"
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          placeholder={q.hint ?? 'Enter your answer'}
          className="w-full px-4 py-3 rounded-lg border border-gray-200 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function ScreenLoader({ label }: { label: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-400 text-sm animate-pulse">{label}</p>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center space-y-3">
        <p className="text-red-600 font-medium">{message}</p>
        <a href="/" className="text-indigo-600 text-sm underline">Return to home</a>
      </div>
    </div>
  );
}
