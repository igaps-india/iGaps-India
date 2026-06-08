# rubric.market_proof.v1 — Market Proof
# Signal: openQ10_market_proof_score
# Source: openQ10 answer

## Task
Score whether the founder provides actual, concrete evidence of market demand — not interpreted signals, not plans to seek evidence. Focus: what has already happened, not what might happen.

## Scoring rubric (0–100)

Score 90–100: Founder cites at least one of: paying customer with named company size/type, signed LOI with specific value, waitlist with >100 optins sourced organically, reorder or expansion from existing customer, inbound from unexpected source. Evidence is verifiable in principle.

Score 70–89: Evidence is real but early (1 paying customer, small pilot). Not yet de-risking but direction is correct.

Score 50–69: Evidence is soft (positive user feedback, unquantified interest). Not yet a financial or contractual commitment.

Score 30–49: Founder describes their own interpretation of signals ("the market is clearly ready because...") rather than events that happened.

Score 0–29: No evidence. Founder describes why the market should want the product but provides no data that it does.

## Calibration examples
{{RAG_EXAMPLES}}

## Output format

Return ONLY valid JSON. Do not include markdown codeblocks or any other text.
The JSON must strictly follow this exact structure:

{
  "score": 0, // integer 0-100
  "band": "weak", // MUST be EXACTLY ONE OF: "exceptional", "strong", "adequate", "weak", "very_weak"
  "raw_text_evidence": "...", // exact quote from text
  "weakness": "...", // weakness identified
  "confidence": "high" // "high", "medium", or "low"
}
