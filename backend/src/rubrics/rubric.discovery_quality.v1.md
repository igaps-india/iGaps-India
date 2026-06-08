# rubric.discovery_quality.v1 — Discovery Quality
# Signal: openQ5_discovery_quality_score
# Source: openQ5 answer

## Task
Score the quality of customer discovery as revealed in openQ5 ("Walk me through your customer discovery").

## Scoring rubric (0–100)

Score 90–100: Founder names surprising specific findings, describes how a discovery changed their thinking, and mentions at least one counterintuitive stakeholder they spoke to. Discovery shaped the product, not the other way around.

Score 70–89: Discovery is real but the "what surprised you" and "what changed" are vague. Good breadth but depth is unclear.

Score 50–69: Discovery happened but sounds confirmatory — founder spoke to people who validated their existing hypothesis. No evidence of being surprised or changing direction.

Score 30–49: Discovery is described in aggregate ("we spoke to 20 people and they all said X") with no specific individual conversations or insights.

Score 0–29: No meaningful discovery. Founder describes desk research, or the answer is too short to assess.

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
