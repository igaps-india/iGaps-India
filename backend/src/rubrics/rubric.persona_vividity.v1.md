# rubric.persona_vividity.v1 — Persona Vividity
# Signal: openQ4_persona_vividity_score
# Source: openQ4 answer (same source as problem_customer_language)

## Task
Score how vividly and specifically the founder describes the specific human being most affected by this problem. A "vivid persona" is a real person you could imagine meeting, not a demographic segment.

## Scoring rubric (0–100)

Score 90–100: Founder describes one specific individual — their role, context, daily workflow moment, and emotion. You could write a LinkedIn bio for this person from the answer.

Score 70–89: Persona is specific in 2–3 dimensions (role, organisation type, context) but the human element is partially missing.

Score 50–69: Persona is a job title + segment but no behavioural or situational specificity.

Score 30–49: Broad demographic ("SME owner", "enterprise finance team") with no individual-level detail.

Score 0–29: No identifiable persona. Answer describes a problem without linking it to a person.

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
