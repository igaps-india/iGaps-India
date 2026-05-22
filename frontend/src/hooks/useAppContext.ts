import { useSearchParams } from 'react-router-dom';

export interface AppContext {
  appId: string;
  token: string;
  isValid: boolean;
}

/** Reads ?app=...&token=... from the URL for questionnaire pages. */
export function useAppContext(): AppContext {
  const [params] = useSearchParams();
  const appId = params.get('app') ?? '';
  const token = params.get('token') ?? '';
  return { appId, token, isValid: Boolean(appId && token) };
}
