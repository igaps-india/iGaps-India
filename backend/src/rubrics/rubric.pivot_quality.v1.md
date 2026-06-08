# rubric.pivot_quality.v1 — Pivot Quality
# Signal: openQ9_pivot_quality_score
# Source: openQ9 answer

## Task
Score the quality of the founder's pivot / direction-change story as revealed in openQ9 ("Tell me about a time you got something wrong and had to change direction").

## Scoring rubric (0–100)

Score 90–100: Founder describes a specific mistake with a clear failure signal, a fast and decisive response, and what they learned that they then built into the new direction. Speed-of-response and intellectual honesty are both high.

Score 70–89: Story is real and specific. Response was appropriate but slightly slow or incomplete.

Score 50–69: Story is real but the lesson learned is thin or the pivot was more of a tweak than a genuine direction change.

Score 30–49: Story is vague, no failure signal is named, or the pivot is described as external ("the market changed") rather than an admission of a mistake.

Score 0–29: Founder denies ever getting anything wrong, describes a non-pivot as a pivot, or answer is too short to evaluate.

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
