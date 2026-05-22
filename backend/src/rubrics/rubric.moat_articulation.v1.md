# rubric.moat_articulation.v1 — Moat Compounding Evidence
# Signal: openQ8_moat_articulation_score
# Source: openQ8 answer (same source as hard_problem)

## Task
Score the degree to which the founder demonstrates that their competitive moat is compounding — i.e., gets stronger over time and harder to replicate with money alone.

## Scoring rubric (0–100)

Score 90–100: Founder explicitly describes the compounding mechanism — data accumulates, network densifies, workflow integration deepens. They can explain what it would cost a well-funded competitor to build the same moat in years, not money.

Score 70–89: Moat is clear but compounding mechanism is implied, not explained.

Score 50–69: Moat is stated but sounds like a snapshot advantage rather than a growing one.

Score 30–49: Moat is asserted without argument ("our AI models are better").

Score 0–29: No moat articulated. Competition is dismissed without reasoning.

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
