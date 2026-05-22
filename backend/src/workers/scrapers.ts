/**
 * Scraper worker jobs.
 * Each job reads application data, calls its respective API, and writes results
 * into Submission.scrapedData. On failure after maxAttempts, marks as 'unavailable'.
 *
 * Registration: call registerScrapers(queue) once at server boot.
 */

import axios from 'axios';
import { Application } from '../models/Application';
import { Submission } from '../models/Submission';
import { JobHandler, JobQueue } from '../queue';
import { config } from '../config';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSubmission(applicationId: string) {
  const app = await Application.findById(applicationId);
  if (!app) throw new Error(`Application ${applicationId} not found`);
  const sub = await Submission.findOne({ applicationId });
  if (!sub) throw new Error(`Submission for ${applicationId} not found`);
  return sub;
}

function unavailable(reason: string) {
  return { status: 'unavailable', reason, scrapedAt: new Date() };
}

async function githubApi<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.scraping.githubToken) {
    headers.Authorization = `Bearer ${config.scraping.githubToken}`;
  }
  const res = await axios.get<T>(`https://api.github.com${path}`, { headers, timeout: 20_000 });
  return res.data;
}

// ── LinkedIn via Proxycurl ────────────────────────────────────────────────────

export const linkedinHandler: JobHandler<{ applicationId: string; url: string }> = async (
  job,
) => {
  const { applicationId, url } = job.data;
  const sub = await getSubmission(applicationId);

  if (!config.scraping.proxycurlApiKey) {
    sub.scrapedData = { ...sub.scrapedData, linkedin: unavailable('PROXYCURL_API_KEY not set') };
    await sub.save();
    return;
  }

  try {
    const res = await axios.get('https://nubela.co/proxycurl/api/v2/linkedin/company', {
      params: { url, use_cache: 'if-recent' },
      headers: { Authorization: `Bearer ${config.scraping.proxycurlApiKey}` },
      timeout: 30_000,
    });
    sub.scrapedData = { ...sub.scrapedData, linkedin: res.data };
    await sub.save();
    console.info(`[Scraper] LinkedIn scraped for ${applicationId}`);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.scrapedData = { ...sub.scrapedData, linkedin: unavailable(msg) };
      await sub.save();
    }
    throw err;
  }
};

// ── GitHub via REST API ───────────────────────────────────────────────────────

export const githubHandler: JobHandler<{ applicationId: string; url: string }> = async (job) => {
  const { applicationId, url } = job.data;
  const sub = await getSubmission(applicationId);

  // Extract org/user name from URL: https://github.com/<org>
  const match = url.match(/github\.com\/([^/]+)/);
  if (!match) {
    sub.scrapedData = { ...sub.scrapedData, github: unavailable('Invalid GitHub URL') };
    await sub.save();
    return;
  }
  const org = match[1];

  try {
    const [orgData, reposData] = await Promise.allSettled([
      githubApi(`/orgs/${org}`).catch(() => githubApi(`/users/${org}`)),
      githubApi<Array<{ name: string; pushed_at: string | null }>>(
        `/orgs/${org}/repos?sort=updated&per_page=10`,
      ).catch(() =>
        githubApi<Array<{ name: string; pushed_at: string | null }>>(
          `/users/${org}/repos?sort=updated&per_page=10`,
        ),
      ),
    ]);

    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

    let commitsLast6m = 0;
    if (reposData.status === 'fulfilled') {
      const repos = reposData.value;
      for (const repo of repos.slice(0, 3)) {
        if (repo.pushed_at && repo.pushed_at > sixMonthsAgo) {
          try {
            const commits = await githubApi<unknown[]>(
              `/repos/${org}/${repo.name}/commits?since=${sixMonthsAgo}&per_page=1`,
            );
            commitsLast6m += commits.length;
          } catch {
            // ignore per-repo errors
          }
        }
      }
    }

    sub.scrapedData = {
      ...sub.scrapedData,
      github: {
        org: orgData.status === 'fulfilled' ? orgData.value : null,
        recentRepos: reposData.status === 'fulfilled' ? reposData.value.slice(0, 5) : [],
        commitsLast6mSample: commitsLast6m,
        scrapedAt: new Date(),
      },
    };
    await sub.save();
    console.info(`[Scraper] GitHub scraped for ${applicationId}`);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.scrapedData = { ...sub.scrapedData, github: unavailable(msg) };
      await sub.save();
    }
    throw err;
  }
};

