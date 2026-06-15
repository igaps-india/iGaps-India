"""
VectorSimilarityScorer.py
─────────────────────────────────────────────────────────────────────────────
Scores founder answers for 6 specific signals using local sentence-transformer
embeddings + cosine similarity. No external API calls. Runs in < 10ms after
the first warm-up.

HOW IT WORKS:
  1. Each signal has a set of "Perfect Answer" anchors (what a great answer
     looks like) and "Terrible Answer" anchors (what a bad answer looks like).
  2. We embed the founder's actual answer + all anchors using all-MiniLM-L6-v2.
  3. We compute cosine similarity to the perfect anchors (sim_good) and
     terrible anchors (sim_bad).
  4. Score = clamp((sim_good - sim_bad + 1) / 2 * 100, 0, 100)
     This maps the [-1, 1] cosine range to [0, 100].

WHY THIS WORKS:
  These 6 signals all have a clear directional pattern that vector space
  captures well (e.g. "specific human story" vs "demographic description").
  They do NOT require reasoning about external facts — just semantic direction.

SIGNALS COVERED:
  1. openQ4_persona_vividity_score      — Specific person vs demographic
  2. openQ4_problem_customer_language   — Customer voice vs pitch voice
  3. openQ7_solution_persona_fit        — Built-for-me vs generic solution
  4. openQ3_leverage_specificity        — Specific insight vs vague claim
  5. openQ10_customer_initiated         — Unprompted demand vs engineered demand
  6. derived_problem_severity           — Quantified pain vs vague pain claim
"""

from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np
import logging

logger = logging.getLogger(__name__)

# ── Informal / Hinglish language normalizer ───────────────────────────────────
# Indian founders frequently write in informal English or Hinglish.
# The sentence-transformer model was trained on formal English, so it silently
# penalizes regional phrases even when the underlying SUBSTANCE is strong.
# This normalizer converts known informal patterns to their formal equivalents
# BEFORE embedding — the score then reflects content, not polish.
#
# This is NOT a grammar corrector. It only maps business-context phrases that
# systematically appear in Indian founder writing and would otherwise reduce
# cosine similarity to formal anchor texts.

INFORMAL_PATTERNS: list[tuple[str, str]] = [
    # Hinglish filler words and emphasis markers
    (r'\bhi\b',          ''),          # "customers hi" → "customers"
    (r'\bna\b',          ''),          # "right na" → "right"
    (r'\bnahi\b',        'not'),
    (r'\bnah\b',         'not'),
    (r'\bhai\b',         'is'),
    (r'\btha\b',         'was'),
    (r'\bkar\b',         'do'),
    (r'\bbas\b',         'only'),
    (r'\bse\b',          'from'),
    (r'\bke liye\b',     'for'),
    (r'\bonly\b',        'specifically'),   # Indian English "only" used for emphasis
    (r'\bitself\b',      'specifically'),   # "the product itself" in Indian English
    # Common informal contractions / shortcuts
    (r'\bwrt\b',         'with respect to'),
    (r'\bw\/r\/t\b',     'with respect to'),
    (r'\btbh\b',         'honestly'),
    (r'\bfyi\b',         'for reference'),
    (r'\bbtw\b',         'additionally'),
    (r'\bv\b',           'we'),            # "v decided" → "we decided"
    (r'\bu\b',           'you'),
    (r'\br\b',           'are'),
    (r'\bppl\b',         'people'),
    (r'\bcoz\b',         'because'),
    (r'\bcause\b',       'because'),
    (r'\bcus\b',         'because'),
    (r'\bcos\b',         'because'),
    (r'\bgonna\b',       'going to'),
    (r'\bwanna\b',       'want to'),
    (r'\bgotta\b',       'have to'),
    (r'\bkinda\b',       'somewhat'),
    (r'\bsorta\b',       'somewhat'),
    (r'\blotta\b',       'a lot of'),
    (r'\bdunno\b',       'do not know'),
    (r'\byeah\b',        'yes'),
    (r'\bnope\b',        'no'),
    (r'\byup\b',         'yes'),
    # Informal punctuation / spacing patterns
    (r'\.{3,}',          '. '),           # "so..." → "so."
    (r'!{2,}',           '!'),
    (r'\?{2,}',          '?'),
]

import re

def normalize_informal_language(text: str) -> str:
    """
    Apply lightweight normalization to map informal/Hinglish patterns to
    formal English equivalents before embedding.
    Returns the normalized text and a flag if bias markers were detected.
    """
    normalized = text
    for pattern, replacement in INFORMAL_PATTERNS:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)
    # Collapse multiple spaces produced by deletions
    normalized = re.sub(r'  +', ' ', normalized).strip()
    return normalized


