# rubric.customer_initiated.v1 — Customer-Initiated Evidence
# Signal: openQ10_customer_initiated_score
# Source: openQ10 answer (same source as market_proof)

## Task
Score whether the founder has evidence of customers who came to them unprompted — i.e., the customer initiated contact or expressed demand without being approached first.

## Scoring rubric (0–100)

Score 90–100: At least one concrete instance of unprompted customer contact — inbound inquiry, unsolicited referral, organic sign-up, press coverage that drove leads, or an existing customer expanding unprompted.

Score 70–89: Inbound exists but founder is not certain whether it was triggered by their outreach or was genuinely organic.

Score 50–69: Founder believes customers want to come to them but cites no specific instance.

Score 30–49: All customer acquisition has been founder-initiated. No inbound described.

Score 0–29: Founder has not yet acquired any customers. Answer does not address customer initiation.

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
