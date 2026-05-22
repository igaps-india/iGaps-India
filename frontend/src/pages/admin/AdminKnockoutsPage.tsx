import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface KnockoutRow {
  knockoutId: string;
  name: string;
  enabled: boolean;
  severity: 'hard_stop' | 'route_to_human' | 'warn_only';
  notes?: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  hard_stop: 'bg-red-100 text-red-700',
  route_to_human: 'bg-amber-100 text-amber-700',
  warn_only: 'bg-blue-100 text-blue-700',
};

export default function AdminKnockoutsPage() {
  const [knockouts, setKnockouts] = useState<KnockoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const token = localStorage.getItem('igaps_admin_token') ?? '';

  useEffect(() => {
    api.get<{ knockouts: KnockoutRow[] }>('/admin/knockouts', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((d) => setKnockouts(d.knockouts))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function save(id: string, patch: Partial<KnockoutRow>) {
    setSaving(id);
    setError('');
    setSuccessMsg('');
    try {
      await api.patch(`/admin/knockouts/${id}`, patch, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setKnockouts((prev) =>
        prev.map((k) => (k.knockoutId === id ? { ...k, ...patch } : k))
      );
      setSuccessMsg(`Saved changes to ${id}.`);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <p className="p-8 text-gray-400 animate-pulse">Loading knockout rules…</p>;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <Link to="/admin/applications" className="text-sm text-indigo-600 hover:underline">
          ← Applications
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Knockout Rules</h1>
        <p className="text-gray-500 text-sm mt-1">
          Toggle enabled/disabled, change severity, and add reviewer notes. Rule expressions are
          managed in <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">backend/src/seed/knockouts.yaml</code> and applied on reseed.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          {error}
        </p>
      )}
      {successMsg && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
          {successMsg}
        </p>
      )}

      <div className="space-y-4">
        {knockouts.map((ko) => (
          <div
            key={ko.knockoutId}
            className={`bg-white rounded-2xl border shadow-sm p-6 space-y-4 ${
              ko.enabled ? 'border-gray-100' : 'border-gray-100 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-900">{ko.knockoutId}</span>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${SEVERITY_COLORS[ko.severity] ?? 'bg-gray-100 text-gray-500'}`}>
                    {ko.severity.replace(/_/g, ' ')}
                  </span>
                  {!ko.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium">
                      disabled
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">{ko.name}</p>
              </div>

              {/* Toggle enabled */}
              <button
                onClick={() => save(ko.knockoutId, { enabled: !ko.enabled })}
                disabled={saving === ko.knockoutId}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  ko.enabled
                    ? 'bg-red-50 text-red-600 hover:bg-red-100'
                    : 'bg-green-50 text-green-700 hover:bg-green-100'
                }`}
              >
                {saving === ko.knockoutId ? '…' : ko.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>

            {/* Severity */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-600 w-20">Severity</label>
              <select
                value={ko.severity}
                onChange={(e) => save(ko.knockoutId, { severity: e.target.value as KnockoutRow['severity'] })}
                disabled={saving === ko.knockoutId}
                className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="hard_stop">Hard stop</option>
                <option value="route_to_human">Route to human</option>
                <option value="warn_only">Warn only</option>
              </select>
            </div>

            {/* Notes */}
            <div>
              <label className="text-sm font-medium text-gray-600 block mb-1">Reviewer notes</label>
              <NotesEditor
                initial={ko.notes ?? ''}
                onSave={(notes) => save(ko.knockoutId, { notes })}
                saving={saving === ko.knockoutId}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-400">
        Rule expressions (boolean DSL) are defined in{' '}
        <code className="bg-gray-100 px-1 rounded">backend/src/seed/knockouts.yaml</code>.
        Run <code className="bg-gray-100 px-1 rounded">npm run seed</code> in the backend to apply
        YAML changes.
      </p>
    </div>
  );
}

function NotesEditor({
  initial,
  onSave,
  saving,
}: {
  initial: string;
  onSave: (notes: string) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState(initial);
  const dirty = value !== initial;

  return (
    <div className="space-y-1.5">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={2}
        placeholder="Optional notes for reviewers…"
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
      />
      {dirty && (
        <button
          onClick={() => onSave(value)}
          disabled={saving}
          className="text-xs text-indigo-600 font-medium hover:underline disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save notes'}
        </button>
      )}
    </div>
  );
}
