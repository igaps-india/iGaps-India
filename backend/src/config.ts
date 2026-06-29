import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  frontendUrl: optional('FRONTEND_URL', 'http://localhost:5173'),
  appName: optional('APP_NAME', 'iGaps'),

  mongodb: {
    uri: optional('MONGODB_URI', 'mongodb://localhost:27017/igaps'),
  },

  auth: {
    jwtSecret: optional('JWT_SECRET', 'dev_secret_change_in_prod_must_be_64_chars_long_at_minimum'),
    jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),
    magicLinkExpiresMinutes: parseInt(optional('MAGIC_LINK_EXPIRES_MINUTES', '20160'), 10), // 14 days
  },

  email: {
    resendApiKey: optional('RESEND_API_KEY', ''),
    from: optional('EMAIL_FROM', 'noreply@igaps.in'),
  },

  storage: {
    r2AccountId: optional('R2_ACCOUNT_ID', ''),
    r2AccessKeyId: optional('R2_ACCESS_KEY_ID', ''),
    r2SecretAccessKey: optional('R2_SECRET_ACCESS_KEY', ''),
    r2BucketName: optional('R2_BUCKET_NAME', 'igaps-uploads'),
    r2PublicUrl: optional('R2_PUBLIC_URL', ''),
  },

  llm: {
    provider: optional('LLM_PROVIDER', 'gemini') as 'gemini' | 'openai',
    geminiApiKey: optional('GEMINI_API_KEY', ''),
    geminiModel: optional('GEMINI_MODEL', 'gemini-2.5-pro'),
    geminiModelRubric: optional('GEMINI_MODEL_RUBRIC', 'gemini-2.5-pro'),
    geminiModelAgent: optional('GEMINI_MODEL_AGENT', 'gemini-2.5-pro'),
  },

  scraping: {
    proxycurlApiKey: optional('PROXYCURL_API_KEY', ''),
    serpapiKey: optional('SERPAPI_KEY', ''),
    githubToken: optional('GITHUB_TOKEN', ''),
    zaubaBaseUrl: optional('ZAUBA_BASE_URL', 'https://www.zaubacorp.com'),
    /** Future LinkedIn microservice base URL (separate git branch). */
    linkedinServiceUrl: optional('LINKEDIN_SCRAPER_URL', ''),
  },

  queue: {
    provider: optional('QUEUE_PROVIDER', 'inmemory') as 'inmemory' | 'valkey',
    valkeyUrl: optional('VALKEY_URL', 'redis://localhost:6379'),
  },

  scoring: {
    defaultPassThreshold: parseInt(optional('DEFAULT_PASS_THRESHOLD', '40'), 10),
  },

  features: {
    /**
     * KNN-grounded signal scoring.
     * When true, llm_rubric signals embed the founder's answer and retrieve the
     * K nearest labeled examples from SignalExample as grounding context.
     * When false (default), falls back to the static RAGRetriever EXAMPLE_BANK.
     *
     * Rollout: enable in staging first, review 5–10 evaluations manually,
     * then enable in production. Never enable before running backfillSignalExamples.ts.
     */
    knnGroundingEnabled: optional('KNN_GROUNDING_ENABLED', 'false') === 'true',

    /**
     * Base URL of the Python scoring/scraping microservice.
     * The /embed, /score/vector, /scrape/* endpoints all live here.
     */
    pythonMicroserviceUrl: optional('PYTHON_MICROSERVICE_URL', 'http://127.0.0.1:8000'),
  },
} as const;

// Validate required envs for production
if (config.nodeEnv === 'production') {
  required('JWT_SECRET');
  required('MONGODB_URI');
  required('RESEND_API_KEY');
  required('GEMINI_API_KEY');
}