def detect_linguistic_bias(text: str) -> dict:
    """
    Detect whether this answer shows markers of informal or regional writing
    that could unfairly reduce similarity scores.
    Returns a dict with bias_detected (bool) and individual signal flags.
    """
    words = text.split()
    sentences = [s.strip() for s in re.split(r'[.!?]', text) if s.strip()]

    avg_sentence_length = len(words) / max(len(sentences), 1)
    unique_words = len(set(w.lower() for w in words))
    type_token_ratio = unique_words / max(len(words), 1)

    # Regional/Hinglish marker presence
    hinglish_markers = ['only', 'itself', 'na', 'nahi', 'hai', 'kar',
                        'se', 'ke liye', 'bas', 'wrt', 'coz', 'dunno']
    hinglish_count = sum(1 for m in hinglish_markers if m.lower() in text.lower())
    hinglish_score = hinglish_count / len(hinglish_markers)

    bias_signals = {
        'short_sentences':     avg_sentence_length < 8,
        'low_vocab_diversity': type_token_ratio < 0.45,
        'regional_markers':    hinglish_score > 0.10,
    }
    bias_count = sum(bias_signals.values())
    return {
        'bias_detected': bias_count >= 2,
        'bias_level':    'HIGH' if bias_count >= 3 else 'MEDIUM' if bias_count == 2 else 'LOW',
        'signals':       bias_signals,
    }


# ── Model (loaded once at startup, not per-request) ───────────────────────────
# all-MiniLM-L6-v2: 22MB, 80ms on CPU, 384-dim embeddings.
# Perfect balance of speed and quality for semantic sentence comparison.
_model: SentenceTransformer | None = None

def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        logger.info("[VectorScorer] Loading all-MiniLM-L6-v2 model...")
        _model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        logger.info("[VectorScorer] Model loaded and warmed up.")
    return _model


# ── Answer Anchor Templates ───────────────────────────────────────────────────
# These were written by domain experts to represent the ideal and terrible
# versions of each signal. They act as reference points in vector space.
#
# RULE: Perfect answers are specific, evidence-backed, concrete.
#       Terrible answers are vague, generic, buzzword-heavy.

