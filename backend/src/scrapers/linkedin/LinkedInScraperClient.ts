/**
 * LinkedIn scraper abstraction — implementation lives in a separate microservice
 * (different git branch). Swap the client when the service is merged.
 */

import { config } from '../../config';
import type { ScrapeTier } from '../../utils/scrapeStorage';

export interface LinkedInCompanyCore {
  status: 'pending' | 'success' | 'unavailable';
  companyUrl: string;
  name?: string;
  industry?: string;
  employeeCount?: number;
  description?: string;
  scrapedAt?: string;
  message?: string;
}

export interface LinkedInFounderBackground {
  status: 'pending' | 'success' | 'unavailable';
  founders: Array<{
    name?: string;
    headline?: string;
    education?: string[];
    pastRoles?: string[];
    profileUrl?: string;
  }>;
  scrapedAt?: string;
  message?: string;
}

export interface LinkedInScraperClient {
  scrapeCompany(companyUrl: string): Promise<LinkedInCompanyCore>;
  scrapeFounders(profileUrls: string[]): Promise<LinkedInFounderBackground>;
}

/** Stub until the LinkedIn microservice branch is merged. */
export class LinkedInMicroserviceStub implements LinkedInScraperClient {
  async scrapeCompany(companyUrl: string): Promise<LinkedInCompanyCore> {
    return {
      status: 'pending',
      companyUrl,
      message:
        'LinkedIn microservice not integrated. Set LINKEDIN_SCRAPER_URL when the service is deployed.',
      scrapedAt: new Date().toISOString(),
    };
  }

  async scrapeFounders(profileUrls: string[]): Promise<LinkedInFounderBackground> {
    return {
      status: 'pending',
      founders: profileUrls.map((url) => ({ profileUrl: url })),
      message: 'LinkedIn founder scrape pending microservice integration.',
      scrapedAt: new Date().toISOString(),
    };
  }
}

/** Future: HTTP client calling LINKEDIN_SCRAPER_URL microservice. */
export class LinkedInHttpClient implements LinkedInScraperClient {
  constructor(private baseUrl: string) {}

  async scrapeCompany(companyUrl: string): Promise<LinkedInCompanyCore> {
    const res = await fetch(`${this.baseUrl}/scrape/company`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: companyUrl }),
    });
    if (!res.ok) throw new Error(`LinkedIn service error: ${res.status}`);
    return (await res.json()) as LinkedInCompanyCore;
  }

  async scrapeFounders(profileUrls: string[]): Promise<LinkedInFounderBackground> {
    const res = await fetch(`${this.baseUrl}/scrape/founders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: profileUrls }),
    });
    if (!res.ok) throw new Error(`LinkedIn service error: ${res.status}`);
    return (await res.json()) as LinkedInFounderBackground;
  }
}

export function getLinkedInScraperClient(): LinkedInScraperClient {
  const url = config.scraping.linkedinServiceUrl?.trim();
  if (url) return new LinkedInHttpClient(url.replace(/\/$/, ''));
  return new LinkedInMicroserviceStub();
}

export const LINKEDIN_SCRAPE_FILES = {
  direct_relation: 'linkedin_company_core.json',
  background: {
    founders: 'linkedin_founders_profiles.json',
    education: 'linkedin_founders_education.json',
    pastRoles: 'linkedin_founders_past_roles.json',
  },
} as const;

export function linkedInTierFor(file: string): ScrapeTier {
  return file === LINKEDIN_SCRAPE_FILES.direct_relation ? 'direct_relation' : 'background';
}
