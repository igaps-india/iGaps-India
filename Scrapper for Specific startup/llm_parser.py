"""
llm_parser.py
Standalone VC Data Enrichment Pipeline — AI Extraction Brain

Uses the new google-genai SDK (google.genai) — NOT the deprecated google-generativeai.

Environment variables:
  GOOGLE_API_KEY  — Google AI / Gemini API key (required)
  GEMINI_MODEL    (optional) — defaults to 'gemini-2.5-flash'
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from google import genai
from google.genai import types as genai_types
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Gemini configuration
# ---------------------------------------------------------------------------
_GEMINI_MODEL: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
_GOOGLE_API_KEY: str = os.environ.get("GOOGLE_API_KEY", "")

if not _GOOGLE_API_KEY:
    logger.warning(
        "GOOGLE_API_KEY is not set. Gemini calls will fail. "
        "Add GOOGLE_API_KEY=... to your .env file."
    )

_client: genai.Client | None = None

def _get_client() -> genai.Client:
    """Lazy-initialise the Gemini client (avoids errors at import time)."""
    global _client
    if _client is None:
        _client = genai.Client(api_key=_GOOGLE_API_KEY)
    return _client


def _call_gemini(prompt: str) -> str:
    """
    Send *prompt* to Gemini and return the raw response text.
    temperature=0.0  — zero randomness, no hallucinated facts.
    response_mime_type='application/json' — constrains output to JSON.
    """
    client = _get_client()
    response = client.models.generate_content(
        model=_GEMINI_MODEL,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
        ),
    )
    return response.text


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """\
You are a precise data-extraction assistant. Your ONLY job is to parse raw text
scraped from a LinkedIn company page and return a valid JSON object — nothing else.

