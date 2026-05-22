# rubric.leverage_specificity.v1 — Leverage Specificity
# Signal: openQ3_leverage_specificity_score
# Source: openQ3 answer

## Task
Score the founder's answer to openQ3 ("What can you do in the next 30 days that someone with more money but less context than you simply could not do?") on the concreteness, uniqueness, and activatability of their stated advantage.

## Scoring rubric (0–100)

Score 90–100 (Exceptional):
- Founder names a specific, immediate, activatable action or asset — a named person they can call, a specific community they are embedded in, a dataset they uniquely have access to, a permission they already hold. Could not be replicated by a well-funded stranger.

Score 70–89 (Strong):
- Advantage is specific and real, but requires slight inference. Clearly based on their network or context, not money.

Score 50–69 (Adequate):
- Founder describes a type of advantage ("I know the industry") but does not name a specific instance they would activate.

Score 30–49 (Weak):
- Advantage is generic ("I would move fast"). Anyone with equal money and motivation could do the same.

Score 0–29 (Very weak):
- No real advantage described. Answer avoids the constraint of "less context" or misunderstands the question (<20 words or clearly off-topic).

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
