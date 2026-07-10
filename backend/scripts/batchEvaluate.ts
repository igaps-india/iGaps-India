/**
 * batchEvaluate.ts  — v3 (KNN + MongoDB grounding)
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads companies from CSV + PDFs, runs the FULL scoring pipeline:
 *   - closed_mapping, numeric_curve
 *   - llm_rubric via Gemini (with KNN grounding from MongoDB SignalExamples)
 *   - vector_similarity via Python microservice
 *
 * KNN grounding: for each LLM rubric signal, the answer is embedded and the
 * 9 injected benchmark companies are queried for nearest neighbours.
 * Those neighbours are injected into the Gemini prompt exactly as the live
 * evaluationEngine does. Falls back to static RAG bank if MongoDB is offline
 * or no qualifying neighbours are found.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json --transpile-only scripts/batchEvaluate.ts
 *
 * Output:
 *   data/test_batch/results.json   — full signal trace for every company
 *   Console                         — ranked summary table
 */

import 'dotenv/config';
import * as fs   from 'fs';
import * as path from 'path';
import * as dns  from 'dns';
import { parse } from 'csv-parse/sync';
import pdfParse  from 'pdf-parse';
import axios     from 'axios';
import yaml      from 'js-yaml';
import mongoose  from 'mongoose';

// Force IPv4 resolution to prevent 'fetch failed' errors on Windows with broken IPv6
dns.setDefaultResultOrder('ipv4first');

// ── MongoDB + KNN (lazy imports so the script still works offline) ─────────────
let knnEnabled = false;
let getKNNExamplesFn: typeof import('../src/services/KNNRetriever').getKNNExamples | null = null;
let embedTextFn: typeof import('../src/services/embeddingClient').embedText | null = null;

