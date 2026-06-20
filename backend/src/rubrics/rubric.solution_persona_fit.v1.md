# rubric.solution_persona_fit.v1 — Solution in Persona Words
# Signal: openQ7_solution_persona_fit_score
# Source: openQ7 answer

## Task
Score whether the described solution is framed in terms the target persona would use — not in product/feature language.

## Scoring rubric (0–100)

Score 90–100: Solution described as "what it does for me today in my workflow" from the persona's perspective. No product feature jargon. Persona could read it and say "yes, that is exactly what I need."

Score 70–89: Mostly persona-centric but one or two feature-first phrases creep in.

Score 50–69: Mix of persona voice and product voice.

Score 30–49: Feature list presented as a solution.

Score 0–29: Pure product description with no persona voice. Could be a landing page tagline.

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