OUTPUT RULES (STRICT — violations will break the pipeline):
1. Reply with ONLY a raw JSON object. No markdown, no code fences (```), no
   introductory sentences, no trailing commentary.
2. NEVER invent, infer, or fabricate any information. Only extract what is
   EXPLICITLY present in the provided text.
3. The JSON must have EXACTLY these four top-level keys:
   - "domain"         : the company's official website domain (e.g. "stripe.com").
                        You MUST extract this. If it is not explicitly listed,
                        deduce it from the company name if it is highly obvious
                        (e.g. company name "Stripe" → domain "stripe.com").
                        Only use null if you have absolutely no basis to infer it.
   - "location"       : the company's primary city / country (e.g. "San Francisco, CA").
                        If not found, use null.
   - "employee_count" : the headcount range shown on the page (e.g. "51-200 employees").
                        If not found, use null.
   - "founders"       : a JSON array of founder/executive objects (see below).
                        If none are found, use an empty array [].
4. Each object in the "founders" array must have EXACTLY these keys:
   - "first_name"   (string, required)
   - "last_name"    (string, required)
   - "role"         (string — preserve the exact title from the page, e.g.
                     "Founder", "Co-Founder", "CEO", "Chief Executive Officer")
   - "linkedin_url" (string — the person's full LinkedIn profile URL,
                     e.g. "https://www.linkedin.com/in/johndoe". Use null if not present.)
5. Only include people whose title contains at least one of:
   Founder | Co-Founder | Co Founder | CEO | Chief Executive Officer
6. Do NOT invent or infer information for names, roles, or linkedin_url.
   Only extract what is explicitly present in the text.

EXAMPLE OF A VALID OUTPUT (data is FICTIONAL — do NOT copy):
{"domain": "[domain]", "location": "[City, Country]", "employee_count": "[N]-[M] employees", "founders": [{"first_name": "[First]", "last_name": "[Last]", "role": "Co-Founder & CEO", "linkedin_url": "https://www.linkedin.com/in/[slug]"}]}
"""

_HUMAN_TEMPLATE = """\
Parse the following raw text scraped from a company's LinkedIn page.
Extract the company domain, location, employee count, and any founders / CEOs
exactly as instructed above.

--- RAW PAGE TEXT (start) ---
{page_text}
--- RAW PAGE TEXT (end) ---
"""

# ---------------------------------------------------------------------------
# Safe empty defaults
# ---------------------------------------------------------------------------
_EMPTY_RESULT: dict[str, Any] = {
    "domain": None,
    "location": None,
    "employee_count": None,
    "founders": [],
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _strip_code_fences(raw: str) -> str:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    return cleaned


def _rescue_truncated_json(raw_text: str) -> list[dict[str, Any]]:
    blocks = re.split(r'\}\s*,\s*\{|\[\s*\{|\{\s*"first', raw_text)
    validated = []
    for block in blocks:
        if not block.strip():
            continue
        first_match = re.search(r'"first_name"\s*:\s*"([^"]+)"', block)
        last_match  = re.search(r'"last_name"\s*:\s*"([^"]+)"', block)
        role_match  = re.search(r'"role"\s*:\s*"([^"]+)"', block)
        li_match    = re.search(r'"linkedin_url"\s*:\s*("([^"]+)"|null)', block)
        if first_match and last_match:
            first = first_match.group(1).strip()
            last  = last_match.group(1).strip()
            role  = role_match.group(1).strip() if role_match else "Founder"
            li_url = None
            if li_match:
                val = li_match.group(1)
                if val != "null":
                    li_url = val.strip('"')
            validated.append({"first_name": first, "last_name": last, "role": role, "linkedin_url": li_url})
    return validated


def _validate_and_parse(raw_text: str) -> dict[str, Any]:
    cleaned = _strip_code_fences(raw_text)
    try:
        data: Any = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.error("JSON parse error: %s\nAttempting regex rescue...", exc)
        domain_match   = re.search(r'"domain"\s*:\s*"([^"]+)"', raw_text)
        location_match = re.search(r'"location"\s*:\s*"([^"]+)"', raw_text)
        employee_match = re.search(r'"employee_count"\s*:\s*"([^"]+)"', raw_text)
        rescued_founders = _rescue_truncated_json(raw_text)
        return {
            "domain":         domain_match.group(1) if domain_match else None,
            "location":       location_match.group(1) if location_match else None,
            "employee_count": employee_match.group(1) if employee_match else None,
            "founders":       rescued_founders,
        }

    if not isinstance(data, dict):
        logger.error("Unexpected top-level type %s — expected dict.", type(data))
        return _EMPTY_RESULT

    result: dict[str, Any] = {
        "domain":         data.get("domain"),
        "location":       data.get("location"),
        "employee_count": data.get("employee_count"),
        "founders":       [],
    }
    raw_founders = data.get("founders", [])
    if not isinstance(raw_founders, list):
        return result
    for entry in raw_founders:
        if not isinstance(entry, dict):
            continue
        first = str(entry.get("first_name", "")).strip()
        last  = str(entry.get("last_name",  "")).strip()
        role  = str(entry.get("role", "Founder")).strip()
        li_url = entry.get("linkedin_url")
        if isinstance(li_url, str):
            li_url = li_url.strip() or None
        if first and last:
            result["founders"].append({"first_name": first, "last_name": last, "role": role, "linkedin_url": li_url})
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_company_page(page_text: str) -> dict[str, Any]:
    if not page_text or not page_text.strip():
        logger.warning("Empty page_text received — returning empty result.")
        return _EMPTY_RESULT
    MAX_CHARS = 50_000
    if len(page_text) > MAX_CHARS:
        page_text = page_text[:MAX_CHARS]
    prompt = _SYSTEM_PROMPT + "\n\n" + _HUMAN_TEMPLATE.format(page_text=page_text)
    try:
        logger.info("Invoking Gemini (%s) for company page extraction …", _GEMINI_MODEL)
        raw_output = _call_gemini(prompt)
        logger.debug("Raw response (first 400 chars):\n%s", raw_output[:400])
        result = _validate_and_parse(raw_output)
        logger.info(
            "Extraction complete — domain=%s | location=%s | employees=%s | founders=%d",
            result["domain"], result["location"], result["employee_count"], len(result["founders"]),
        )
        return result
    except Exception as exc:
        logger.error("Gemini call failed: %s", exc, exc_info=True)
        return _EMPTY_RESULT


# ---------------------------------------------------------------------------
# Dork fallback — founders only
# ---------------------------------------------------------------------------

_DORK_SYSTEM_PROMPT = """\
You are a precise data-extraction assistant. Your ONLY job is to parse raw text
from a Google search results page (which lists LinkedIn profile snippets) and
return a valid JSON object — nothing else.

OUTPUT RULES (STRICT):
1. Reply with ONLY a raw JSON object. No markdown, no code fences, no commentary.
2. The JSON must have exactly TWO top-level keys:
   - "domain": the company's official website domain. Deduce from company name if obvious.
     Only use null if you have absolutely no basis to infer it.
   - "founders": a JSON array of founder objects. Empty array [] if none found.
3. Each founder object must have EXACTLY these keys:
   - "first_name", "last_name", "role", "linkedin_url" (null if not visible)
4. Only include people whose snippet mentions: Founder | Co-Founder | CEO | Chief Executive Officer
5. Do NOT invent information.

EXAMPLE OUTPUT:
{"domain": "microsoft.com", "founders": [{"first_name": "Satya", "last_name": "Nadella", "role": "CEO", "linkedin_url": "https://www.linkedin.com/in/satyanadella"}]}
"""

_DORK_HUMAN_TEMPLATE = """\
Parse the following raw text from a Google search results page.
Extract any Founders or CEOs of the target company as instructed.

--- RAW SEARCH TEXT (start) ---
{dork_text}
--- RAW SEARCH TEXT (end) ---
"""

_EMPTY_DORK_RESULT: dict[str, Any] = {"domain": None, "founders": []}


def extract_founders_from_dork(raw_dork_text: str) -> dict[str, Any]:
    if not raw_dork_text or not raw_dork_text.strip():
        return _EMPTY_DORK_RESULT
    raw_dork_text = raw_dork_text[:20_000]
    prompt = _DORK_SYSTEM_PROMPT + "\n\n" + _DORK_HUMAN_TEMPLATE.format(dork_text=raw_dork_text)
    raw_output = ""
    try:
        logger.info("Invoking Gemini (%s) for dork-based founder extraction ...", _GEMINI_MODEL)
        raw_output = _call_gemini(prompt)
        cleaned = _strip_code_fences(raw_output)
        data    = json.loads(cleaned)
        domain = data.get("domain") if isinstance(data, dict) else None
        raw_founders = data.get("founders", []) if isinstance(data, dict) else []
        validated: list[dict[str, Any]] = []
        for entry in raw_founders:
            if not isinstance(entry, dict):
                continue
            first  = str(entry.get("first_name", "")).strip()
            last   = str(entry.get("last_name",  "")).strip()
            role   = str(entry.get("role", "Founder")).strip()
            li_url = entry.get("linkedin_url")
            if isinstance(li_url, str):
                li_url = li_url.strip() or None
            if first and last:
                validated.append({"first_name": first, "last_name": last, "role": role, "linkedin_url": li_url})
        return {"domain": domain, "founders": validated}
    except Exception as exc:
        logger.error("Dork Gemini call failed: %s", exc, exc_info=True)
        return _EMPTY_DORK_RESULT


# ---------------------------------------------------------------------------
# Company Overview Parser — merges LinkedIn + website data
# ---------------------------------------------------------------------------

_OVERVIEW_SYSTEM_PROMPT = """\
You are a precise data-extraction assistant. Your ONLY job is to parse raw text
from a LinkedIn company page AND (optionally) a company website homepage, then
return a single valid JSON object describing the company — nothing else.

OUTPUT RULES (STRICT):
1. Reply with ONLY a raw JSON object. No markdown, no code fences (```),
   no introductory text, no trailing commentary.
