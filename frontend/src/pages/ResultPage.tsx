import { useEffect, useState } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import { api, ApiError } from '@/lib/api';

type ResultStatus =
  | 'evaluating'
  | 'passed'
  | 'passed_with_gaps'
  | 'priority'
  | 'rejected'
  | 'error';

interface ResultData {
  status: ResultStatus;
  band?: string;
  compositeScore?: number;
  startupName?: string;
}

export default function ResultPage() {
  const { appId, token, isValid } = useAppContext();
  const [data, setData] = useState<ResultData>({ status: 'evaluating' });
  const [pollCount, setPollCount] = useState(0);

  useEffect(() => {
    if (!isValid) return;

    async function poll() {
      try {
        const result = await api.get<{
          status: string;
          band?: string;
          compositeScore?: number;
          startupName?: string;
        }>(`/applications/status?app=${appId}&token=${token}`);

        if (result.status === 'evaluating' || result.status === 'questionnaire_open') {
          setData({ status: 'evaluating' });
          setPollCount((c) => c + 1);
          setTimeout(poll, 5000); // poll every 5 seconds
        } else {
          setData({
            status: result.status as ResultStatus,
            band: result.band,
            compositeScore: result.compositeScore,
            startupName: result.startupName,
          });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setData({ status: 'error' });
          return;
        }
        // Retry on transient errors
        setTimeout(poll, 8000);
      }
    }

    poll();
  }, [appId, token, isValid]);

  if (!isValid) {
    return <Screen title="Invalid link" subtitle="Please use the link from your email." icon="❌" />;
  }

  if (data.status === 'evaluating') {
    return <EvaluatingScreen pollCount={pollCount} />;
  }

  if (data.status === 'rejected') {
    return (
      <Screen
        icon="○"
        iconColor="text-gray-400"
        title="Application not progressed"
        subtitle={`Thank you for applying, ${data.startupName ? `${data.startupName}. ` : ''}After a careful evaluation, we are unable to progress your application at this stage. We encourage you to continue building and consider reapplying in the future.`}
        extra="If you have any questions, please contact us at hello@igaps.in."
      />
    );
  }

  if (data.status === 'passed' || data.status === 'passed_with_gaps' || data.status === 'priority') {
    const isPriority = data.status === 'priority';
    return (
      <Screen
        icon={isPriority ? '★' : '✓'}
        iconColor={isPriority ? 'text-amber-500' : 'text-green-500'}
        iconBg={isPriority ? 'bg-amber-50' : 'bg-green-50'}
        title={isPriority ? 'Congratulations — Priority consideration' : 'Congratulations — Your application has passed'}
        subtitle={`Your startup${data.startupName ? ` (${data.startupName})` : ''} has been successfully evaluated. A member of the iGaps team will be in touch within 5 business days to discuss next steps.`}
        extra={
          data.status === 'passed_with_gaps'
            ? 'Note: Our evaluation identified some areas for further discussion. We will cover these in your first call.'
            : undefined
        }
      />
    );
  }

  return (
    <Screen
      title="Something went wrong"
      subtitle="We could not retrieve your application result. Please contact us at hello@igaps.in."
      icon="⚠"
      iconColor="text-yellow-500"
    />
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EvaluatingScreen({ pollCount }: { pollCount: number }) {
  const dots = '.'.repeat((pollCount % 3) + 1);
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6 bg-white rounded-2xl border border-gray-100 shadow-sm p-10">
        <div className="w-16 h-16 mx-auto rounded-full bg-indigo-50 flex items-center justify-center">
          <span className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin inline-block" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Evaluating your application{dots}</h2>
          <p className="text-gray-500 mt-2">
            Our evaluation engine is processing your answers. This typically takes 2–5 minutes.
            Please keep this page open.
          </p>
        </div>
        <div className="flex justify-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`w-2 h-2 rounded-full ${i === pollCount % 3 ? 'bg-indigo-500' : 'bg-gray-200'} transition-all`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Screen({
  icon,
  iconColor = 'text-indigo-600',
  iconBg = 'bg-indigo-50',
  title,
  subtitle,
  extra,
}: {
  icon: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle: string;
  extra?: string;
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5 bg-white rounded-2xl border border-gray-100 shadow-sm p-10">
        <div className={`w-16 h-16 mx-auto rounded-full ${iconBg} flex items-center justify-center`}>
          <span className={`text-3xl ${iconColor}`}>{icon}</span>
        </div>
        <h2 className="text-2xl font-bold text-gray-900">{title}</h2>
        <p className="text-gray-500 leading-relaxed">{subtitle}</p>
        {extra && <p className="text-sm text-gray-400 leading-relaxed">{extra}</p>}
        <a href="/" className="inline-block text-sm text-indigo-600 underline mt-4">
          Return to home
        </a>
      </div>
    </div>
  );
}