// ── Zauba/MCA via SerpAPI ─────────────────────────────────────────────────────

export const zaubaHandler: JobHandler<{ applicationId: string; cin: string }> = async (job) => {
  const { applicationId, cin } = job.data;
  const sub = await getSubmission(applicationId);

  if (!config.scraping.serpapiKey) {
    sub.scrapedData = { ...sub.scrapedData, zauba: unavailable('SERPAPI_KEY not set') };
    await sub.save();
    return;
  }

  try {
    const res = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google',
        q: `${cin} site:zaubacorp.com OR site:mca.gov.in`,
        api_key: config.scraping.serpapiKey,
        num: 5,
      },
      timeout: 20_000,
    });

    const organicResults = res.data?.organic_results ?? [];

    sub.scrapedData = {
      ...sub.scrapedData,
      zauba: {
        cin,
        searchResults: organicResults.slice(0, 5),
        scrapedAt: new Date(),
        source: 'serpapi_google',
      },
    };
    await sub.save();
    console.info(`[Scraper] Zauba scraped for ${applicationId} (CIN: ${cin})`);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.scrapedData = { ...sub.scrapedData, zauba: unavailable(msg) };
      await sub.save();
    }
    throw err;
  }
};

// ── Press / News via SerpAPI ──────────────────────────────────────────────────

export const pressHandler: JobHandler<{
  applicationId: string;
  startupName: string;
  websiteUrl: string;
}> = async (job) => {
  const { applicationId, startupName, websiteUrl } = job.data;
  const sub = await getSubmission(applicationId);

  if (!config.scraping.serpapiKey) {
    sub.scrapedData = { ...sub.scrapedData, press: unavailable('SERPAPI_KEY not set') };
    await sub.save();
    return;
  }

  try {
    const domain = new URL(websiteUrl).hostname.replace('www.', '');

    const res = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google',
        q: `"${startupName}" OR site:${domain} funding OR launch OR AI startup India`,
        api_key: config.scraping.serpapiKey,
        tbm: 'nws', // news
        num: 10,
      },
      timeout: 20_000,
    });

    sub.scrapedData = {
      ...sub.scrapedData,
      press: {
        newsResults: res.data?.news_results ?? [],
        organicResults: (res.data?.organic_results ?? []).slice(0, 5),
        scrapedAt: new Date(),
      },
    };
    await sub.save();
    console.info(`[Scraper] Press scraped for ${applicationId}`);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.scrapedData = { ...sub.scrapedData, press: unavailable(msg) };
      await sub.save();
    }
    throw err;
  }
};

// ── Patents via SerpAPI ───────────────────────────────────────────────────────

export const patentsHandler: JobHandler<{
  applicationId: string;
  startupName: string;
}> = async (job) => {
  const { applicationId, startupName } = job.data;
  const sub = await getSubmission(applicationId);

  if (!config.scraping.serpapiKey) {
    sub.scrapedData = { ...sub.scrapedData, patents: unavailable('SERPAPI_KEY not set') };
    await sub.save();
    return;
  }

  try {
    const res = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google_patents',
        q: startupName,
        api_key: config.scraping.serpapiKey,
        num: 10,
      },
      timeout: 20_000,
    });

    sub.scrapedData = {
      ...sub.scrapedData,
      patents: {
        results: res.data?.organic_results ?? [],
        total: res.data?.search_information?.total_results ?? 0,
        scrapedAt: new Date(),
      },
    };
    await sub.save();
    console.info(`[Scraper] Patents scraped for ${applicationId}`);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.scrapedData = { ...sub.scrapedData, patents: unavailable(msg) };
      await sub.save();
    }
    throw err;
  }
};

// ── Registration ──────────────────────────────────────────────────────────────

export function registerScrapers(queue: JobQueue): void {
  queue.register('scrape:linkedin', linkedinHandler);
  queue.register('scrape:github', githubHandler);
  queue.register('scrape:zauba', zaubaHandler);
  queue.register('scrape:press', pressHandler);
  queue.register('scrape:patents', patentsHandler);
  console.info('[Scrapers] All scraper handlers registered');
}
