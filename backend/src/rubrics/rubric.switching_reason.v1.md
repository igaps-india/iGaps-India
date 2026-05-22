# rubric.switching_reason.v1 — Switching Reason Specificity
# Signal: openQ7_switching_reason_score
# Source: openQ7 answer (same source as solution_persona_fit)

## Task
Score the specificity and provability of the stated reason a current user of the best existing alternative would switch.

## Scoring rubric (0–100)

Score 90–100: Founder names a specific customer who switched (or would switch) and gives the exact reason tied to a measurable outcome, workflow change, or cost saving. The reason is specific to THIS solution, not generic.

Score 70–89: Switching reason is clear and specific but hypothetical rather than evidenced by an actual customer conversation.

Score 50–69: Switching reason is plausible but generic ("we are faster and cheaper").

Score 30–49: Founder does not address why someone would switch from the current alternative.

Score 0–29: No switching reason given. Solution described without comparison.

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–2 sentences>",
  "weaknesses": []
}
