# rubric.causality.v1 — Causality Chain Coherence
# Signal: openQ1_causality_coherence_score
# Source: openQ1 answer

## Task
Score the founder's answer to openQ1 ("How did you get to this point?") on the degree to which it presents a coherent causality chain from lived context → specific friction or opportunity → actionable insight → founding of this specific startup.

## Scoring rubric (0–100)

Score 90–100 (Exceptional):
- The narrative is specific and linear. A reader could draw an arrow from a concrete personal or professional experience, to a specific moment of friction or opportunity, to a surprising non-obvious insight, to the startup they are building. The insight is clearly NOT available to someone who had not lived that specific experience.

Score 70–89 (Strong):
- The narrative connects lived context to the startup, but one link in the chain is slightly vague or generic. The insight is still specific enough to be non-trivially derivable.

Score 50–69 (Adequate):
- The narrative mentions personal experience but the jump to the current startup is large. The insight is plausible but could have been reached by market research alone.

Score 30–49 (Weak):
- The narrative is mostly generic. Could have been written by someone with no direct experience. The startup could be justified by anyone reading the same industry report.

Score 0–29 (Very weak):
- No coherent narrative. Answer is circular ("I started because I saw a problem"), the startup is described but the personal journey is absent or disconnected, or the answer is too short to evaluate (<30 words).

## Output format (strict JSON)
{
  "score": <integer 0–100>,
  "band": "<exceptional|strong|adequate|weak|very_weak>",
  "evidence": "<1–3 sentences quoting or paraphrasing what drove the score>",
  "weaknesses": ["<specific weakness if any>"],
  "inarticulate_genius_flag": <true if score <=45 but the answer shows domain depth that language cannot express>
}
