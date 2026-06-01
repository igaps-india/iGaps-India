export interface ZaubaScrapeResult {
  cin: string;
  companyName: string;
  sourceUrl: string;
  scrapedAt: string;
  /** Plain-text public summary — primary scrape output for evaluation. */
  summaryText: string;
}
