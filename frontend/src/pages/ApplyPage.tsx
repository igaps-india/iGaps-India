import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface FormState {
  email: string;
  founderName: string;
  coFoundersCount: number;
  coFounders: string[];
  startupName: string;
  linkedinUrl: string;
  websiteUrl: string;
  cinNumber: string;
  githubUrl: string;
}

const INITIAL: FormState = {
  email: '',
  founderName: '',
  coFoundersCount: 0,
  coFounders: [],
  startupName: '',
  linkedinUrl: '',
  websiteUrl: '',
  cinNumber: '',
  githubUrl: '',
};

type PageState = 'form' | 'submitting';

export default function ApplyPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [pageState, setPageState] = useState<PageState>('form');
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  function handle(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setServerErrors([]);
    setPageState('submitting');

    try {
      const res = await api.post<{
        applicationId: string;
        token: string;
        continueUrl: string;
      }>('/applications', {
        ...form,
        githubUrl: form.githubUrl.trim() || undefined,
        coFounders: form.coFounders.filter((c) => c.trim().length > 0),
      });

      // Redirect immediately to the questionnaire — no waiting for email
      navigate(`/q/closed?app=${res.applicationId}&token=${res.token}`);
    } catch (err) {
      setPageState('form');
      if (err instanceof ApiError) {
        setServerErrors(err.errors?.length ? err.errors : [err.message]);
      } else {
        setServerErrors(['An unexpected error occurred. Please try again.']);
      }
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="max-w-lg mx-auto mb-8">
        <Link to="/" className="text-indigo-600 text-sm font-medium hover:underline">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-gray-900 mt-4">Apply for investment screening</h1>
        <p className="text-gray-500 mt-2">
          Provide the following information so we can begin evaluating your startup. After
          submitting, you will go straight to the questionnaire.
        </p>
      </div>

      {/* ── Form ────────────────────────────────────────────────── */}
      <form
        onSubmit={submit}
        className="max-w-lg mx-auto bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-6"
      >
        {/* Server errors */}
        {serverErrors.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm font-medium text-red-700 mb-1">
              Please correct the following:
            </p>
            <ul className="list-disc list-inside space-y-0.5">
              {serverErrors.map((e) => (
                <li key={e} className="text-sm text-red-600">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Field
          label="Email address"
          hint="We will also email you a link so you can resume later if you leave."
          required
        >
          <input
            type="email"
            value={form.email}
            onChange={handle('email')}
            placeholder="you@company.com"
            required
            className={inputCls}
          />
        </Field>

        <Field label="Founder's name" required>
          <input
            type="text"
            value={form.founderName}
            onChange={handle('founderName')}
            placeholder="e.g. Priya Sharma"
            required
            className={inputCls}
          />
        </Field>

        <Field label="Number of Co-founders">
          <select
            value={form.coFoundersCount}
            onChange={(e) => {
              const count = parseInt(e.target.value, 10);
              setForm((prev) => {
                const newCoFounders = [...prev.coFounders];
                while (newCoFounders.length < count) newCoFounders.push('');
                newCoFounders.length = count;
                return { ...prev, coFoundersCount: count, coFounders: newCoFounders };
              });
            }}
            className={inputCls}
          >
            <option value={0}>0 (Just me)</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </Field>

        {form.coFounders.map((cf, idx) => (
          <Field key={idx} label={`Co-founder ${idx + 1} name`} required>
            <input
              type="text"
              value={cf}
              onChange={(e) => {
                const newCoFounders = [...form.coFounders];
                newCoFounders[idx] = e.target.value;
                setForm((prev) => ({ ...prev, coFounders: newCoFounders }));
              }}
              placeholder={`e.g. Co-founder ${idx + 1}`}
              required
              className={inputCls}
            />
          </Field>
        ))}

        <Field label="Startup name" required>
          <input
            type="text"
            value={form.startupName}
            onChange={handle('startupName')}
            placeholder="e.g. Acme AI"
            required
            className={inputCls}
          />
        </Field>

        <Field
          label="Startup LinkedIn URL"
          hint="Company page URL, not your personal profile."
          required
        >
          <input
            type="url"
            value={form.linkedinUrl}
            onChange={handle('linkedinUrl')}
            placeholder="https://linkedin.com/company/acme-ai"
            required
            className={inputCls}
          />
        </Field>

        <Field label="Startup website" required>
          <input
            type="url"
            value={form.websiteUrl}
            onChange={handle('websiteUrl')}
            placeholder="https://acme.ai"
            required
            className={inputCls}
          />
        </Field>

        <Field
          label="CIN number"
          hint="21-character Corporate Identification Number from MCA (e.g. L12345AB1234AB123456)."
          required
        >
          <input
            type="text"
            value={form.cinNumber}
            onChange={handle('cinNumber')}
            placeholder="L12345AB1234AB123456"
            required
            maxLength={21}
            className={`${inputCls} uppercase`}
          />
        </Field>

        <Field
          label="GitHub organisation URL"
          hint="Optional — helps us evaluate your technical work."
        >
          <input
            type="url"
            value={form.githubUrl}
            onChange={handle('githubUrl')}
            placeholder="https://github.com/acme-ai"
            className={inputCls}
          />
        </Field>

        <div className="pt-2">
          <button
            type="submit"
            disabled={pageState === 'submitting'}
            className="w-full py-3.5 rounded-xl bg-indigo-600 text-white font-semibold text-base hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {pageState === 'submitting' ? 'Starting questionnaire…' : 'Continue to questionnaire →'}
          </button>
          <p className="text-xs text-gray-400 text-center mt-3">
            By submitting, you agree that iGaps may process the above information as part of the
            screening process.
          </p>
        </div>
      </form>
    </div>
  );
}

// ── Helper components ──────────────────────────────────────────────────────────

const inputCls =
  'w-full px-4 py-3 rounded-lg border border-gray-200 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
      {children}
    </div>
  );
}
