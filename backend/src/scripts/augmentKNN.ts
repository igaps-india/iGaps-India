/**
 * augmentKNN.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates synthetic "ground truth" answers with predetermined scores to populate
 * the KNN database without inheriting bias from the current evaluation model.
 *
 * It uses the 9 existing train_batch companies as stylistic context, then commands
 * the LLM to generate exactly 50 examples per signal (10 for each score bucket).
 *
 * Usage:
 *   npx ts-node src/scripts/augmentKNN.ts
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const TARGET_SCORES = [100, 80, 50, 30, 10];
const EXAMPLES_PER_SCORE = 10; // 5 buckets * 10 = 50 total per signal

async function augment() {
  console.log('[Augment] Starting KNN synthetic data generation...');

  if (!config.llm.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is missing');
  }
  const client = new GoogleGenAI({ apiKey: config.llm.geminiApiKey });

  // 1. Load context from train_batch CSV
  const csvPath = path.join(__dirname, '../../data/train_batch/companies.csv');
  const csvData = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(csvData, { columns: true, skip_empty_lines: true, relax_column_count: true });
  console.log(`[Augment] Loaded ${rows.length} real companies for context.`);

  // 2. Parse tree.yaml to find all llm_rubric signals
  const treePath = path.join(__dirname, '../seed/tree.yaml');
  const treeDoc = yaml.load(fs.readFileSync(treePath, 'utf8')) as any;
  const signalNodes = treeDoc.nodes.filter((n: any) => n.kind === 'signal' && n.scoringRule?.type === 'llm_rubric');
  console.log(`[Augment] Found ${signalNodes.length} llm_rubric signals to augment.`);

  const outputData: any[] = [];
  const model = config.llm.geminiModelRubric || 'gemini-2.5-flash';

  for (const node of signalNodes) {
    const signalKey = node.signalKey;
    const rubricId = node.scoringRule.rubric;
    const sourceRef = node.sourceRef;
    console.log(`\n[Augment] Generating data for ${signalKey} (Source: ${sourceRef})`);

    // Find real answers from the CSV to use as style context
    // CSV columns are sometimes weird, let's find the one containing the sourceRef (e.g. "Open Q1")
    const csvKey = Object.keys(rows[0]).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(sourceRef.toLowerCase().replace(/[^a-z0-9]/g, '')));
    
    let realAnswersContext = '';
    if (csvKey) {
      const answers = rows.map((r: any) => r[csvKey]).filter(Boolean).slice(0, 5);
      realAnswersContext = answers.map((a: string, i: number) => `Example ${i+1}: "${a}"`).join('\n\n');
    }

    for (const targetScore of TARGET_SCORES) {
      console.log(`  -> Generating ${EXAMPLES_PER_SCORE} examples for score ${targetScore}...`);
      
      const BATCHES = 1;
      const EXAMPLES_PER_BATCH = 4;

      for (let batch = 0; batch < BATCHES; batch++) {
        const prompt = `
You are generating synthetic "ground truth" data for an AI startup evaluation engine.
We are creating answers for the signal: "${node.name}" (${node.description}).

Here is what real Indian AI startups sound like when answering this type of question:
${realAnswersContext ? realAnswersContext : '(No examples available)'}

YOUR TASK:
Generate exactly ${EXAMPLES_PER_BATCH} highly realistic founder answers that strictly deserve a score of ${targetScore} out of 100 based on the signal definition. 
Vary the industries (Healthcare AI, Fintech, Agritech, SaaS) and founder personas (e.g., academic, sales-heavy, technical).
Make them sound like real humans talking, not ChatGPT. Use some Indian context where appropriate.

Return ONLY a JSON array of objects with this schema:
[
  {
    "answerText": "The synthetic founder's answer...",
    "reasoning": "Why this specifically earns a ${targetScore} based on the rubric/signal."
  }
]
`;

        try {
          const result = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              temperature: 0.7,
              responseMimeType: 'application/json',
              maxOutputTokens: 8192,
            },
          });
          
          const jsonText = result.text ?? '[]';
          const generatedArray = JSON.parse(jsonText);

          for (const item of generatedArray) {
            outputData.push({
              signalKey,
              rubricId,
              predeterminedScore: targetScore,
              answerText: item.answerText,
              reasoning: item.reasoning
            });
          }
          
          // Progressive save
          const outDir = path.join(__dirname, '../../data/augmented');
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
          }
          const outCsvPath = path.join(outDir, 'augmented_human_inspection.csv');
          fs.writeFileSync(outCsvPath, stringify(outputData, { header: true }));
          
        } catch (err: any) {
          console.error(`  [Error] Failed to generate for ${signalKey} at score ${targetScore} (batch ${batch}): ${err.message}`);
        }
      }
    }
  }

  // Final JSON save
  const outDir = path.join(__dirname, '../../data/augmented');
  const outJsonPath = path.join(outDir, 'augmented_signal_examples.json');
  fs.writeFileSync(outJsonPath, JSON.stringify(outputData, null, 2));
  console.log(`\n[Augment] Saved ${outputData.length} generated examples to ${outJsonPath}`);
  
  console.log('\n[Done] Inspect the CSV. When ready, we can write a script to embed and inject these into MongoDB.');
}

augment().catch(err => {
  console.error(err);
  process.exit(1);
});
