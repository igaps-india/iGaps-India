/**
 * injectContext.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads companies.csv, scores the llm_rubric signals via Gemini, embeds them 
 * via Python microservice, and injects them directly into MongoDB as the 
 * ground-truth KNN context.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import pdfParse from 'pdf-parse';
import yaml from 'js-yaml';
import mongoose from 'mongoose';
import * as dns from 'dns';

// Force IPv4 resolution to prevent 'fetch failed' errors on Windows with broken IPv6
dns.setDefaultResultOrder('ipv4first');

import { connectDb, disconnectDb } from '../src/db';
import { SignalExample } from '../src/models/SignalExample';
import { persistSignalExample } from '../src/services/KNNRetriever';
import { embedText } from '../src/services/embeddingClient';
import { scoreWithRubric } from '../src/services/rubricScorer';

const ROOT = path.join(process.cwd());
const TEST_DIR = path.join(ROOT, 'data', 'train_batch');
const CSV_PATH = path.join(TEST_DIR, 'companies.csv');
const DECKS_DIR = path.join(TEST_DIR, 'pitch_decks');
const TREE_PATH = path.join(ROOT, 'src', 'seed', 'tree.yaml');

// ── Types ─────────────────────────────────────────────────────────────────────
interface TreeNode {
  nodeId: string; kind: string; enabled: boolean;
  sourceRef?: string; signalKey?: string;
  scoringRule?: { method: string };
}

// ── CSV column names ──────────────────────────────────────────────────────────
const C = {
  brand:  'Brand Name',
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

async function main() {
  console.log('\n🚀 iGaps Inject Context v1\n' + '═'.repeat(60));

  await connectDb();
  
  // Clear the existing context
  console.log('🧹 Clearing existing KNN Context (SignalExamples)...');
  await SignalExample.deleteMany({});
  
  const treeDoc = yaml.load(fs.readFileSync(TREE_PATH, 'utf-8')) as { nodes: TreeNode[] };
  const rubricNodes = treeDoc.nodes.filter(n => 
    n.enabled !== false && 
    n.kind === 'signal' && 
    (n.scoringRule as any)?.type === 'llm_rubric'
  );

  const csv = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
    columns: true, skip_empty_lines: true, trim: true, relax_quotes: true
  });
  const companies = csv.filter((r: any) => r[C.brand]?.trim().length > 0);
  console.log(`📋 ${companies.length} companies loaded for context seeding\n`);

  let seeded = 0;

  for (const row of companies) {
    const brand = row[C.brand].trim();
    const mockAppId = new mongoose.Types.ObjectId().toString(); // fake ID
    
    console.log(`\n[+] Processing: ${brand}`);
    const pitchText = await parseDeck(brand);
    
    const keys = Object.keys(row);
    const getCol = (keyword: string) => keys.find(k => k.toLowerCase().includes(keyword.toLowerCase()));

    const open: Record<string, string> = {
      openQ1: row[getCol('founder journey') || ''] ?? '',
      openQ2: row[getCol('unique insight') || ''] ?? '',
      openQ3: row[getCol('unfair advantage') || ''] ?? '',
      openQ4: row[getCol('problem statement') || ''] ?? '',
      openQ5: row[getCol('customer discovery') || ''] ?? '',
      openQ6: row[getCol('gap analysis') || ''] ?? '',
      openQ7: row[getCol('switching motivation') || ''] ?? '',
      openQ8: row[getCol('hardest challenge') || ''] ?? '',
      openQ9: row[getCol('learning from mistakes') || ''] ?? '',
      openQ10: row[getCol('proof of demand') || ''] ?? '',
    };

    for (const node of rubricNodes) {
      if (!node.signalKey || !node.sourceRef) continue;
      const answerText = open[node.sourceRef];
      if (!answerText || answerText.trim().length < 10) continue;
      
      process.stdout.write(`    ↳ ${node.signalKey}... `);
      
      try {
        const rubricId = (node.scoringRule as any)?.rubric || `rubric.${node.signalKey}`;
        // Score using the rubric scorer which wraps LLM
        // We pass undefined for pitchText to avoid expensive pitch deck chunking & retrieval
        // since we are only embedding and scoring textual open-answers for KNN.
        const r = await scoreWithRubric(rubricId, answerText, undefined, undefined, mockAppId);
        
        if (r.score > 0) {
          // Embed using microservice
          const { embedding, model } = await embedText(answerText);
          
          await persistSignalExample({
            signalKey: node.signalKey,
            rubricId: rubricId,
            applicationId: mockAppId,
            answerText: answerText,
            embedding: embedding,
            embeddingModel: model,
            score: r.score,
            scoreSource: 'admin_confirmed',
            reasoning: r.rawTextEvidence ?? r.evidence ?? '',
          });
          seeded++;
          console.log(`✅ (Score: ${Math.round(r.score)})`);
          await new Promise(res => setTimeout(res, 2000)); // sleep for 2s to avoid rate limit
        } else {
           console.log(`⚠️  Score 0, skipped.`);
        }
      } catch (err: any) {
         console.log(`❌ Error: ${err.message}`);
      }
    }
  }

  console.log(`\n🎉 Injection complete! Seeded ${seeded} examples directly into the DB.\n`);
  await disconnectDb();
}

main().catch(console.error);
