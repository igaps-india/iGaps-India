# rubric.problem_customer_language.v1 — Problem in Customer Language
# Signal: openQ4_problem_customer_language_score
# Source: openQ4 answer

## Task
Score whether the founder describes the problem in the words of the person experiencing it — NOT in the language of an investor pitch, a product feature list, or an industry report.

## Scoring rubric (0–100)

Score 90–100: Answer contains at least one direct quote or highly specific paraphrase of what a real customer has said. The language is visceral, concrete, and specific to a moment in a person's work or life.

Score 70–89: Language is mostly customer-centric but contains one or two pitch-language phrases ("pain point", "inefficiency", "lacks visibility").

Score 50–69: A mix of customer language and pitch language. Possible that the founder is narrating what they think customers feel rather than what they actually said.

Score 30–49: Primarily pitch language. Problem is described in terms of market opportunity or industry trends rather than a human experience.

Score 0–29: Abstract, jargon-heavy, or clearly from a pitch deck template. No evidence of customer voice.

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
