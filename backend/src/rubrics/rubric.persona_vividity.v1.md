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

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
