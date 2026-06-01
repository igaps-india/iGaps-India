/**
 * Manual ZaubaCorp scrape test.
 * Usage: npx tsx tools/test-zauba.ts <CIN>
 *
 * Example (real company):
 *   npm run test:zauba -- U72300MH1990PTC057141
 *
 * Note: QA seed CINs (e.g. U72900KA2022PTC145678) are fictional and will fail.
 */
import { scrapeZaubaCorp } from '../src/scrapers/zauba/zaubaScraper';

const cin = process.argv[2];
if (!cin) {
  console.error('Usage: npm run test:zauba -- <CIN>');
  process.exit(1);
}

scrapeZaubaCorp(cin.toUpperCase())
  .then((result) => {
    console.log(result.summaryText);
    console.error(`\n--- ${result.summaryText.length} chars → direct_relation/zauba_company_summary.txt ---`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
