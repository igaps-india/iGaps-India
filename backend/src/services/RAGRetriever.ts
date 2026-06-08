/**
 * RAGRetriever.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieval-Augmented Generation example bank for LLM rubric scoring.
 *
 * WHY THIS EXISTS:
 *   Without examples, the LLM scores in a vacuum — it calibrates against its
 *   own training distribution, which skews toward polished Silicon Valley
 *   startup language. Indian founders, especially Tier-2 founders, get
 *   penalised for writing style rather than substance.
 *
 *   By injecting 3 real graded examples per rubric before scoring, the LLM
 *   compares the founder's answer to concrete anchors at known score levels,
 *   not against an abstract ideal.
 *
 * HOW IT WORKS:
 *   - EXAMPLE_BANK maps rubricId → 3 graded examples (high/mid/low)
 *   - getRAGExamples(rubricId) returns a formatted markdown block
 *   - rubricScorer.ts injects this into the system prompt via {{RAG_EXAMPLES}}
 *   - If rubricId not found → empty string (graceful fallback, no crash)
 *
 * EXTENDING:
 *   Add more rubricIds and examples as new signals are created.
 *   Examples should be India-context aware and reflect the actual founder pool.
 */

interface RagExample {
  score: number;
  band: 'exceptional' | 'strong' | 'adequate' | 'weak' | 'very_weak';
  answer: string;
  why: string;
}

