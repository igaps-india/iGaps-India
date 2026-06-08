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

    const freshSub = await getSubmission(applicationId);
    freshSub.scrapedData = {
      ...freshSub.scrapedData,
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
    freshSub.markModified('scrapedData');
    await freshSub.save();

    console.info(
      `[Scraper][Zauba] Done for ${applicationId}\n` +
        `  direct_relation/${ZAUBA_SUMMARY_FILE} (${result.summaryText.length} chars)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][Zauba] Failed for ${applicationId}: ${msg}`);

    if (job.attempts >= job.maxAttempts) {
      const errSub = await getSubmission(applicationId);
      errSub.scrapedData = {
        ...errSub.scrapedData,
        zauba: { status: 'unavailable', reason: msg, cin, scrapedAt: new Date() },
      };
      errSub.markModified('scrapedData');
      await errSub.save();
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
  const app = await Application.findById(applicationId);
  if (!app) throw new Error('App not found');

  try {
    const res = await axios.post('http://127.0.0.1:8000/scrape/linkedin', {
      company_name: app.startupName,
      founder_name: app.founderName,
      linkedin_url: url,
      website_url: app.websiteUrl
    }, { timeout: 300_000 }); // 5 minutes timeout for scraping
    
    // Always save whatever the Python service returned (even partial data)
    const freshSub = await getSubmission(applicationId);
    freshSub.scrapedData = { ...freshSub.scrapedData, linkedin: { ...res.data, scrapedAt: new Date(), status: 'success' } };
    freshSub.markModified('scrapedData');
    await freshSub.save();
    console.info(`[Scraper] LinkedIn scraped for ${applicationId}`);
  } catch (err) {
    // Save error state immediately on every failure so MongoDB always has a linkedin key
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][LinkedIn] Failed for ${applicationId} (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`);
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = { ...errSub.scrapedData, linkedin: unavailable(msg) };
    errSub.markModified('scrapedData');
    await errSub.save();
    throw err;
  }
};

export const githubHandler: JobHandler<{ applicationId: string; url: string }> = async (job) => {
  const { applicationId, url } = job.data;
  const sub = await getSubmission(applicationId);

  const match = url.match(/github\.com\/([^/]+)/);
  if (!match) {
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = { ...errSub.scrapedData, github: unavailable('Invalid GitHub URL') };
    errSub.markModified('scrapedData');
    await errSub.save();
    return;
  }
  const org = match[1];

  try {
    const [orgData, reposData] = await Promise.allSettled([
      githubApi(`/orgs/${org}`).catch(() => githubApi(`/users/${org}`)),
      githubApi<Array<{ name: string; pushed_at: string | null; language: string | null; owner: { login: string } }>>(
        `/orgs/${org}/repos?sort=updated&per_page=10`,
      ).catch(() =>
        githubApi<Array<{ name: string; pushed_at: string | null; language: string | null; owner: { login: string } }>>(
          `/users/${org}/repos?sort=updated&per_page=10`,
        ),
      ),
    ]);

    let velocityCategory = 'none';
    let repoQualityCategory = 'none';
    let commitsPerWeek = 0;
    let qualityScore = 0;

    if (reposData.status === 'fulfilled' && reposData.value.length > 0) {
      // ── QUALITY SCORING LOGIC ──────────────────────────────────────────────
      // Fetch commits for top 3 recently active repos to limit API calls
      const topRepos = reposData.value.filter((r) => r.pushed_at).slice(0, 3);
      let allCommits: Array<{ commit: { message: string, author: { name: string, date: string } } }> = [];
      let realCodeFound = false;

      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      for (const repo of topRepos) {
        // Signal: Are they using real programming languages?
        if (repo.language && ['TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'JavaScript'].includes(repo.language)) {
          realCodeFound = true;
        }
        try {
          const commits = await githubApi<any[]>(`/repos/${repo.owner.login}/${repo.name}/commits?since=${since}&per_page=30`);
          allCommits = allCommits.concat(commits);
        } catch {
          // Ignore individual repo fetch errors (e.g. empty repo)
        }
      }

      // Signal 1: Meaningful commits (not just "update" or "fix")
      const meaningfulCommits = allCommits.filter((c) => {
        const msg = c.commit?.message?.toLowerCase() ?? '';
        return msg.length > 15 && !['update', 'test', 'fix', 'wip', 'init'].includes(msg.trim());
      });
      qualityScore += Math.min(40, meaningfulCommits.length * 2); // Max 40 points

      // Signal 2: Real code diversity
      if (realCodeFound) qualityScore += 30; // Max 30 points

      // Signal 3: Contributor diversity (not a 1-person bot)
      const uniqueAuthors = new Set(allCommits.map((c) => c.commit?.author?.name).filter(Boolean));
      qualityScore += Math.min(20, uniqueAuthors.size * 7); // Max 20 points

      qualityScore = Math.min(100, qualityScore);

      // Map to velocity bucket
      commitsPerWeek = allCommits.length / 13; // over 90 days (~13 weeks)
      if (commitsPerWeek > 15) velocityCategory = 'very_high';
      else if (commitsPerWeek >= 5) velocityCategory = 'high';
      else if (commitsPerWeek >= 1) velocityCategory = 'medium';
      else if (commitsPerWeek > 0) velocityCategory = 'low';

      // Map to repo quality bucket
      if (allCommits.length > 0) {
        if (qualityScore >= 75) repoQualityCategory = 'exists_high_activity';
        else if (qualityScore >= 45) repoQualityCategory = 'exists_active';
        else if (qualityScore >= 20) repoQualityCategory = 'exists_low_activity';
        else repoQualityCategory = 'exists_inactive';
      } else {
        repoQualityCategory = 'exists_inactive';
      }
    }

    const freshSub = await getSubmission(applicationId);
    freshSub.scrapedData = {
      ...freshSub.scrapedData,
      github: {
        org: orgData.status === 'fulfilled' ? orgData.value : null,
        recentRepos: reposData.status === 'fulfilled' ? reposData.value.slice(0, 5) : [],
        qualityScore,
        commitsPerWeek,
        scrapedAt: new Date(),
      },
      // Output buckets explicitly mapped to tree.yaml thresholds
      github_velocity: { status: velocityCategory },
      github_signals: { status: repoQualityCategory },
    };
    freshSub.markModified('scrapedData');
    await freshSub.save();
    console.info(`[Scraper] GitHub scraped for ${applicationId} | Quality: ${qualityScore} | Velocity: ${velocityCategory}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][GitHub] Failed for ${applicationId} (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`);
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = { 
      ...errSub.scrapedData, 
      github: unavailable(msg),
      github_velocity: unavailable(msg),
      github_signals: unavailable(msg)
    };
    errSub.markModified('scrapedData');
    await errSub.save();
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
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = { ...errSub.scrapedData, press: unavailable('SERPAPI_KEY not set') };
    errSub.markModified('scrapedData');
    await errSub.save();
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

    const freshSub = await getSubmission(applicationId);
    freshSub.scrapedData = {
      ...freshSub.scrapedData,
      press: {
        newsResults: res.data?.news_results ?? [],
        organicResults: (res.data?.organic_results ?? []).slice(0, 5),
        scrapedAt: new Date(),
      },
    };
    freshSub.markModified('scrapedData');
    await freshSub.save();
    console.info(`[Scraper] Press scraped for ${applicationId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][Press] Failed for ${applicationId} (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`);
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = { ...errSub.scrapedData, press: unavailable(msg) };
    errSub.markModified('scrapedData');
    await errSub.save();
    throw err;
  }
};

export const patentsHandler: JobHandler<{
  applicationId: string;
  startupName: string;
}> = async (job) => {
  const { applicationId, startupName } = job.data;
  const sub = await getSubmission(applicationId);
  const app = await Application.findById(applicationId);
  if (!app) throw new Error('App not found');

  try {
    const res = await axios.post('http://127.0.0.1:8000/scrape/google', {
      company_name: startupName,
      founder_name: app.founderName
    }, { timeout: 120_000 });

    const freshSub = await getSubmission(applicationId);
    freshSub.scrapedData = {
      ...freshSub.scrapedData,
      patents: {
        results: res.data.patents ?? [],
        total: res.data.patents?.length ?? 0,
        scrapedAt: new Date(),
      },
      licenses: {
        results: res.data.licenses ?? [],
        scrapedAt: new Date(),
      }
    };
    freshSub.markModified('scrapedData');
    await freshSub.save();
    console.info(`[Scraper] Patents & Licenses scraped for ${applicationId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scraper][Patents] Failed for ${applicationId} (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`);
    const errSub = await getSubmission(applicationId);
    errSub.scrapedData = {
      ...errSub.scrapedData,
      patents: unavailable(msg),
      licenses: unavailable(msg),
    };
    errSub.markModified('scrapedData');
    await errSub.save();
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