SIGNAL_ANCHORS: dict[str, dict[str, list[str]]] = {

    # ── Signal 1: Persona Vividity ────────────────────────────────────────────
    # Does the founder describe a real specific human, or a demographic category?
    "openQ4_persona_vividity_score": {
        "perfect": [
            "Her name is Priya. She is 34, a head nurse at Kokilaben Hospital in Mumbai. "
            "She works 12-hour shifts and spends her last hour filling in discharge forms by hand. "
            "She has three children. She skips lunch to catch up on paperwork.",

            "Ramesh is a 58-year-old kirana store owner in Coimbatore. He keeps his stock list "
            "in a spiral notebook. His son tried to get him on Tally twice, he uninstalled it both times. "
            "He trusts his memory more than software.",

            "Our user is Ananya, a solo CA practitioner in Pune. She manages 47 clients during "
            "tax season using WhatsApp and Excel. She bills 30% less than she should because "
            "she underestimates time spent.",
        ],
        "terrible": [
            "Our target customer is small and medium enterprises in India with 10 to 50 employees "
            "who need better productivity solutions.",

            "We are targeting millennial professionals aged 25 to 35 who are tech-savvy and "
            "looking for innovative digital solutions.",

            "Our customer segment consists of B2B companies in the healthcare sector that "
            "need digital transformation and operational efficiency.",
        ],
    },

    # ── Signal 2: Problem Customer Language ──────────────────────────────────
    # Does the founder use the exact words customers use, or pitch/marketing language?
    "openQ4_problem_customer_language_score": {
        "perfect": [
            "Every time I talked to a hospital admin, they said the same thing: "
            "'We lose three hours a day just chasing doctors for signatures.' "
            "That phrase came up in 11 of 14 interviews, almost word for word.",

            "Founders kept telling us: 'By the time our CA sends us the numbers, we've already "
            "made the decision.' They didn't say 'delayed financial reporting'. They said "
            "'I'm flying blind every month.'",

            "The phrase we heard was 'I feel like I'm managing the software instead of "
            "the software managing me.' That became our positioning tagline because it came "
            "directly from a user, not from us.",
        ],
        "terrible": [
            "The problem we are solving is the lack of digital transformation and operational "
            "inefficiency in the healthcare ecosystem which leads to suboptimal outcomes.",

            "Businesses today are struggling with siloed data, fragmented workflows, and "
            "the inability to leverage AI for decision-making at scale.",

            "The market opportunity is driven by the growing demand for SaaS solutions that "
            "address the core pain points of enterprise customers.",
        ],
    },

    # ── Signal 3: Solution Persona Fit ───────────────────────────────────────
    # Would the specific persona say "this was built exactly for me"?
    "openQ7_solution_persona_fit_score": {
        "perfect": [
            "We built the whole workflow around the fact that our users are on mobile in a "
            "loud factory floor. No keyboard, no quiet room. Everything is voice-first and "
            "confirms back in under 3 taps.",

            "Our onboarding has zero text. It is entirely demo-based. We built this because "
            "our first 20 users were dairy farmers in Gujarat who had never installed an app before. "
            "They needed to see it work before they would type anything.",

            "The key decision in our design was: the report must arrive before the morning "
            "stand-up. Our persona — the plant manager — starts at 7am. So our digest "
            "runs at 6:45am automatically, not on-demand.",
        ],
        "terrible": [
            "Our solution provides a comprehensive platform that addresses all the needs of "
            "businesses through our AI-powered suite of tools and integrations.",

            "We have built a scalable, modular system that can be customized for any use case "
            "in any industry, making it highly versatile.",

            "Our platform leverages cutting-edge machine learning to provide insights that "
            "help organizations make data-driven decisions and improve ROI.",
        ],
    },

    # ── Signal 4: Leverage Specificity ───────────────────────────────────────
    # Does the founder have a specific, non-obvious insight that gives them an advantage?
    "openQ3_leverage_specificity_score": {
        "perfect": [
            "I spent 8 years as a compliance officer at HDFC. I know exactly which SEBI circular "
            "every wealth manager dreads, and I know the informal workaround that 80% of them use. "
            "We built our product around that workaround becoming illegal in 2026.",

            "My co-founder is the person who wrote the ICU staffing algorithm used in 6 government "
            "hospitals in Maharashtra. She has the data, the relationships, and the credibility. "
            "Nobody else can get that data.",

            "We discovered that 78% of the delays in chemical plant shutdowns happen in the "
            "permit-to-work process, not in the maintenance itself. This is the opposite of "
            "what everyone assumes. We built for the permit, not the maintenance.",
        ],
        "terrible": [
            "We have deep expertise in this domain and our team has over 20 years of combined "
            "experience in technology and business.",

            "Our competitive advantage comes from our superior technology, strong team, "
            "and first-mover advantage in this space.",

            "We are uniquely positioned because we understand the market deeply and have "
            "strong networks in the industry.",
        ],
    },

    # ── Signal 5: Customer Initiated Demand ──────────────────────────────────
    # Did customers come to the founder unprompted, or was all demand engineered?
    "openQ10_customer_initiated_score": {
        "perfect": [
            "Our first three customers found us. One saw my LinkedIn post and messaged me at midnight. "
            "Two came via a referral from a hospital administrator I had never met. "
            "I had not pitched any of them.",

            "I posted a one-paragraph description of the problem in a WhatsApp group for CAs. "
            "Within two hours, 12 people asked me to be beta users. I had not even mentioned a product.",

            "The hospital director called us six months after our pilot ended. She had been "
            "tracking the results internally and wanted to pay for a full deployment. "
            "We had not followed up once.",
        ],
        "terrible": [
            "We acquired our first customers through a combination of cold outreach, "
            "LinkedIn campaigns, and attending industry conferences and networking events.",

            "Our go-to-market strategy involves targeted digital marketing, partnerships "
            "with industry associations, and a dedicated sales team.",

            "We generated initial traction through our extensive network and by offering "
            "free trials to get our first 50 users on the platform.",
        ],
    },

    # ── Signal 6: Problem Severity / Quantified Pain ─────────────────────────
    # Does the founder quantify the pain with real numbers, or describe it vaguely?
    "openQ5_problem_severity_score": {
        "perfect": [
            "A nurse spends 4.2 hours per 12-hour shift on documentation. That is 35% of their "
            "time. In a 100-bed hospital, that is 40 nursing hours lost per day — at Rs 800/hour, "
            "that is Rs 32,000 of waste per day, Rs 1.2 crore per year, per hospital.",

            "The average Indian SME waits 47 days for their CA to close the books after quarter-end. "
            "During those 47 days, the founder is making hiring and spending decisions without "
            "accurate data. We verified this across 34 businesses in our research.",

            "Manual quality checks at the factory take 6.5 hours per batch. Automation cuts "
            "this to 40 minutes. Our pilot at Bharat Forge reduced defect escape rate from "
            "3.2% to 0.4% over 90 days.",
        ],
        "terrible": [
            "This is a massive problem that affects millions of people across India. "
            "The market is huge and growing rapidly due to increasing digitization.",

            "The current solutions are inefficient and costly. Businesses are losing "
            "significant time and money due to outdated processes.",

            "The problem is significant and our solution addresses the core challenges "
            "faced by companies in this space today.",
        ],
    },
}