2. The JSON must have EXACTLY these top-level keys (use null if not found):
   - "company_name"   : official company name as shown.
   - "domain"         : official website domain, e.g. "stripe.com".
   - "location"       : primary city / country, e.g. "Bengaluru, India".
   - "employee_count" : headcount range, e.g. "51-200 employees".
   - "industry"       : the industry or sector, e.g. "Fintech", "HealthTech".
   - "description"    : 1-3 sentence company description / tagline.
   - "founded_year"   : year the company was founded, e.g. "2018". Use null if unknown.
   - "hq_address"     : physical HQ address if explicitly mentioned. Use null if not found.
3. Prefer LinkedIn data when there is a conflict. Use website data to fill gaps.
4. Do NOT invent or infer data beyond what is present in the provided text.

EXAMPLE OUTPUT:
{"company_name": "Stripe", "domain": "stripe.com", "location": "South San Francisco, CA", "employee_count": "1,001-5,000 employees", "industry": "Fintech", "description": "Stripe is a financial infrastructure platform for businesses.", "founded_year": "2010", "hq_address": null}
"""

_OVERVIEW_HUMAN_TEMPLATE = """\
Extract the company overview from the following sources.

--- LINKEDIN PAGE TEXT (start) ---
{linkedin_text}
--- LINKEDIN PAGE TEXT (end) ---

