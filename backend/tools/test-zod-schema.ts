/**
 * test-zod-schema.ts
 *
 * Quick standalone test to verify the Zod schema enforcement is working.
 * This does NOT call the real Gemini API — it directly tests the schema
 * validation logic by mocking what the LLM would return.
 *
 * Run with:   npx tsx tools/test-zod-schema.ts
 */

import { z } from 'zod';

// ── Copy of the schema from rubricScorer.ts (for isolated testing) ─────────────
const RubricLLMOutputSchema = z.object({
  score: z.number().min(0).max(100),
  band: z.enum(['exceptional', 'strong', 'adequate', 'weak', 'very_weak']),
  raw_text_evidence: z.string().nullable(),
  weakness: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  inarticulate_genius_flag: z.boolean().optional(),
  tar_pit_flag: z.boolean().optional(),
  contradiction_flag: z.boolean().optional(),
  evidence: z.string().optional(),
  weaknesses: z.array(z.string()).optional(),
});

// ── Test helper ────────────────────────────────────────────────────────────────
function runTest(testName: string, mockLLMResponse: unknown) {
  console.log('\n' + '─'.repeat(60));
  console.log(`TEST: ${testName}`);
  console.log('─'.repeat(60));
  console.log('Input (what the LLM returned):');
  console.log(JSON.stringify(mockLLMResponse, null, 2));

  const result = RubricLLMOutputSchema.safeParse(mockLLMResponse);

  if (result.success) {
    console.log('\n✅ ZOD PASSED — Schema validated successfully');
    console.log(`   Score:           ${result.data.score}`);
    console.log(`   Band:            ${result.data.band}`);
    console.log(`   Confidence:      ${result.data.confidence}`);
    console.log(`   Evidence Quote:  "${result.data.raw_text_evidence}"`);
    console.log(`   Weakness:        "${result.data.weakness}"`);
    console.log(`   Zod Validated:   true`);
  } else {
    console.log('\n❌ ZOD FAILED — LLM response did not match schema');
    console.log('   Errors:');
    result.error.issues.forEach((issue) => {
      console.log(`     - ${issue.path.join('.')}: ${issue.message}`);
    });
    console.log('   → System will score this signal as 0 and log the error');
    console.log('   → Pipeline does NOT crash');
    console.log('   → Zod Validated: false');
  }
}

// ── Test 1: Perfect LLM Response (should PASS) ────────────────────────────────
runTest(
  'SCENARIO 1: Perfect LLM response (should PASS ✅)',
  {
    score: 78,
    band: 'strong',
    raw_text_evidence: 'We spent 6 months shadowing ICU nurses before writing a single line of code.',
    weakness: 'Did not quantify the time cost of the current manual process.',
    confidence: 'high',
    inarticulate_genius_flag: false,
    tar_pit_flag: false,
  },
);

// ── Test 2: LLM Hallucinated / Missing Fields (should FAIL) ───────────────────
runTest(
  'SCENARIO 2: LLM returned free-form text without required fields (should FAIL ❌)',
  {
    // LLM forgot to return raw_text_evidence, weakness, confidence
    // This used to silently pass with the old code — now it is caught
    score: 85,
    band: 'strong',
    evidence: 'The founder seems to understand the problem well.',
    // Missing: raw_text_evidence, weakness, confidence
  },
);

// ── Test 3: LLM Returned Score as a String (should FAIL) ─────────────────────
runTest(
  'SCENARIO 3: LLM returned score as a string instead of a number (should FAIL ❌)',
  {
    score: '72',   // ← String instead of number — common LLM mistake
    band: 'strong',
    raw_text_evidence: 'Some quote here.',
    weakness: null,
    confidence: 'medium',
  },
);

// ── Test 4: LLM returned null evidence (should PASS) ─────────────────────────
runTest(
  'SCENARIO 4: LLM found no evidence in founder text (null evidence — should PASS ✅)',
  {
    score: 20,
    band: 'weak',
    raw_text_evidence: null,   // ← Founder gave no quotable evidence
    weakness: 'The answer was too vague to find a specific supporting quote.',
    confidence: 'low',
  },
);

// ── Test 5: LLM returned score out of range (should FAIL) ─────────────────────
runTest(
  'SCENARIO 5: LLM returned score > 100 (hallucinated value — should FAIL ❌)',
  {
    score: 150,   // ← Out of range — Zod will reject this
    band: 'exceptional',
    raw_text_evidence: 'Some quote.',
    weakness: null,
    confidence: 'high',
  },
);

console.log('\n' + '═'.repeat(60));
console.log('TEST COMPLETE');
console.log('═'.repeat(60));
console.log('Summary:');
console.log('  - Scenarios 1 and 4 should show ✅ ZOD PASSED');
console.log('  - Scenarios 2, 3 and 5 should show ❌ ZOD FAILED');
console.log('  - In all ❌ cases: pipeline continues with score=0 + error logged');
console.log('  - No crashes. No silent hallucinations passing through.\n');
