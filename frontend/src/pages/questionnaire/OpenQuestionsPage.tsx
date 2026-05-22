import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '@/hooks/useAppContext';
import { api, ApiError } from '@/lib/api';

interface OpenQSlot {
  slotId: number;
  source: 'original' | 'merged' | 'generated';
  text: string;
  targetSignals: string[];
}

const MIN_WORDS = 50;

export default function OpenQuestionsPage() {
  const { appId, token, isValid } = useAppContext();
  const navigate = useNavigate();

  const [slots, setSlots] = useState<OpenQSlot[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentIdx, setCurrentIdx] = useState(0);
  const [probeText, setProbeText] = useState('');
  const [showProbe, setShowProbe] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!isValid) { setError('Invalid link.'); setLoading(false); return; }

    let cancelled = false;

    async function loadPlan(attempt = 0): Promise<void> {
      try {
        const data = await api.get<{ ready: boolean; slots?: OpenQSlot[]; degraded?: boolean; message?: string }>(
          `/questionnaire/open-plan?app=${appId}&token=${token}`
        );

        if (cancelled) return;

        if (data.ready && data.slots?.length) {
          setSlots(data.slots);
          setDegraded(data.degraded ?? false);
          setLoading(false);
          return;
        }

        if (attempt < 30) {
          await new Promise((r) => setTimeout(r, 3000));
          if (!cancelled) await loadPlan(attempt + 1);
          return;
        }

        setError(
          data.message ??
            'Your personalised questions are not ready yet. Please wait a moment and refresh, or go back to the documents step.',
        );
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load questions.');
        setLoading(false);
      }
    }

    loadPlan();
    return () => { cancelled = true; };
  }, [appId, token, isValid]);

  const current = slots[currentIdx];
  const answerKey = `slot_${current?.slotId}`;
  const currentAnswer = answers[answerKey] ?? '';
  const wordCount = currentAnswer.trim().split(/\s+/).filter(Boolean).length;
  const isTooShort = wordCount > 0 && wordCount < MIN_WORDS;
  const isLastSlot = currentIdx === slots.length - 1;

  function shouldShowProbe() {
    return isTooShort && !showProbe;
  }

  function handleContinue() {
    if (shouldShowProbe()) {
      setProbeText(
        'Your answer is quite brief. Could you expand on that? Specific details, examples, and context help us evaluate your startup more accurately.'
      );
      setShowProbe(true);
      return;
    }

    if (isLastSlot) {
      submitAll();
    } else {
      setCurrentIdx((i) => i + 1);
      setShowProbe(false);
      setProbeText('');
    }
  }

  async function submitAll() {
    setSaving(true);
    setError('');
    try {
      await api.post(`/questionnaire/open?app=${appId}&token=${token}`, { answers });
      navigate(`/result?app=${appId}&token=${token}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save answers. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <ScreenLoader label="Loading your questions…" />;
  if (error) return <ErrorScreen message={error} />;
  if (!current) {
    return (
      <ErrorScreen message="No questions available. Your question plan may still be generating — please refresh in a moment." />
    );
  }

  const progress = ((currentIdx + 1) / slots.length) * 100;

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      {/* Progress */}
      <div className="max-w-2xl mx-auto mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">
            Step 3 of 3 — Open Questions
          </span>
          <span className="text-sm text-gray-400">
            Question {currentIdx + 1} of {slots.length}
          </span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-2 bg-indigo-500 rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        {degraded && (
          <p className="text-xs text-amber-600 mt-2">
            Note: We are using our standard question set for your application.
          </p>
        )}
      </div>

      <div className="max-w-2xl mx-auto space-y-4">
        {/* Question card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 space-y-5">
          {/* Slot type badge */}
          {current.source === 'generated' && (
            <span className="inline-block px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium">
              Tailored to your startup
            </span>
          )}

          <p className="text-lg font-semibold text-gray-900 leading-snug">{current.text}</p>

          <div>
            <textarea
              value={currentAnswer}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [answerKey]: e.target.value }))}
              rows={8}
              placeholder="Please provide a detailed, specific answer. There is no word limit."
              className="w-full px-4 py-3 rounded-lg border border-gray-200 text-gray-900 text-sm leading-relaxed placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className={`text-xs ${isTooShort ? 'text-amber-600' : 'text-gray-400'}`}>
                {wordCount} word{wordCount !== 1 ? 's' : ''}
                {isTooShort && ` — aim for at least ${MIN_WORDS}`}
              </span>
              {currentAnswer.length > 0 && (
                <span className="text-xs text-green-600">Auto-saved</span>
              )}
            </div>
          </div>

          {/* Adaptive probe */}
          {showProbe && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium text-amber-800">{probeText}</p>
              <button
                onClick={() => {
                  setShowProbe(false);
                  if (isLastSlot) submitAll();
                  else { setCurrentIdx((i) => i + 1); }
                }}
                className="text-xs text-amber-700 underline"
              >
                My answer is complete — continue anyway
              </button>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-between pt-2">
            {currentIdx > 0 && (
              <button
                onClick={() => { setCurrentIdx((i) => i - 1); setShowProbe(false); }}
                className="px-5 py-3 rounded-lg border border-gray-200 text-gray-700 font-medium hover:bg-gray-50 transition"
              >
                Back
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={handleContinue}
              disabled={saving || currentAnswer.trim().length === 0}
              className="px-8 py-3 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {saving ? 'Submitting…' : isLastSlot ? 'Submit application →' : 'Next question →'}
            </button>
          </div>
        </div>

        {/* Sidebar hint */}
        <div className="bg-indigo-50 rounded-xl border border-indigo-100 p-5 text-sm text-indigo-800 space-y-1">
          <p className="font-medium">Tips for a strong answer</p>
          <ul className="list-disc list-inside space-y-1 text-indigo-700">
            <li>Use specific examples, names, and numbers where possible.</li>
            <li>Speak from your own direct experience — not general knowledge.</li>
            <li>There is no "right" answer — we are assessing your depth of understanding.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

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
