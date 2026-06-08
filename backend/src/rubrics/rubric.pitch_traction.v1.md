# rubric.pitch_traction.v1 — Pitch Deck Traction Claims
# Signal: upload_pitch_traction_score
# Source: parsed pitch deck text

## Task
Score the quality and credibility of traction claims in the pitch deck.

## Scoring rubric (0–100)

Score 90–100: Traction is presented with specific numbers, dates, and context. Claims are consistent with the closed-question traction stage. Growth trajectory is visible (e.g., month-over-month figures).

Score 70–89: Traction numbers are present but lack context (no comparison period, unclear units).

Score 50–69: Traction mentioned but vague ("strong customer response", "growing pipeline").

Score 30–49: Traction slide exists but is empty or contains only future projections.

Score 0–29: No traction data in pitch deck. OR traction claims in pitch deck contradict closed-question answers (flag for reviewer).

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
