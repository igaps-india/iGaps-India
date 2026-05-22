import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface AppRow {
  _id: string;
  email: string;
  founderName: string;
  startupName: string;
  status: string;
  createdAt: string;
}

const STATUS_BADGE: Record<string, string> = {
  intake: 'bg-gray-100 text-gray-600',
  questionnaire_closed: 'bg-blue-100 text-blue-600',
  questionnaire_uploads: 'bg-blue-100 text-blue-600',
  questionnaire_open: 'bg-indigo-100 text-indigo-600',
  evaluating: 'bg-yellow-100 text-yellow-700',
  passed: 'bg-green-100 text-green-700',
  passed_with_gaps: 'bg-emerald-100 text-emerald-700',
  priority: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-600',
  archived: 'bg-gray-100 text-gray-400',
};

export default function AdminApplicationsPage() {
  const [apps, setApps] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const token = localStorage.getItem('igaps_admin_token') ?? '';

  useEffect(() => {
    api.get<{ applications: AppRow[] }>('/admin/applications', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((d) => setApps(d.applications))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <p className="p-8 text-gray-400 animate-pulse">Loading applications…</p>;
  if (error) return <p className="p-8 text-red-600">{error}</p>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Applications</h1>
        <div className="flex gap-3">
          <Link
            to="/admin/knockouts"
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Knockout Rules
          </Link>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              {['Startup', 'Founder', 'Email', 'Status', 'Applied', ''].map((h) => (
                <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {apps.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-gray-400">
                  No applications yet.
                </td>
              </tr>
            )}
            {apps.map((app) => (
              <tr key={app._id} className="hover:bg-gray-50 transition">
                <td className="px-5 py-4 font-medium text-gray-900">{app.startupName}</td>
                <td className="px-5 py-4 text-gray-700">{app.founderName}</td>
                <td className="px-5 py-4 text-gray-500">{app.email}</td>
                <td className="px-5 py-4">
                  <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[app.status] ?? 'bg-gray-100 text-gray-500'}`}>
                    {app.status.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-5 py-4 text-gray-400 text-xs">
                  {new Date(app.createdAt).toLocaleDateString('en-IN')}
                </td>
                <td className="px-5 py-4">
                  <Link
                    to={`/admin/application/${app._id}`}
                    className="text-indigo-600 hover:underline text-xs font-medium"
                  >
                    View →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
