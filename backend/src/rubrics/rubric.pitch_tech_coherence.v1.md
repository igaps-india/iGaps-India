# rubric.pitch_tech_coherence.v1 — Pitch Deck Technical Coherence
# Signal: upload_pitch_tech_coherence_score
# Source: parsed pitch deck text

## Task
Score whether the technical architecture described in the pitch deck is internally consistent — i.e., the claims made about AI/ML capabilities are plausible given the described training data, compute, and team.

## Scoring rubric (0–100)

Score 90–100: Architecture is clearly described, technically feasible, and consistent. Claims about model performance are tied to specific datasets, training approaches, or benchmarks. No magical claims.

Score 70–89: Architecture is plausible but some technical details are vague or inconsistently described.

Score 50–69: Architecture exists but makes one or two overclaims (e.g., "99.9% accuracy" with no methodology).

Score 30–49: Architecture is a black box. Technical claims are marketing language without substance.

Score 0–29: No technical description in pitch deck, or claims are clearly implausible for the team and stage described.

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
