import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/** High-priority data used directly in evaluation scoring. */
export type ScrapeTier = 'direct_relation' | 'background';

export const SCRAPE_DATA_ROOT = join(process.cwd(), 'data', 'scraped');

export interface ScrapeManifestEntry {
  source: 'zauba' | 'linkedin' | 'pitch_deck';
  tier: ScrapeTier;
  file: string;
  scrapedAt: string;
  status: 'success' | 'unavailable' | 'pending';
}

export interface ScrapeManifest {
  applicationId: string;
  updatedAt: string;
  entries: ScrapeManifestEntry[];
}

export function scrapeAppDir(applicationId: string): string {
  return join(SCRAPE_DATA_ROOT, applicationId);
}

export function scrapeTierDir(applicationId: string, tier: ScrapeTier): string {
  return join(scrapeAppDir(applicationId), tier);
}

/** Ensure direct_relation/ and background/ exist for an application. */
export function ensureScrapeDirs(applicationId: string): void {
  mkdirSync(scrapeTierDir(applicationId, 'direct_relation'), { recursive: true });
  mkdirSync(scrapeTierDir(applicationId, 'background'), { recursive: true });
}

export function saveScrapedText(
  applicationId: string,
  tier: ScrapeTier,
  filename: string,
  text: string,
): string {
  ensureScrapeDirs(applicationId);
  const relativePath = join(tier, filename);
  const fullPath = join(scrapeAppDir(applicationId), relativePath);
  writeFileSync(fullPath, text, 'utf-8');
  return relativePath.replace(/\\/g, '/');
}

export async function saveScrapedData(
  applicationId: string,
  tier: ScrapeTier,
  filename: string,
  data: Record<string, unknown>,
): Promise<string> {
  ensureScrapeDirs(applicationId);
  const relativePath = join(tier, filename);
  const fullPath = join(scrapeAppDir(applicationId), relativePath);
  writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
  return relativePath.replace(/\\/g, '/');
}

export function loadScrapedData(
  applicationId: string,
  relativePath: string,
): Record<string, unknown> | null {
  const fullPath = join(scrapeAppDir(applicationId), relativePath);
  if (!existsSync(fullPath)) return null;
  return JSON.parse(readFileSync(fullPath, 'utf-8')) as Record<string, unknown>;
}

export function updateScrapeManifest(
  applicationId: string,
  entry: ScrapeManifestEntry,
): string {
  ensureScrapeDirs(applicationId);
  const manifestPath = join(scrapeAppDir(applicationId), 'scrape_manifest.json');

  let manifest: ScrapeManifest = {
    applicationId,
    updatedAt: new Date().toISOString(),
    entries: [],
  };

  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ScrapeManifest;
  }

  const idx = manifest.entries.findIndex(
    (e) => e.source === entry.source && e.tier === entry.tier && e.file === entry.file,
  );
  if (idx >= 0) manifest.entries[idx] = entry;
  else manifest.entries.push(entry);

  manifest.updatedAt = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return 'scrape_manifest.json';
}

/** Relative paths reserved for future scrapers (created empty on first intake). */
export const FUTURE_SCRAPE_SLOTS = {
  direct_relation: [
    'linkedin_company_core.json',
    'pitch_deck_traction.json',
  ],
  background: [
    'linkedin_founders_profiles.json',
    'linkedin_founders_education.json',
    'linkedin_founders_past_roles.json',
  ],
} as const;

/** Zauba output — single plain-text public summary for the intake CIN. */
export const ZAUBA_SUMMARY_FILE = 'zauba_company_summary.txt';

export function seedFutureScrapePlaceholders(applicationId: string): void {
  ensureScrapeDirs(applicationId);
  for (const tier of ['direct_relation', 'background'] as ScrapeTier[]) {
    for (const file of FUTURE_SCRAPE_SLOTS[tier]) {
      const fullPath = join(scrapeTierDir(applicationId, tier), file);
      if (existsSync(fullPath)) continue;
      writeFileSync(
        fullPath,
        JSON.stringify(
          {
            status: 'pending',
            message: `Placeholder — ${file.replace('.json', '')} scraper not integrated yet`,
            applicationId,
          },
          null,
          2,
        ),
        'utf-8',
      );
    }
  }
}