const EXAMPLE_BANK: Record<string, RagExample[]> = {

  // ── Rubric: Causality Chain Coherence ──────────────────────────────────────
  // Signal: openQ1_causality_coherence_score
  // Question: "How did you get to this point?"
  'rubric.causality.v1': [
    {
      score: 88,
      band: 'strong',
      answer:
        'I spent 7 years as a radiologist at AIIMS Delhi. Every day I watched junior residents misread ' +
        'CT scans under pressure — not because they were incompetent, but because the reading room was dark, ' +
        'noisy, and they had 40 scans queued. I built a crude annotation overlay tool in Python to help one ' +
        'of them during night duty. She read 30% faster. That moment — 2am, bad fluorescent light — made me ' +
        'quit and start this.',
      why:
        'Coherent causality chain: specific lived role (radiologist) → concrete observed friction (misreads ' +
        'under pressure) → non-obvious insight (environment not competence) → prototype → founding moment. ' +
        'The insight is only available to someone who spent years in that reading room.',
    },
    {
      score: 52,
      band: 'adequate',
      answer:
        'I worked in a hospital for 3 years and noticed that a lot of administrative work was being done ' +
        'manually. I talked to some doctors and nurses and they confirmed it was a big problem. I had a ' +
        'background in software so I decided to build something to fix it.',
      why:
        'Experience is mentioned but the jump to the startup is large. "Administrative work done manually" ' +
        'is not specific enough — it could apply to any hospital in any country. The insight is not ' +
        'personal, it is generic enough to be reached by market research alone.',
    },
    {
      score: 18,
      band: 'very_weak',
      answer:
        'Healthcare is one of the largest sectors in India and is going through digital transformation. ' +
        'I saw a huge opportunity to build AI tools for hospitals. The market is expected to grow ' +
        'significantly and I have the technical skills to build this.',
      why:
        'No personal journey. This is a market thesis, not a causality chain. Could be written by anyone ' +
        'who read a VC report. There is no lived experience, no specific friction, no founding insight.',
    },
  ],

  // ── Rubric: Non-Obvious Insight ────────────────────────────────────────────
  // Signal: openQ2_non_obvious_insight_score
  // Question: "What do you know about this problem that others don't?"
  'rubric.non_obvious_insight.v1': [
    {
      score: 91,
      band: 'exceptional',
      answer:
        'Everyone assumes the bottleneck in cold chain logistics is temperature monitoring. It is not. ' +
        'The real failure point is the 8-minute gap when goods transfer between the truck and the warehouse dock. ' +
        'No sensor covers that gap — the truck sensor stops, the warehouse sensor starts 3 minutes later. ' +
        'In that 8-minute window, 23% of spoilage events occur. I know this because I analysed 14 months of ' +
        'data from three Reliance Fresh distribution centres before starting.',
      why:
        'The insight directly contradicts conventional wisdom (temperature monitoring) and is backed by ' +
        'specific proprietary data (14 months, 3 DCs, 23% stat). Not derivable from public research. ' +
        'The founder clearly knows something the market does not.',
    },
    {
      score: 56,
      band: 'adequate',
      answer:
        'Most people think the problem with collections in MSME lending is willingness to pay. ' +
        'From my experience working at a fintech, I found that a lot of defaulters actually want to pay ' +
        'but don\'t know how to navigate the portal. Simplifying the UX dramatically reduces defaults. ' +
        'We saw this in one pilot.',
      why:
        'There is a genuine insight (UX not willingness) but it is not fully non-obvious — multiple ' +
        'fintech players have published similar findings. The evidence base is thin (one pilot). ' +
        'The insight is directionally correct but not proprietary.',
    },
    {
      score: 14,
      band: 'very_weak',
      answer:
        'The problem is that most existing solutions are too expensive for small businesses and ' +
        'are not designed for the Indian market. We understand Indian businesses better because ' +
        'we are Indian and have worked with them.',
      why:
        'This is not an insight — it is a positioning statement. "Existing solutions are too expensive" ' +
        'and "not designed for India" are the two most generic claims in Indian startup pitching. ' +
        'Being Indian is not a proprietary insight.',
    },
  ],

  // ── Rubric: Pivot Quality ──────────────────────────────────────────────────
  // Signal: openQ9_pivot_quality_score
  // Question: "Describe a significant decision or pivot you made. What triggered it and what did you learn?"
  'rubric.pivot_quality.v1': [
    {
      score: 84,
      band: 'strong',
      answer:
        'In month 4, we were building a B2C app for patients to track their medications. We had 1,200 ' +
        'downloads but zero retention after day 7. During a user interview, a pharmacist mentioned he ' +
        'spent 2 hours a day calling patients who missed refills. We killed the B2C app in 48 hours, ' +
        'pivoted to a B2B tool for pharmacies. Within 6 weeks we had 3 paying pharmacy chains. The data ' +
        'was always there — we were just looking at the wrong customer.',
      why:
        'Clear trigger (user interview + quantified retention failure), fast decisive action (48 hours), ' +
        'and measurable validation (3 paying customers in 6 weeks). The pivot logic is coherent — not a ' +
        'random direction change but a response to clear signal.',
    },
    {
      score: 49,
      band: 'weak',
      answer:
        'We originally planned to target large enterprises but realised after a few months that the sales ' +
        'cycles were too long. So we decided to go downmarket and target SMEs instead. This helped us ' +
        'close deals faster and learn more quickly.',
      why:
        'This is a very common early-stage pivot (enterprise → SME) with no specific data mentioned. ' +
        '"Sales cycles too long" is vague — how long? What was the trigger conversation? The pivot ' +
        'description is correct but lacks evidence of rigour.',
    },
    {
      score: 22,
      band: 'very_weak',
      answer:
        'We have made several adjustments to our product based on feedback. We are constantly iterating ' +
        'and learning from our customers. Our team is very agile and we pivot quickly when needed.',
      why:
        'No specific pivot described. Buzzword soup (agile, iterating, feedback). There is no signal ' +
        'here that the founder has faced a real hard decision and reasoned through it.',
    },
  ],

  // ── Rubric: Discovery Quality ──────────────────────────────────────────────
  // Signal: openQ5_discovery_quality_score
  // Question: "Walk us through your customer discovery process."
  'rubric.discovery_quality.v1': [
    {
      score: 86,
      band: 'strong',
      answer:
        'We did 47 structured interviews over 8 weeks — 30 with procurement managers at mid-size manufacturers ' +
        'and 17 with their suppliers. We used the Mom Test framework. Three surprises emerged: (1) the problem ' +
        'was not ERP integration as we assumed, but approval workflow delays. (2) 11 of 30 procurement managers ' +
        'had built their own Excel macros to work around the ERP. (3) The supplier side was willing to pay — ' +
        'something we had not expected. We killed our original hypothesis by week 4 and rebuilt around what ' +
        'we actually heard.',
      why:
        'Specific number of interviews, structured methodology (Mom Test), clear surprise findings that ' +
        'changed direction. Evidence that the founder went in with a hypothesis and updated it based on ' +
        'data rather than confirming pre-existing beliefs.',
    },
    {
      score: 51,
      band: 'adequate',
      answer:
        'We spoke to around 20 potential customers in the first two months. Most of them confirmed that ' +
        'the problem we were targeting was real and they would consider paying for a solution. We got ' +
        'useful feedback on features and pricing.',
      why:
        '"Confirmed the problem was real" is the classic sign of biased discovery — founders hear what ' +
        'they want to hear. No surprises means either the process was not rigorous or the insights were ' +
        'filtered. 20 interviews is reasonable volume but the process quality is unclear.',
    },
    {
      score: 16,
      band: 'very_weak',
      answer:
        'We have a good understanding of the market from our previous work experience. We also did some ' +
        'online research and looked at competitor products to understand what customers need.',
      why:
        'No primary customer discovery at all. "Previous work experience" and "online research" are not ' +
        'customer discovery. No interviews mentioned, no surprises, no updated hypothesis.',
    },
  ],

  // ── Rubric: Market Proof ───────────────────────────────────────────────────
  // Signal: openQ10_market_proof_score
  // Question: "What is your strongest evidence that this market exists at the scale you claim?"
  'rubric.market_proof.v1': [
    {
      score: 83,
      band: 'strong',
      answer:
        'The clearest signal: we ran a no-code waitlist page for 3 weeks with zero paid marketing. ' +
        '847 procurement officers signed up, 31 booked a demo call unprompted. Of those 31, we closed ' +
        '4 as paid pilots at Rs 15,000/month each. All 4 renewals in month 2. Additionally, the top ' +
        'competitor (Kissflow) has 500+ Indian enterprise customers at $299/month — that validates the ' +
        'category. Our differentiation is the vernacular-language approval workflow which Kissflow cannot do.',
      why:
        'Own traction data (847 signups, 31 demos, 4 paying) combined with competitive market validation ' +
        '(Kissflow pricing and customer count). Both types of evidence present: bottom-up observed demand ' +
        'and top-down market validation.',
    },
    {
      score: 48,
      band: 'weak',
      answer:
        'The Indian B2B SaaS market is growing at 30% CAGR and is expected to reach $50 billion by 2030. ' +
        'There are 63 million MSMEs in India and our target segment is enterprises with 100-500 employees, ' +
        'which is roughly 200,000 companies. Even 1% market share would be a significant business.',
      why:
        'This is a top-down market sizing exercise, not market proof. The TAM/SAM approach tells us nothing ' +
        'about whether specific customers will pay for this specific product. No primary evidence of demand.',
    },
    {
      score: 11,
      band: 'very_weak',
      answer:
        'We believe the market is very large and growing. Many businesses are struggling with this problem ' +
        'and there is no good solution available. Our product fills this gap and we are confident in the ' +
        'market opportunity.',
      why:
        'Zero evidence. Pure assertion. "We believe" and "many businesses are struggling" with no data, ' +
        'no customer quotes, no competitor analysis, no traction. Scores near zero.',
    },
  ],

  // ── Rubric: Need Gap Precision ─────────────────────────────────────────────
  // Signal: openQ6_need_gap_precision_score
  // Question: "Describe exactly why existing solutions fail your customer."
  'rubric.need_gap_precision.v1': [
    {
      score: 87,
      band: 'strong',
      answer:
        'Our customer tried Tally, Zoho Books, and a custom ERP built by an IT vendor. The Tally failure ' +
        'was specific: their operations team is 70% women workers who are not computer literate. Tally ' +
        'requires keyboard shortcuts for everything — zero touchscreen support. The Zoho trial lasted ' +
        '3 weeks before the plant manager cancelled because every report had to be exported to Excel and ' +
        'reformatted before it could be sent to the MD. The custom ERP cost Rs 14 lakh and crashed every ' +
        'time they added a new product SKU. Our product is built touch-first and has a one-click MD report.',
      why:
        'Specific named alternatives (Tally, Zoho, custom ERP), specific failure modes (keyboard shortcuts, ' +
        'Excel reformatting, crash on SKU add), and specific prices paid (Rs 14 lakh). The gap description ' +
        'maps directly to a product decision (touch-first, one-click report).',
    },
    {
      score: 50,
      band: 'adequate',
      answer:
        'Existing solutions like SAP and Oracle are designed for large enterprises and are too expensive ' +
        'and complex for MSMEs. Tally is widely used but lacks real-time analytics and mobile access. ' +
        'We fill this gap with our affordable, mobile-first solution.',
      why:
        '"Too expensive and complex" and "lacks mobile access" are the two most generic complaints about ' +
        'enterprise software. They are correct but not precise. No specific failure modes, no customer ' +
        'stories, no price points. The gap description is directionally right but not rigorous.',
    },
    {
      score: 17,
      band: 'very_weak',
      answer:
        'Existing solutions are outdated and not user-friendly. Customers are frustrated with the current ' +
        'options available in the market. Our solution is modern, intuitive, and affordable.',
      why:
        '"Outdated and not user-friendly" is meaningless without specifics. No named alternatives, no ' +
        'specific failure modes, no evidence the founder has actually watched a customer fail with existing tools.',
    },
  ],

  // ── Rubric: Switching Reason ───────────────────────────────────────────────
  // Signal: openQ7_switching_reason_score
  // Question: "Why would a customer switch to your solution right now?"
  'rubric.switching_reason.v1': [
    {
      score: 82,
      band: 'strong',
      answer:
        'The switch trigger for our first 4 customers was the same event: a GST audit. When the auditor ' +
        'asks for 18 months of transaction-level data in 48 hours, their current WhatsApp + Excel setup ' +
        'completely breaks. Two of our customers switched within a week of an audit notice. The third ' +
        'switched after their accountant quit mid-year. The switching cost is near zero because we import ' +
        'directly from their WhatsApp groups — 20 minutes of setup.',
      why:
        'Specific external trigger identified (GST audit), backed by actual customer switching stories, ' +
        'and low switching cost quantified (20 minutes). This is an externally-forced switch moment, ' +
        'not a "maybe someday" value proposition.',
    },
    {
      score: 47,
      band: 'weak',
      answer:
        'Customers would switch to us because we offer better features at a lower price. Our onboarding ' +
        'is fast and we provide excellent customer support. Once they try our free trial they will see ' +
        'the value and convert.',
      why:
        '"Better features at lower price" is the weakest possible switching argument — it is the default ' +
        'claim of every startup and is almost never the actual reason customers switch. No trigger, no ' +
        'urgency, no specific feature delta.',
    },
    {
      score: 13,
      band: 'very_weak',
      answer:
        'Our product is significantly better than what is currently available and customers will switch ' +
        'once they are aware of our solution. We plan to invest in marketing and sales to reach them.',
      why:
        'No switching trigger, no urgency, no switching cost analysis. The plan (marketing and sales) ' +
        'is not a reason customers will switch — it is a go-to-market tactic.',
    },
  ],

  // ── Rubric: Hard Problem ───────────────────────────────────────────────────
  // Signal: openQ8_hard_problem_score
  // Question: "What is the hardest technical or scientific problem you are solving?"
  'rubric.hard_problem.v1': [
    {
      score: 89,
      band: 'strong',
      answer:
        'The hardest problem is real-time devanagari OCR on handwritten forms under variable lighting conditions. ' +
        'We process 800 form fields per second from our rural kiosk cameras. The challenge: district officials ' +
        'use 12 different handwriting styles for the same character, ink quality varies (ballpoint to gel to ' +
        'pencil), and forms are often folded creating crease artifacts. We had to build a custom CNN trained on ' +
        '1.2 million annotated field samples — commercial OCR APIs (Google Vision, AWS Textract) had 34% error ' +
        'rates on our validation set. We are now at 4.2% error rate after 18 months of training.',
      why:
        'Specific technical problem (Devanagari OCR, handwritten, variable lighting), specific metrics ' +
        '(800 fields/sec, 34% → 4.2% error rate), specific approach (custom CNN, 1.2M samples), and ' +
        'demonstrated that off-shelf solutions were tried and failed. This is a real hard problem.',
    },
    {
      score: 51,
      band: 'adequate',
      answer:
        'The hardest problem is building a recommendation engine that works with sparse data. New users ' +
        'have no history so cold-start is a major challenge. We are using collaborative filtering combined ' +
        'with content-based signals to handle this. We have achieved reasonable accuracy on our test set.',
      why:
        'Cold-start is a known problem with known solutions — the founder is describing an engineering ' +
        'challenge, not a hard problem. "Reasonable accuracy" is not a metric. Directionally correct ' +
        'but not demonstrating depth.',
    },
    {
      score: 16,
      band: 'very_weak',
      answer:
        'The main challenge is scaling our infrastructure to handle millions of users while keeping ' +
        'costs low. We are using cloud services and optimising our database queries to achieve this.',
      why:
        'Scaling infrastructure with cloud services is a solved problem for 99% of startups. This is ' +
        'not a hard problem — it is standard DevOps. Shows no technical depth.',
    },
  ],

  // ── Rubric: Pitch Tech Coherence ───────────────────────────────────────────
  // Signal: upload_pitch_tech_coherence_score
  // Source: pitch deck upload
  'rubric.pitch_tech_coherence.v1': [
    {
      score: 81,
      band: 'strong',
      answer:
        'Pitch deck describes a \"proprietary NLP pipeline for Hindi-English code-switch detection\". ' +
        'The technical slide shows: BERT base fine-tuned on 50K Hinglish tweets, custom tokenizer for ' +
        'Devanagari-Latin mixing, F1 score of 0.87 on held-out test set. Architecture diagram shows ' +
        'preprocessing → token classification → confidence thresholding. The technology claim matches ' +
        'the problem being solved (regional language customer support) and is internally consistent with ' +
        'the TRL level claimed (TRL 6 — prototype demonstrated).',
      why:
        'Technology description is specific, measurable, and coherent with the problem. Metrics are ' +
        'presented (F1 0.87), methodology is explained (BERT fine-tune, custom tokenizer), and TRL ' +
        'claim is consistent with described state of development.',
    },
    {
      score: 48,
      band: 'weak',
      answer:
        'Pitch deck claims \"AI-powered predictive analytics\" and \"machine learning algorithms\" throughout. ' +
        'No specific model architecture, dataset size, or accuracy metric is mentioned. The technology ' +
        'section says \"our proprietary AI\" without describing what makes it proprietary. TRL is claimed ' +
        'as 7 (pilot demonstration) but no pilot data is shown.',
      why:
        '"AI-powered" and "machine learning algorithms" without specifics are marketing language, not ' +
        'technology description. The TRL 7 claim contradicts the absence of pilot data.',
    },
    {
      score: 14,
      band: 'very_weak',
      answer:
        'Pitch deck mentions \"cutting-edge technology\" and \"next-generation platform\" with no technical ' +
        'details. Solution slide shows a mobile app mockup with arrows. No architecture, no methodology, ' +
        'no metrics. The technical approach is completely undefined.',
      why:
        'No technology content at all. Cannot evaluate coherence when there is nothing to evaluate. ' +
        'Mockups and buzzwords are not a technical description.',
    },
  ],

  // ── Rubric: Moat Articulation ──────────────────────────────────────────────
  // Signal: openQ8_moat_articulation_score
  // Question: "What makes your competitive position defensible over time?"
  'rubric.moat_articulation.v1': [
    {
      score: 85,
      band: 'strong',
      answer:
        'Our moat is a data flywheel that no competitor can replicate for at least 4 years. Every ' +
        'diagnostic report uploaded to our platform trains our pathology AI model. We have 2.3 million ' +
        'labelled slides from 47 government hospitals — data that required 3 years of MoU negotiations ' +
        'and regulatory approvals. The model accuracy improves by 0.8% per 100K additional slides. ' +
        'A new entrant would need to negotiate the same MoUs and wait 3 years before they had comparable ' +
        'training data. We also have network effects: each hospital that joins sees accuracy improvements ' +
        'from all other hospitals\' data.',
      why:
        'Specific moat type (data flywheel), quantified (2.3M slides, 0.8% per 100K improvement), and ' +
        'with a specific time-to-replicate estimate (4 years) backed by a concrete barrier (MoU approvals). ' +
        'Network effect is also articulated. This is a defensible moat argument.',
    },
    {
      score: 46,
      band: 'weak',
      answer:
        'Our moat is our technology, brand, and team. We have 2 years of R&D invested and a strong ' +
        'patent pending. Our team has deep domain expertise that competitors cannot easily replicate. ' +
        'First-mover advantage also gives us a head start.',
      why:
        '"Technology, brand, and team" are the three most frequently cited non-moats in startup pitching. ' +
        'Patent pending is not a moat until granted. First-mover advantage is not a moat by itself. ' +
        'No specific barrier to entry is articulated.',
    },
    {
      score: 12,
      band: 'very_weak',
      answer:
        'Our product is better than competitors and customers who use it are unlikely to switch. ' +
        'We will continue to improve and stay ahead of the competition.',
      why:
        '"Product is better" is not a moat. "Customers unlikely to switch" without switching cost ' +
        'analysis is wishful thinking. "Continue to improve" is not a competitive strategy.',
    },
  ],

  // ── Rubric: Pitch Traction ─────────────────────────────────────────────────
  // Signal: upload_pitch_traction_score
  // Source: pitch deck upload (traction slides)
  'rubric.pitch_traction.v1': [
    {
      score: 86,
      band: 'strong',
      answer:
        'Pitch deck traction slide shows: MRR of Rs 4.2 lakh (Month 8), 3-month MoM growth of 28%, ' +
        '6 paying enterprise customers (named: Minda Corp, Greaves Cotton, 4 others listed), NPS of 67, ' +
        'pilot-to-paid conversion rate of 71% (10 of 14 pilots converted), and churn of 0% in 8 months. ' +
        'Customer quotes are specific and named. There is a LOI from a 7th customer worth Rs 12 lakh ARR.',
      why:
        'Multiple traction metrics present and consistent with each other. Named customers (verifiable). ' +
        'Conversion rate and churn are both shown. LOI provides forward-looking signal. ' +
        'The story is internally coherent — 28% MoM growth matches 71% conversion rate trajectory.',
    },
    {
      score: 47,
      band: 'weak',
      answer:
        'Traction slide shows \"100+ customers\", \"4.5 star rating on app store\", and \"growing rapidly\". ' +
        'No revenue figures shown. No named enterprise customers. The growth chart shows user signups ' +
        'but no distinction between free and paying users.',
      why:
        '"100+ customers" without revenue is a vanity metric. App store rating is not a traction signal. ' +
        '"Growing rapidly" without a number is meaningless. Free vs paid distinction is missing — ' +
        'the most important distinction at this stage.',
    },
    {
      score: 9,
      band: 'very_weak',
      answer:
        'Traction slide says \"Early Stage\" and shows a product roadmap. No customers, no revenue, ' +
        'no pilot results. The slide says \"launching in Q3 2024\".',
      why:
        'No traction at all. A roadmap is not traction. This startup has not validated the market yet ' +
        'and should not be claiming traction. Score is near zero by definition.',
    },
  ],
};

/**
 * Returns 3 graded startup examples for the given rubric ID,
 * formatted as a markdown block for injection into the LLM prompt.
 *
 * Returns empty string if rubricId is not in the example bank
 * (graceful fallback — rubric still works, just without grounding).
 */
export function getRAGExamples(rubricId: string): string {
  const examples = EXAMPLE_BANK[rubricId];
  if (!examples || examples.length === 0) return '';

  const lines: string[] = [];

  examples.forEach((ex, i) => {
    lines.push(`### Example ${i + 1} — Score ${ex.score} (${ex.band.replace('_', ' ')})`);
    lines.push(`**Answer:** "${ex.answer}"`);
    lines.push(`**Why this score:** ${ex.why}`);
    lines.push('');
  });

  return lines.join('\n');
}