--- COMPANY WEBSITE TEXT (start) ---
{website_text}
--- COMPANY WEBSITE TEXT (end) ---
"""

_EMPTY_OVERVIEW: dict[str, Any] = {
    "company_name": None,
    "domain": None,
    "location": None,
    "employee_count": None,
    "industry": None,
    "description": None,
    "founded_year": None,
    "hq_address": None,
}


def parse_company_overview(
    linkedin_text: str | None,
    website_text: str | None = None,
) -> dict[str, Any]:
    """
    Merge raw LinkedIn company page text and (optional) website homepage text
    into a structured Company_Overview dict via Gemini.
    """
    li_text = (linkedin_text or "").strip()
    ws_text = (website_text or "").strip()

    if not li_text and not ws_text:
        logger.warning("parse_company_overview: both inputs are empty.")
        return _EMPTY_OVERVIEW

    li_text = li_text[:25_000]
    ws_text = ws_text[:25_000]

    prompt = _OVERVIEW_SYSTEM_PROMPT + "\n\n" + _OVERVIEW_HUMAN_TEMPLATE.format(
        linkedin_text=li_text or "(not available)",
        website_text=ws_text or "(not available)",
    )

    raw_output = ""
    try:
        logger.info("Invoking Gemini (%s) for company overview extraction …", _GEMINI_MODEL)
        raw_output = _call_gemini(prompt)
        logger.debug("Company overview raw response (first 400 chars):\n%s", raw_output[:400])

        cleaned = _strip_code_fences(raw_output)
        data = json.loads(cleaned)

        if not isinstance(data, dict):
            logger.error("parse_company_overview: unexpected top-level type %s.", type(data))
            return _EMPTY_OVERVIEW

        overview: dict[str, Any] = {key: data.get(key) for key in _EMPTY_OVERVIEW}
        logger.info(
            "Company overview extracted — name=%s | domain=%s | industry=%s | employees=%s",
            overview.get("company_name"), overview.get("domain"),
            overview.get("industry"), overview.get("employee_count"),
        )
        return overview

    except json.JSONDecodeError as exc:
        logger.error("parse_company_overview: JSON parse error: %s", exc)
        overview = dict(_EMPTY_OVERVIEW)
        for field in _EMPTY_OVERVIEW:
            m = re.search(rf'"{field}"\s*:\s*"([^"]+)"', raw_output)
            if m:
                overview[field] = m.group(1)
        return overview

    except Exception as exc:
        logger.error("parse_company_overview: Gemini call failed: %s", exc, exc_info=True)
        return _EMPTY_OVERVIEW
