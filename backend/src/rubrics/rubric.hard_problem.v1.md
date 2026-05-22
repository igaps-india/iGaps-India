# rubric.hard_problem.v1 — Hard Problem Articulation
# Signal: openQ8_hard_problem_score
# Source: openQ8 answer

## Task
Score the specificity and credibility of the hardest problem the founder claims to have solved, and the degree to which they understand what would be hardest to copy.

## Scoring rubric (0–100)

Score 90–100: Founder names a specific hard problem (technical, operational, or regulatory) with a concrete description of why it was hard and what the solution required. Replication resistance is specific — not "network effects" but "our training data required 3 years of on-site hospital access that competitors cannot get."

Score 70–89: Problem is specific and hard. Replication resistance is acknowledged but stated generically.

Score 50–69: Problem sounds hard but is described at a high level. Replication resistance is asserted but not argued.

Score 30–49: Hard problem is a common engineering challenge. Nothing sounds unusually difficult for the space.

Score 0–29: No hard problem identified. Solution described as straightforward, or answer evades the question.

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
