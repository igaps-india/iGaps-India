import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from '../../config';
import type { ZaubaScrapeResult } from './types';
import { buildPublicZaubaSummary } from './zaubaPublicSummary';

puppeteer.use(StealthPlugin());

async function fetchWithAxios(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: 25_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
    });
    const html = res.data as string;
    if (html.includes('cf-browser-verification') || html.length < 500) return null;
    return html;
  } catch {
    return null;
  }
}

async function fetchWithPuppeteer(cin: string): Promise<{ html: string; url: string }> {
  const base = config.scraping.zaubaBaseUrl.replace(/\/$/, '');
  const cinUpper = cin.toUpperCase();
  const searchUrls = [
    `${base}/search?q=${encodeURIComponent(cinUpper)}`,
    `${base}/?search=${encodeURIComponent(cinUpper)}`,
    base,
  ];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 800 });

    let companyUrl: string | null = null;

    for (const searchUrl of searchUrls) {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

      companyUrl = await page.$$eval(
        'a[href]',
        (links, targetCin) => {
          const target = String(targetCin).toUpperCase();
          const candidates = links
            .map((a) => ({ href: a.href, text: (a.textContent ?? '').toUpperCase() }))
            .filter(
              (l) =>
                l.href.toUpperCase().includes(target) &&
                !l.href.includes('/company-list') &&
                !l.href.includes('/search'),
            );

          const exact =
            candidates.find((l) => l.href.toUpperCase().endsWith(target)) ??
            candidates.find(
              (l) => l.href.toUpperCase().includes('/company/') && l.href.toUpperCase().includes(target),
            ) ??
            candidates.find((l) => l.text.includes(target)) ??
            candidates[0];

          return exact?.href ?? null;
        },
        cinUpper,
      );

      if (companyUrl) break;

      const searchInput = await page.$(
        'input[type="search"], input[name="search"], input[placeholder*="CIN" i], input[placeholder*="company" i], #search',
      );
      if (searchInput) {
        await searchInput.click({ count: 3 });
        await searchInput.type(cinUpper, { delay: 30 });
        await page.keyboard.press('Enter');
        await page.waitForNetworkIdle({ timeout: 30_000 }).catch(() => {});

        companyUrl = await page.$$eval(
          'a[href]',
          (links, targetCin) => {
            const target = String(targetCin).toUpperCase();
            const match = links.find((a) => a.href.toUpperCase().includes(target));
            return match?.href ?? null;
          },
          cinUpper,
        );
        if (companyUrl) break;
      }
    }

    if (!companyUrl) {
      throw new Error(
        `CIN ${cinUpper} not found on ZaubaCorp. Verify the CIN is registered with MCA.`,
      );
    }

    await page.goto(companyUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

    const finalUrl = page.url();
    const html = await page.content();

    if (!html.toUpperCase().includes(cinUpper)) {
      throw new Error(`ZaubaCorp returned a page without CIN ${cinUpper}.`);
    }

    return { html, url: finalUrl };
  } finally {
    await browser.close();
  }
}

export async function fetchZaubaHtml(cin: string): Promise<{ html: string; url: string }> {
  const base = config.scraping.zaubaBaseUrl.replace(/\/$/, '');
  const cinUpper = cin.toUpperCase();

  const searchPageHtml = await fetchWithAxios(`${base}/search?q=${encodeURIComponent(cinUpper)}`);
  if (searchPageHtml) {
    const $ = cheerio.load(searchPageHtml);
    let companyHref: string | undefined;
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (href.toUpperCase().includes(cinUpper) && !href.includes('/company-list')) {
        companyHref = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`;
        return false;
      }
    });
    if (companyHref) {
      const pageHtml = await fetchWithAxios(companyHref);
      if (pageHtml && pageHtml.toUpperCase().includes(cinUpper)) {
        return { html: pageHtml, url: companyHref };
      }
    }
  }

  return fetchWithPuppeteer(cinUpper);
}

export async function scrapeZaubaCorp(cin: string): Promise<ZaubaScrapeResult> {
  const { html, url } = await fetchZaubaHtml(cin);
  const targetCin = cin.toUpperCase();
  const summaryText = buildPublicZaubaSummary(html, targetCin);
  const $ = cheerio.load(html);
  const companyName =
    $('h1')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown Company';

  return {
    cin: targetCin,
    companyName,
    sourceUrl: url,
    scrapedAt: new Date().toISOString(),
    summaryText,
  };
}

export { buildPublicZaubaSummary } from './zaubaPublicSummary';
