# rubric.need_gap_precision.v1 — Need Gap Precision
# Signal: openQ6_need_gap_precision_score
# Source: openQ6 answer

## Task
Score how precisely the founder articulates the gap between how things work today and how the customer wants them to work.

## Scoring rubric (0–100)

Score 90–100: Founder describes the exact current state, the exact desired state, and names the specific reason existing solutions fail to bridge that gap for this specific persona. The gap is measurable or observable.

Score 70–89: Gap is clear but the failure of existing solutions is vague ("they are too expensive / complex") without naming the root cause.

Score 50–69: Gap is described but may reflect the founder's perspective rather than the customer's. Existing solutions are not seriously considered.

Score 30–49: Gap is a generic pain statement. No current state / desired state structure.

Score 0–29: Circular or absent. Existing solutions are ignored. Answer is too short to evaluate.

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