# ── Cached embeddings (pre-computed at startup for speed) ─────────────────────
_anchor_cache: dict[str, dict[str, np.ndarray]] | None = None

def get_anchor_cache() -> dict[str, dict[str, np.ndarray]]:
    """Pre-compute and cache anchor embeddings so per-request latency is minimal."""
    global _anchor_cache
    if _anchor_cache is not None:
        return _anchor_cache

    model = get_model()
    logger.info("[VectorScorer] Pre-computing anchor embeddings...")
    _anchor_cache = {}

    for signal_key, anchors in SIGNAL_ANCHORS.items():
        perfect_embeddings = model.encode(anchors["perfect"], convert_to_numpy=True)
        terrible_embeddings = model.encode(anchors["terrible"], convert_to_numpy=True)
        _anchor_cache[signal_key] = {
            "perfect": perfect_embeddings,   # shape: (n_perfect, 384)
            "terrible": terrible_embeddings, # shape: (n_terrible, 384)
        }

    logger.info(f"[VectorScorer] Cached embeddings for {len(_anchor_cache)} signals.")
    return _anchor_cache


# ── Core Scoring Function ─────────────────────────────────────────────────────

def score_with_vector_similarity(signal_key: str, answer_text: str) -> dict:
    """
    Score a founder's answer for a specific signal using vector similarity.

    Args:
        signal_key: One of the 6 supported signal keys (see SIGNAL_ANCHORS).
        answer_text: The founder's raw answer text.

    Returns:
        A dict with:
          - score: int (0–100)
          - confidence: 'high' | 'medium' | 'low'
          - sim_to_perfect: float (0–1)
          - sim_to_terrible: float (0–1)
          - scoring_method: 'vector_similarity'
          - signal_key: str
    """
    if signal_key not in SIGNAL_ANCHORS:
        return {
            "score": 0,
            "confidence": "low",
            "sim_to_perfect": 0.0,
            "sim_to_terrible": 0.0,
            "scoring_method": "vector_similarity",
            "signal_key": signal_key,
            "error": f"Signal '{signal_key}' not supported by VectorSimilarityScorer. "
                     f"Supported: {list(SIGNAL_ANCHORS.keys())}",
        }

    if not answer_text or len(answer_text.strip()) < 20:
        return {
            "score": 0,
            "confidence": "low",
            "sim_to_perfect": 0.0,
            "sim_to_terrible": 0.0,
            "scoring_method": "vector_similarity",
            "signal_key": signal_key,
            "error": "Answer is too short to meaningfully evaluate.",
        }

    model = get_model()
    cache = get_anchor_cache()

    # ── Informal language normalization ──────────────────────────────────────
    # Detect if the founder writes informally / in Hinglish BEFORE normalizing.
    # We store the raw bias detection result and return it with the score so
    # the evaluation engine can apply the inarticulate genius flag if needed.
    bias_info   = detect_linguistic_bias(answer_text)
    clean_text  = normalize_informal_language(answer_text.strip())

    # Embed the normalized text (formal equivalent) — NOT the raw answer
    answer_embedding = model.encode([clean_text], convert_to_numpy=True)  # shape: (1, 384)

    # Compute max cosine similarity to perfect anchors
    sim_to_perfect_matrix = cosine_similarity(answer_embedding, cache[signal_key]["perfect"])
    sim_to_perfect = float(np.max(sim_to_perfect_matrix))  # Best match to any perfect anchor

    # Compute max cosine similarity to terrible anchors
    sim_to_terrible_matrix = cosine_similarity(answer_embedding, cache[signal_key]["terrible"])
    sim_to_terrible = float(np.max(sim_to_terrible_matrix))  # Best match to any terrible anchor

    # Score formula: maps cosine similarity difference into [0, 100]
    # sim values are in [-1, 1] but in practice for sentence pairs, [0.0, 1.0]
    # score = clamp((sim_good - sim_bad + 1) / 2 * 100, 0, 100)
    raw_score = (sim_to_perfect - sim_to_terrible + 1.0) / 2.0 * 100.0
    score = int(max(0, min(100, raw_score)))

    # Confidence: how clear is the separation between good and bad?
    separation = sim_to_perfect - sim_to_terrible
    if separation > 0.25:
        confidence = "high"
    elif separation > 0.05:
        confidence = "medium"
    else:
        # Too close to call — answer is ambiguous
        confidence = "low"

    return {
        "score":           score,
        "confidence":      confidence,
        "sim_to_perfect":  round(sim_to_perfect, 4),
        "sim_to_terrible": round(sim_to_terrible, 4),
        "scoring_method":  "vector_similarity",
        "signal_key":      signal_key,
        "bias_detected":   bias_info['bias_detected'],
        "bias_level":      bias_info['bias_level'],
    }
