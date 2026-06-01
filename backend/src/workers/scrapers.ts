/**
 * Scraper worker jobs — Zauba saves one plain-text public summary per CIN.
 */

import axios from 'axios';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Application } from '../models/Application';
import { Submission } from '../models/Submission';
import { JobHandler, JobQueue } from '../queue';
import { config } from '../config';
import { scrapeZaubaCorp } from '../scrapers/zauba/zaubaScraper';
import {
  saveScrapedText,
  updateScrapeManifest,
  seedFutureScrapePlaceholders,
  scrapeAppDir,
  ZAUBA_SUMMARY_FILE,
} from '../utils/scrapeStorage';

const LEGACY_ZAUBA_FILES = [
  'direct_relation/zauba_company_master.json',
  'background/zauba_directors.json',
  'background/zauba_charges.json',
  'background/zauba_financials.json',
  'background/zauba_all_tables.json',
];

function removeLegacyZaubaFiles(applicationId: string): void {
  for (const rel of LEGACY_ZAUBA_FILES) {
    const full = join(scrapeAppDir(applicationId), rel);
    if (existsSync(full)) unlinkSync(full);
  }
}

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

export const zaubaHandler: JobHandler<{ applicationId: string; cin: string }> = async (job) => {
  const { applicationId, cin } = job.data;
  const sub = await getSubmission(applicationId);

  seedFutureScrapePlaceholders(applicationId);

  try {
    console.info(`[Scraper][Zauba] Starting scrape for ${applicationId} (CIN: ${cin})`);

    const result = await scrapeZaubaCorp(cin);
    const summaryPath = saveScrapedText(
      applicationId,
      'direct_relation',
      ZAUBA_SUMMARY_FILE,
      result.summaryText,
    );

    removeLegacyZaubaFiles(applicationId);

    const scrapedAt = result.scrapedAt;
    updateScrapeManifest(applicationId, {
      source: 'zauba',
      tier: 'direct_relation',
      file: ZAUBA_SUMMARY_FILE,
      scrapedAt,
      status: 'success',
    });

    sub.scrapedData = {
      ...sub.scrapedData,
      zauba: {
        status: 'success',
        cin: result.cin,
        companyName: result.companyName,
        sourceUrl: result.sourceUrl,
        summaryPath,
        summaryCharCount: result.summaryText.length,
        scrapedAt: new Date(),
      },
    };
    await sub.save();

    console.info(
      `[Scraper][Zauba] Done for ${applicationId}\n` +
        `  direct_relation/${ZAUBA_SUMMARY_FILE} (${result.summaryText.length} chars)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][Zauba] Failed for ${applicationId}: ${msg}`);

    if (job.attempts >= job.maxAttempts) {
      sub.scrapedData = {
        ...sub.scrapedData,
        zauba: { status: 'unavailable', reason: msg, cin, scrapedAt: new Date() },
      };
      await sub.save();
      updateScrapeManifest(applicationId, {
        source: 'zauba',
        tier: 'direct_relation',
        file: ZAUBA_SUMMARY_FILE,
        scrapedAt: new Date().toISOString(),
        status: 'unavailable',
      });
    }
    throw err;
  }
};

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

export const githubHandler: JobHandler<{ applicationId: string; url: string }> = async (job) => {
  const { applicationId, url } = job.data;
  const sub = await getSubmission(applicationId);

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

    sub.scrapedData = {
      ...sub.scrapedData,
      github: {
        org: orgData.status === 'fulfilled' ? orgData.value : null,
        recentRepos: reposData.status === 'fulfilled' ? reposData.value.slice(0, 5) : [],
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
        tbm: 'nws',
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

export function registerScrapers(queue: JobQueue): void {
  queue.register('scrape:zauba', zaubaHandler);
  queue.register('scrape:linkedin', linkedinHandler);
  queue.register('scrape:github', githubHandler);
  queue.register('scrape:press', pressHandler);
  queue.register('scrape:patents', patentsHandler);
  console.info('[Scrapers] Handlers registered (Zauba → plain-text summary on intake)');
}