async function connectMongo(): Promise<void> {
  try {
    const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/igaps';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
    // Register models AFTER connecting so mongoose doesn't complain
    await import('../src/models/SignalExample');
    const knnMod = await import('../src/services/KNNRetriever');
    const embedMod = await import('../src/services/embeddingClient');
    getKNNExamplesFn = knnMod.getKNNExamples;
    embedTextFn      = embedMod.embedText;
    knnEnabled = true;
    console.log('  🔌 MongoDB connected — KNN grounding ENABLED');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ⚠️  MongoDB unavailable (${msg.slice(0, 80)}). KNN disabled — falling back to static RAG bank.`);
    knnEnabled = false;
  }
}

async function fetchKNN(
  answerText: string,
  signalKey: string,
): Promise<import('../src/services/KNNRetriever').KNNNeighbor[]> {
  if (!knnEnabled || !getKNNExamplesFn || !embedTextFn) return [];
  if (!answerText?.trim() || answerText.trim().length < 20) return [];
  try {
    const { embedding } = await embedTextFn(answerText);
    return await getKNNExamplesFn(embedding, signalKey, {
      k: 3,
      similarityThreshold: 0.0, // Set to 0.0 to ensure we always get the top 3 most relevant calibration examples
    });
  } catch (e) {
    console.error('KNN Fetch Error:', e);
    return [];
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT          = path.join(process.cwd());
const TEST_DIR      = path.join(ROOT, 'data', 'test_batch');
const CSV_PATH      = path.join(TEST_DIR, 'companies.csv');
const DECKS_DIR     = path.join(TEST_DIR, 'pitch_decks');
const TREE_PATH     = path.join(ROOT, 'src', 'seed', 'tree.yaml');
const RESULTS_PATH  = path.join(TEST_DIR, 'results.json');

// ── Load tree.yaml directly (no MongoDB needed) ───────────────────────────────
interface TreeNode {
  nodeId: string; parentId?: string; kind: string; name: string;
  category: string; weight: number; enabled: boolean;
  sourceType?: string; sourceRef?: string; signalKey?: string;
  scoringRule?: Record<string, unknown>; flags?: string[];
}
interface BiasConfig {
  categoryMultipliers: { required: number; must_have: number; good_to_have: number; not_required: number };
}

const treeDoc  = yaml.load(fs.readFileSync(TREE_PATH, 'utf-8')) as { nodes: TreeNode[]; biasProfile: BiasConfig };
const allNodes = treeDoc.nodes.filter(n => n.enabled !== false || n.scoringRule?.type === 'scrape_threshold');
const profile  = treeDoc.biasProfile;

function catMult(cat: string): number {
  const m = profile.categoryMultipliers;
  if (cat === 'required')     return m.required;
  if (cat === 'must_have')    return m.must_have;
  if (cat === 'good_to_have') return m.good_to_have;
  return 0;
}

// ── CSV column names ──────────────────────────────────────────────────────────
const C = {
  brand:  'Brand Name',
  status: 'Startup Status',
  sector: 'Sector / Domain',
  n_co:   'Number of cofounders',
  q1:  'Q1: Problem statement view',
  q2:  'Q2: Problem Exposure- How long were you exposed to this problem before starting the company? | (Enter 0 if the problem was identified only after founding the company.)',
  q3:  'Q3: Co-founder Duration | How long have you known your co-founder? (Enter 0 if you are a solo founder.)',
  q4:  'Q4: Relationship Nature',
  q5:  'Q5: Primary source of First 10 Customers GTM',
  q6:  'Q6: Initial CAC',
  q7:  'Q7: Pivot History- How many times have you pivoted?',
  q8:  'Q8: Customer Discovery Depth - How many people have you spoken to as part of your customer discovery process?',
  q9:  'Q9: Target Persona Role',
  q10: 'Q10: Target Persona type',
  q11: 'Q11: Willingness to Pay',
  q12: 'Q12: Estimated number of target persona in your primary market',
  q13: 'Q13: Product TRL Level',
  q14: 'Q14: Two Primary Dimensions of Differentiation',
  q15: "Q15: Value Improvement Multiple | Compared to the best existing alternative, how much better is your solution on the primary differentiation metric?",
  q16: 'Q16: Primary source of competitive moat',
  q17: 'Q17: Commercial Traction Stage',
  q18: 'Q18: Core Traction Metrics',
  // NOTE: CSV uses Unicode Replacement Character U+FFFD in place of dashes
  oq1: 'Open Q1 \uFFFD Founder Journey | How did you get to this point? | Tell the complete story of your journey, including your background, key experiences, insights, turning points, and why you decided to start this company.',
  oq2: 'Open Q2 \uFFFD Unique Insight | What is the one thing you know about this problem that someone who has not lived your journey would never see? Describe the non-obvious insight that only came from firsthand experience.',
  oq3: 'Open Q3 \uFFFD Unfair Advantage| What can you accomplish in the next 30 days that someone with more money but less context than you could not? | Explain the unique leverage, knowledge, relationships, or understanding that gives you an edge.',
  oq4: 'Open Q4 \uFFFD Problem Statement | Describe the problem you are solving in the exact words of the person experiencing it. | Who is most affected by this problem, and how does it impact their daily life or work?',
  oq5: 'Open Q5: Walk me through the customer discovery process- who did you speak to, what surprised the most, what did you learn and what thinking changed',
  oq6: 'Open Q6 \uFFFD Gap Analysis | What is missing between how things work today Vs how your customers want it to work',
  oq7: 'Open Q7 \uFFFD Solution & Switching Motivation | Describe your solution in the words of your target customer. | Why would someone currently using the best available alternative switch to your product?',
  oq8: 'Open Q8 \uFFFD Hardest Challenge | What is the hardest problem you have solved while building this company?| What part of your solution would be most difficult for a well-funded competitor to replicate?',
  oq9: 'Open Q9 \uFFFD Learning from Mistakes |  Tell us about a time you were wrong.\nWhat happened?\nWhat assumptions failed?\nHow quickly did you recognize the mistake?\nWhat changes did you make?',
  oq10:'Open Q10 \uFFFD Proof of Demand | What concrete evidence proves that the market needs your solution?| Examples:\nPaying customers\nRenewals\nOrganic referrals\nPilots converting into contracts\nMeasurable user engagement\nStrong retention metrics\n',
};

// ── Normalizers ───────────────────────────────────────────────────────────────
function months(s: string): number { const m = (s ?? '').match(/(\d+)/); return m ? +m[1] : 0; }
function num(s: string): number    { return parseFloat((s ?? '0').replace(/[^0-9.]/g, '')) || 0; }

function q1norm(s: string): string {
  const l = s.toLowerCase();
  if (l.includes('insider') || l.includes('operator')) return 'operator';
  if (l.includes('customer') || l.includes('end user')) return 'customer';
  return 'neither';
}

function q4norm(s: string): string[] {
  if (!s || s.trim() === '0' || s.trim().toLowerCase() === 'na') return ['no_prior_relationship'];
  const map: [string, string][] = [
    ['personal', 'personal_relationship'],['family','personal_relationship'],['friend','personal_relationship'],
    ['worked together','worked_together'],['studied','studied_together'],
    ['built a startup','built_startup_together'],['professional network','met_through_network'],['network','met_through_network'],
    ['no prior','no_prior_relationship'],
  ];
  const r: string[] = [];
  const l = s.toLowerCase();
  for (const [k,v] of map) if (l.includes(k) && !r.includes(v)) r.push(v);
  return r.length ? r : ['no_prior_relationship'];
}

function q5norm(s: string): string {
  const l = (s ?? '').toLowerCase();
  if (l.includes('personal'))     return 'personal_relationship';
  if (l.includes('professional')) return 'professional_network';
  if (l.includes('cold'))         return 'cold_outreach';
  if (l.includes('inbound'))      return 'inbound';
  if (l.includes('partner') || l.includes('channel')) return 'partnerships';
  if (l.includes('community'))    return 'community';
  return 'other';
}

function q11norm(s: string): string {
  const l = (s ?? '').toLowerCase();
  if (l.includes('significant') || l.includes('high')) return 'yes_high';
  if (l.includes('moderate'))   return 'yes_medium';
  if (l.includes('small') || l.includes('low')) return 'yes_low';
  if (l.includes('no') || l.includes('not')) return 'no';
  return 'yes_medium';
}

function trlNorm(s: string): string { const m = s.match(/(\d)/); return m ? m[1] : '3'; }

function tractionNorm(s: string): string {
  const l = (s ?? '').toLowerCase();
  if (l.includes('scaled') || l.includes('arr') || l.includes('mrr')) return 'scaled_revenue';
  if (l.includes('recurring')) return 'recurring_revenue';
  if (l.includes('paying'))    return 'paying_customers';
  if (l.includes('pilot') || l.includes('loi')) return 'pilots_lois';
  return 'early_conversations';
}

function q18norm(s: string): string {
  const l = (s ?? '').toLowerCase();
  if (l.includes('strong') || l.includes('consistent') || l.includes('growing')) return 'strong';
  if (l.includes('moderate') || l.includes('early')) return 'moderate';
  if (l.includes('weak') || l.includes('nascent')) return 'weak';
  return 'none';
}

function moatNorm(s: string): string[] {
  const map: [string, string][] = [
    ['proprietary data','proprietary_data'],['deep tech','deep_tech'],['deep technology','deep_tech'],
    ['network effect','network_effects'],['workflow','workflow_integration'],['exclusive','exclusive_partnerships'],
    ['regulatory','regulatory_advantage'],['brand','brand_trust'],['community','community'],
  ];
  const l = (s ?? '').toLowerCase();
  const r: string[] = [];
  for (const [k,v] of map) if (l.includes(k) && !r.includes(v)) r.push(v);
  return r.length ? r.slice(0,2) : ['deep_tech'];
}

function q15norm(s: string): string {
  const l = (s ?? '').toLowerCase();
  if (l.includes('10x to 50') || l.includes('10-50')) return '10x_to_50x';
  if (l.includes('5x to 10')  || l.includes('5-10'))  return '5x_to_10x';
  if (l.includes('2x to 5')   || l.includes('2-5'))   return '2x_to_5x';
  if (l.includes('more than 50') || l.includes('>50')) return 'more_than_50x';
  return '2x_to_5x';
}

function buildAnswers(row: Record<string, string>) {
  const keys = Object.keys(row);
  const getCol = (k1: string, k2?: string) => {
    const val = keys.find(k => k.toLowerCase().includes(k1.toLowerCase()));
    if (val) return row[val];
    if (k2) {
      const val2 = keys.find(k => k.toLowerCase().includes(k2.toLowerCase()));
      if (val2) return row[val2];
    }
    return '';
  };

  const cofMonths = months(getCol('q3:') || getCol('co-founder duration') || '0');
  const closed: Record<string, unknown> = {
    closedQ1:         q1norm(getCol('q1:') || getCol('problem statement view') || ''),
    closedQ2:         months(getCol('q2:') || getCol('problem exposure') || '0'),
    closedQ3:         cofMonths,
    closedQ4:         q4norm(getCol('q4:') || getCol('relationship nature') || ''),
    closedQ5:         q5norm(getCol('q5:') || getCol('primary source of first') || ''),
    closedQ6:         num(getCol('q6:') || getCol('initial cac') || '0'),
    closedQ7:         (() => { const n = months(getCol('q7:') || getCol('pivot history') || '0'); return n >= 4 ? '4+' : String(n); })(),
    closedQ7_count:   months(getCol('q7:') || getCol('pivot history') || '0'),
    closedQ8:         months(getCol('q8:') || getCol('customer discovery depth') || '0'),
    closedQ9:         'specific_role',
    closedQ9_role_text: getCol('q9:') || getCol('target persona role') || '',
    closedQ10:        (getCol('q10:') || getCol('target persona type') || 'SME').includes('Enterprise') ? 'Enterprise' : (getCol('q10:') || getCol('target persona type') || 'SME').includes('Govt') ? 'Govt' : 'SME',
    closedQ11:        q11norm(getCol('q11:') || getCol('willingness to pay') || ''),
    closedQ12:        'provided_no_source',
    closedQ13:        trlNorm(getCol('q13:') || getCol('product trl') || '3'),
    closedQ14:        [getCol('q14:') || getCol('primary dimensions') || ''].flatMap(s => s.split(',').map(x => x.trim().split('–')[0].trim().toLowerCase().replace(/\s+/g,'_').replace(/[–?]/g,''))).filter(Boolean).slice(0,2),
    closedQ15:        q15norm(getCol('q15:') || getCol('value improvement') || ''),
    closedQ16:        moatNorm(getCol('q16:') || getCol('competitive moat') || ''),
    closedQ17:        tractionNorm(getCol('q17:') || getCol('commercial traction') || ''),
    closedQ18:        q18norm(getCol('q18:') || getCol('core traction') || ''),
  };
  const open: Record<string, string> = {
    openQ1:  getCol('founder journey'),
    openQ2:  getCol('unique insight'),
    openQ3:  getCol('unfair advantage'),
    openQ4:  getCol('describe the problem'),
    openQ5:  getCol('walk me through the customer discovery'),
    openQ6:  getCol('gap analysis'),
    openQ7:  getCol('switching motivation'),
    openQ8:  getCol('hardest challenge'),
    openQ9:  getCol('learning from mistakes'),
    openQ10: getCol('proof of demand'),
  };
  return { closed, open, isSolo: cofMonths === 0 };
}

// ── Scoring functions (copied logic, no mongoose) ─────────────────────────────
function closedMapping(val: unknown, mapping: Record<string, number>): number {
  if (val === undefined || val === null) return 0;
  if (Array.isArray(val)) return val.length ? Math.max(...val.map(v => mapping[String(v)] ?? 0)) : 0;
  return mapping[String(val)] ?? 0;
}

function numericCurve(val: unknown, curve: Record<string, number>): number {
  const n = typeof val === 'number' ? val : Number(String(val ?? '0').replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return 0;
  const pts = Object.entries(curve).map(([k,v]) => ({ x: Number(k), y: v })).sort((a,b) => a.x - b.x);
  if (!pts.length) return 0;
  if (n <= pts[0].x) return pts[0].y;
  if (n >= pts[pts.length-1].x) return pts[pts.length-1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i+1];
    if (n >= a.x && n <= b.x) return a.y + ((n - a.x) / (b.x - a.x)) * (b.y - a.y);
  }
  return 0;
}

// ── LLM rubric scorer — with live KNN grounding ───────────────────────────────
async function scoreLLM(
  rubricId: string,
  answerText: string,
  pitchText: string,
  submId: string,
  signalKey: string,
  contextHint?: string,
): Promise<{score:number; evidence:string; weakness:string|null}> {
  const isPitchDeckOnly = rubricId.includes('upload_pitch') || rubricId.includes('pitch_');
  if (!isPitchDeckOnly && (!answerText?.trim() || answerText.trim().length < 10)) return { score: 0, evidence: 'empty', weakness: 'No answer provided' };
  if (isPitchDeckOnly && (!pitchText?.trim() || pitchText.trim().length < 50)) return { score: 0, evidence: 'empty deck', weakness: 'No pitch deck provided' };

  if (isPitchDeckOnly) {
    answerText = `[PITCH DECK CONTENT]\n${pitchText.slice(0, 15000)}`;
  }

  // ── KNN grounding: retrieve nearest benchmark examples from MongoDB ─────────
  // fetchKNN returns [] when MongoDB is offline — scoreWithRubric will then
  // automatically fall back to the static RAG bank. Zero behaviour change when
  // KNN is unavailable.
  const knnNeighbors = await fetchKNN(answerText, signalKey);
  if (knnNeighbors.length > 0) {
    process.stdout.write(`[KNN:${knnNeighbors.length}] `);
  }

  try {
    // Dynamic import to avoid top-level issues
    const { scoreWithRubric } = await import('../src/services/rubricScorer');
    const r = await scoreWithRubric(rubricId, answerText, contextHint, pitchText, submId, knnNeighbors);
    return { score: r.score, evidence: r.rawTextEvidence ?? r.evidence ?? '', weakness: r.weakness };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`    ⚠️  LLM rubric ${rubricId} failed: ${msg.slice(0,80)}`);
    return { score: 0, evidence: `LLM error: ${msg.slice(0,80)}`, weakness: 'Scoring failed' };
  }
}

// ── Vector similarity scorer (calls Python microservice) ──────────────────────
async function scoreVector(signalKey: string, answerText: string): Promise<number> {
  if (!answerText?.trim() || answerText.trim().length < 20) return 0;
  try {
    const res = await axios.post<{ score: number; error?: string }>(
      'http://127.0.0.1:8000/score/vector',
      { signal_key: signalKey, answer_text: answerText },
      { timeout: 4_000 },
    );
    if (res.data.error) return 30; // unsupported signal — neutral
    return Math.min(100, Math.max(0, res.data.score ?? 0));
  } catch {
    return 30; // Python service offline — neutral fallback
  }
}

// ── PDF parser ────────────────────────────────────────────────────────────────
async function parseDeck(brand: string): Promise<string> {
  const files = fs.readdirSync(DECKS_DIR);
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = files.find(f => clean(f).includes(clean(brand.split(' ')[0])));
  if (!found) return '';
  try {
    const buf = fs.readFileSync(path.join(DECKS_DIR, found));
    const res = await pdfParse(buf);
    return res.text?.trim().slice(0, 50_000) ?? '';
  } catch { return ''; }
}

// ── Scraper execution for batch ───────────────────────────────────────────────
function scoredScrapeThreshold(val: string, thresholds: Record<string, number>): number {
  if (!val) return 0;
  return thresholds[val] ?? 0;
}

async function githubApi<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await axios.get<T>(`https://api.github.com${path}`, { headers, timeout: 20_000 });
  return res.data;
}

async function fetchScrapingData(row: Record<string, string>): Promise<Record<string, any>> {
  const scrapedData: Record<string, any> = {};
  const startupName = row[C.brand];
  const cin = row['CIN Number'];
  const linkedinUrl = row['Company Linkedin '];
  const websiteUrl = row['Website URL'];
  const githubUrl = row['Github link'];

  // Zauba
  if (cin && cin.length > 5) {
    try {
      // Dynamic import to avoid missing dependencies if they break
      const { scrapeZaubaCorp } = await import('../src/scrapers/zauba/zaubaScraper');
      const zRes = await scrapeZaubaCorp(cin);
      scrapedData.zauba = { status: 'success', summaryCharCount: zRes.summaryText.length };
    } catch { scrapedData.zauba = { status: 'unavailable' }; }
  } else scrapedData.zauba = { status: 'unavailable' };

  // LinkedIn
  if (linkedinUrl && linkedinUrl.length > 5) {
    console.log(`  [Scrape] LinkedIn (Python microservice)...`);
    try {
      const res = await axios.post('http://127.0.0.1:8000/scrape/linkedin', { company_name: startupName, linkedin_url: linkedinUrl, website_url: websiteUrl }, { timeout: 900_000 });
      scrapedData.linkedin = { ...res.data, status: 'success' };
    } catch { scrapedData.linkedin = { status: 'unavailable' }; }
  } else scrapedData.linkedin = { status: 'unavailable' };

  // Patents/Google
  console.log(`  [Scrape] Google/Patents (Python microservice)...`);
  try {
    const res = await axios.post('http://127.0.0.1:8000/scrape/google', { company_name: startupName }, { timeout: 120_000 });
    const pCount = res.data.patent_count ?? 0;
    scrapedData.patents = { status: pCount >= 3 ? 'granted' : pCount > 0 ? 'filed' : 'none' };
    scrapedData.google = { status: res.data.has_competitors ? 'found' : 'none' };
  } catch {
    scrapedData.patents = { status: 'unavailable' };
    scrapedData.google = { status: 'unavailable' };
  }

  // Press (SerpAPI)
  if (process.env.SERPAPI_KEY) {
    console.log(`  [Scrape] Press (SerpAPI)...`);
    try {
      const q = encodeURIComponent(`"${startupName}" (funding OR startup OR launched)`);
      const url = `https://serpapi.com/search.json?q=${q}&engine=google&api_key=${process.env.SERPAPI_KEY}`;
      const res = await axios.get(url, { timeout: 20_000 });
      const mentions = res.data.organic_results?.length ?? 0;
      scrapedData.press = { status: mentions >= 3 ? '3+' : mentions > 0 ? '1-2' : '0' };
    } catch { scrapedData.press = { status: '0' }; }
  } else scrapedData.press = { status: '0' };

  // GitHub
  if (githubUrl && githubUrl.includes('github.com')) {
    console.log(`  [Scrape] GitHub API...`);
    try {
      const org = githubUrl.match(/github\.com\/([^/]+)/)?.[1] ?? '';
      let reposData = await githubApi<any[]>(`/orgs/${org}/repos?sort=updated&per_page=5`).catch(() => githubApi<any[]>(`/users/${org}/repos?sort=updated&per_page=5`));
      
      let velocityCategory = 'none';
      let repoQualityCategory = 'exists_inactive';
      
      if (reposData && reposData.length > 0) {
        let allCommits: any[] = [];
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        for (const repo of reposData.slice(0, 3)) {
          try {
            const commits = await githubApi<any[]>(`/repos/${repo.owner.login}/${repo.name}/commits?since=${since}&per_page=30`);
            allCommits = allCommits.concat(commits);
          } catch {}
        }
        const commitsPerWeek = allCommits.length / 13;
        if (commitsPerWeek > 15) velocityCategory = 'very_high';
        else if (commitsPerWeek >= 5) velocityCategory = 'high';
        else if (commitsPerWeek >= 1) velocityCategory = 'medium';
        else if (commitsPerWeek > 0) velocityCategory = 'low';

        const qualityScore = allCommits.length > 0 ? 50 : 0;
        if (qualityScore >= 45) repoQualityCategory = 'exists_active';
        else if (allCommits.length > 0) repoQualityCategory = 'exists_low_activity';
      }
      scrapedData.github_velocity = { status: velocityCategory };
      scrapedData.github_signals = { status: repoQualityCategory };
    } catch {
      scrapedData.github_velocity = { status: 'unavailable' };
      scrapedData.github_signals = { status: 'unavailable' };
    }
  } else {
    scrapedData.github_velocity = { status: 'unavailable' };
    scrapedData.github_signals = { status: 'unavailable' };
  }

  return scrapedData;
}

// ── Verdict tier ──────────────────────────────────────────────────────────────
function tier(status: string): number {
  const s = status.toLowerCase().replace(/[\s\-]/g, '');
  if (s.includes('seriesa') || s.includes('preseriesa')) return 4;
  if (s.includes('seed'))    return 3;
  if (s.includes('preseed')) return 2;
  return 1;
}

// ── Band from score ───────────────────────────────────────────────────────────
function band(s: number) {
  if (s < 40) return 'not_passed';
  if (s < 60) return 'passed_with_gaps';
  if (s < 80) return 'passed';
  return 'priority';
}

// ── Map sourceRef → openAnswer key ───────────────────────────────────────────
function resolveOpenAnswer(sourceRef: string, open: Record<string, string>): string {
  // sourceRef examples: "openQ1", "openQ5", "openQ9"
  return open[sourceRef] ?? '';
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 iGaps Batch Evaluator v3 (KNN + MongoDB grounding)\n' + '═'.repeat(60));

  // Connect to MongoDB for KNN grounding (non-fatal if offline)
  await connectMongo();

  const csv: Record<string, string>[] = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
    columns: true, skip_empty_lines: true, trim: true,
    relax_quotes: true, relax_column_count: true,
  });
  const companies = csv.filter(r => r[C.brand]?.trim().length > 0);
  console.log(`📋 ${companies.length} companies loaded\n`);

  const signalNodes = allNodes.filter(n => n.kind === 'signal');
  const COFOUNDER_KEYS = new Set(['closedQ3_cofounder_known_months','closedQ4_relationship_type','scrape_cofounder_overlap_linkedin','scrape_prior_venture_together']);

  const results: unknown[] = [];
  let idx = 0;

  for (const row of companies) {
    const brand  = row[C.brand].trim();
    const status = row[C.status]?.trim() ?? 'Unknown';
    console.log(`\n[${++idx}/${companies.length}] ${brand}  (${status})`);

    // Parse PDF
    const pitchText = await parseDeck(brand);
    console.log(`  📄 Deck: ${pitchText.length ? pitchText.length + ' chars' : '⚠️  not found/parsed'}`);

    // Build answers
    const { closed, open, isSolo } = buildAnswers(row);
    if (isSolo) console.log('  👤 Solo founder detected — co-founder signals will be skipped');
    
    // Fetch scraper data inline
    const scrapedData = await fetchScrapingData(row);

    const signalsMap: Record<string, number> = {};
    const trace: {signal: string; score: number; method: string; evidence?: string}[] = [];

    for (const node of signalNodes) {
      if (!node.signalKey || !node.scoringRule) continue;
      const rule = node.scoringRule as Record<string, unknown>;
      let score = 0;
      let method = 'unknown';
      let evidence = '';

      // Solo-founder guard
      if (isSolo && COFOUNDER_KEYS.has(node.signalKey)) {
        score = 50; method = 'solo_founder_skip';
      } else if (rule.type === 'closed_mapping' && rule.mapping) {
        const ans = closed[node.sourceRef ?? ''];
        score = closedMapping(ans, rule.mapping as Record<string, number>);
        method = 'closed_mapping';
      } else if (rule.type === 'numeric_curve' && rule.curve) {
        const ans = closed[node.sourceRef ?? ''];
        score = numericCurve(ans, rule.curve as Record<string, number>);
        method = 'numeric_curve';
      } else if (rule.type === 'llm_rubric' && rule.rubric) {
        const ansText = resolveOpenAnswer(node.sourceRef ?? '', open);
        process.stdout.write(`  🤖 LLM: ${node.name.slice(0,40).padEnd(40)} `);
        const contextHint = `Company Stage: ${status}\nTraction Stage: ${closed.closedQ17 || 'unknown'}`;
        const r = await scoreLLM(String(rule.rubric), ansText, pitchText, `batch_${brand}`, node.signalKey ?? '', contextHint);
        score = r.score; evidence = r.evidence; method = 'llm_rubric';
        console.log(`→ ${score}`);
      } else if (rule.type === 'vector_similarity') {
        const ans = resolveOpenAnswer(node.sourceRef ?? '', open);
        score = await scoreVector(node.signalKey, ans);
        method = 'vector_similarity';
      } else if (rule.type === 'scrape_threshold' && rule.thresholds) {
        const sourceRef = node.sourceRef ?? '';
        const scrapeKey = sourceRef.replace('scrape.', '');
        // Map scrape reference to nested scrapedData value
        const scrapeValue = (scrapedData[scrapeKey] as Record<string, unknown>)?.status ?? (scrapedData[scrapeKey] ? 'found' : 'none');
        score = scoredScrapeThreshold(String(scrapeValue), rule.thresholds as Record<string, number>);
        method = 'scrape_threshold';
        evidence = `value=${scrapeValue}`;
      } else if (rule.type === 'derived_formula') {
        score = 50;
        method = 'derived_formula';
      }

      // Output to console with color/icons
      const icon = method === 'llm_rubric' ? '🤖' : method === 'vector_similarity' ? '📐' : method === 'scrape_threshold' ? '🌐' : '🔢';

      score = Math.min(100, Math.max(0, score));
      signalsMap[node.signalKey] = score;
      trace.push({ signal: node.name, score, method, evidence: evidence.slice(0,120) });
    }

    // ── Track aggregation ────────────────────────────────────────────────────
    const tracks: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const trackNode of allNodes.filter(n => n.kind === 'track')) {
      const tk = trackNode.nodeId.replace('track','') as 'A'|'B'|'C'|'D';
      const layers = allNodes.filter(n => n.kind === 'layer' && n.parentId === trackNode.nodeId);
      let tScore = 0, tW = 0;
      for (const layer of layers) {
        const sigs = signalNodes.filter(n => n.parentId === layer.nodeId);
        let lScore = 0, lW = 0;
        for (const sig of sigs) {
          if (!sig.signalKey) continue;
          const cm = catMult(sig.category);
          lScore += (signalsMap[sig.signalKey] ?? 0) / 100 * cm * (sig.weight / 100);
          lW     += sig.weight;
        }
        if (lW > 0 && Math.abs(lW - 100) > 1) lScore *= 100 / lW;
        const lcm = catMult(layer.category);
        tScore += lScore * lcm * (layer.weight / 100);
        tW     += layer.weight;
      }
      if (tW > 0 && Math.abs(tW - 100) > 1) tScore *= 100 / tW;
      tracks[tk] = Math.min(100, Math.max(0, tScore * 100));
    }

    // ── Composite ────────────────────────────────────────────────────────────
    let composite = 0;
    for (const t of allNodes.filter(n => n.kind === 'track')) {
      const tk = t.nodeId.replace('track','') as 'A'|'B'|'C'|'D';
      composite += (t.weight / 100) * tracks[tk];
    }
    composite = Math.min(100, Math.max(0, composite));

    // ── Gaps ─────────────────────────────────────────────────────────────────
    const gaps = trace
      .filter(t => t.score < 50 && t.method !== 'solo_founder_skip' && t.method !== 'scrape_threshold' && t.method !== 'derived_formula')
      .map(t => t.signal);

    console.log(`  📊 Score: ${composite.toFixed(1)}% | Band: ${band(composite)} | Track A:${tracks.A.toFixed(0)} B:${tracks.B.toFixed(0)} C:${tracks.C.toFixed(0)} D:${tracks.D.toFixed(0)} | Gaps: ${gaps.length}`);

    results.push({ brand, status, tier: tier(status), sector: row[C.sector] ?? '', composite: +composite.toFixed(1), band: band(composite), tracks, gaps, trace });
  }

  // ── Save results ─────────────────────────────────────────────────────────────
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\n\n💾 Saved to ${RESULTS_PATH}`);

  // ── Summary table ─────────────────────────────────────────────────────────────
  type R = {brand:string; status:string; tier:number; composite:number; band:string; gaps:string[]};
  const byScore = [...results as R[]].sort((a,b) => b.composite - a.composite);

  console.log('\n' + '═'.repeat(80));
  console.log('FINAL RANKING (Highest → Lowest Score)');
  console.log('═'.repeat(80));
  console.log('Rank  Company'.padEnd(30) + 'Status'.padEnd(18) + 'Score'.padEnd(8) + 'Band');
  console.log('─'.repeat(80));
  byScore.forEach((r,i) => {
    console.log(
      `${(i+1).toString().padStart(2)}.   ${r.brand.padEnd(26)}${r.status.padEnd(18)}${r.composite.toFixed(1).padEnd(8)}${r.band}`
    );
  });

  const topHalf   = byScore.slice(0, Math.ceil(byScore.length / 2));
  const seedPlus  = (results as R[]).filter(r => r.tier >= 3);
  const seedInTop = topHalf.filter(r => r.tier >= 3).length;
  console.log(`\n🎯 Ranking Quality: ${seedInTop}/${seedPlus.length} Seed+ companies in top half`);
  console.log('   Target: ≥ 70% Seed+ in top half\n');
  console.log('✅ Done.\n');

  // Clean disconnect
  if (knnEnabled) await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
