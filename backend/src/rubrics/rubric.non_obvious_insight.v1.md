# rubric.non_obvious_insight.v1 — Non-Obvious Insight
# Signal: openQ2_non_obvious_insight_score
# Source: openQ2 answer

## Task
Score the founder's answer to openQ2 ("What is the one thing you know about this problem that someone who has not lived your journey would simply not see?") on the specificity, non-obviousness, and verifiability of the insight.

## Scoring rubric (0–100)

Score 90–100 (Exceptional):
- The insight is hyper-specific, surprising, and clearly traceable to the founder's unique lived experience or deep domain immersion. A sophisticated industry veteran would say "I never thought of it that way." The insight has a direct implication for product/GTM strategy.

Score 70–89 (Strong):
- The insight is specific and interesting. It would not be obvious to an outsider. However, with effort, a researcher might eventually reach the same conclusion.

Score 50–69 (Adequate):
- The insight is valid but moderately well-known within the industry. Consultants or analysts in the space might share it. Still, the founder articulates it well and connects it to action.

Score 30–49 (Weak):
- The insight is a generic observation about a pain point ("the process is slow") or a commonly cited market gap. No unique angle is present.

Score 0–29 (Tar pit flag):
- The insight points to a problem that many smart people have tried and failed to solve before, and the founder is not aware of prior attempts. OR the answer is vague, circular, or too short to evaluate (<20 words).

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
