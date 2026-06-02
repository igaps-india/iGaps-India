# -*- coding: utf-8 -*-
"""
insights_formatter.py
New Pipeline -- Profile Insights Formatter (Group 1 / Group 2)

Uses the new google-genai SDK (google.genai) — NOT the deprecated google-generativeai.

Environment variables:
  GOOGLE_API_KEY  -- Google AI / Gemini API key (required)
  GEMINI_MODEL    (optional) -- defaults to 'gemini-2.5-flash'
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
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

_MAX_RETRIES: int = 3
_RETRY_DELAY: float = 2.0

_client: genai.Client | None = None

def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=_GOOGLE_API_KEY)
    return _client


def _call_gemini(prompt: str) -> str:
    """
    Send *prompt* to Gemini and return the raw response string.
    temperature=0.0 — eliminates randomness.
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
# System prompt
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """\
You are an expert data-extraction AI. Your task is to process raw scraped text from a LinkedIn profile and output a highly structured, valid JSON object strictly adhering to the schema below. 

OUTPUT RULES (STRICT):
1. Reply with ONLY a raw JSON object. Do not include markdown formatting, code fences, or conversational text.
2. Extract information verbatim where possible. Do not summarize or lose quantitative metrics (e.g., revenue, team sizes, exact funding amounts).
3. Convert lists of skills and achievements into standard JSON string arrays.
4. Convert work experience and education into JSON arrays containing distinct objects for each role/school.
5. If a piece of information is missing from the text, use null. Do not invent or hallucinate data.
6. IGNORE POSTS AND ACTIVITY: Do NOT extract from any content that looks like social media posts, comments, or Activity feed items.

REQUIRED JSON SCHEMA:
{
  "person_name": "Full Name",
  "headline": "Profile Headline",
  "biography": "The 'About' section text, or null if missing",
  "education": [
    {
      "institution": "University/School Name",
      "degree": "e.g., MBA, BS",
      "field_of_study": "Major/Field",
      "duration": "e.g., 2010 - 2014",
      "marks_or_notes": "Activities, societies, or descriptions"
    }
  ],
  "early_achievements": [
    "Extract notable awards, early career wins, or recognitions into a list of strings."
  ],
  "work_experience": [
    {
      "role": "Job Title",
      "company": "Company Name",
      "employment_type": "Full-time, Part-time, etc.",
      "duration": "e.g., Jan 2020 - Present",
      "location": "City/Region",
      "setting": "Remote, On-site, Hybrid",
      "description": "Full description of responsibilities and achievements.",
      "key_metrics": {
        "custom_key_1": "Extract any hard numbers, funding amounts, or percentages here"
      }
    }
  ],
  "domain_skills": [
    "Extract the list of skills into an array of strings."
  ]
}
"""

_HUMAN_TEMPLATE = """\
Raw Profile Text:
{profile_text}

This profile belongs to a founder of {company_name} ({company_domain}).
Follow ALL rules above. Extract ONLY from the labelled sections. IGNORE any
Activity/post content. Do NOT summarize.
"""


# ---------------------------------------------------------------------------
# Safe empty defaults
# ---------------------------------------------------------------------------
_EMPTY_GROUP1: dict[str, Any] = {
    "education_and_marks": "",
    "early_achievements":  "",
}

_EMPTY_GROUP2: dict[str, Any] = {
    "work_experience": "",
    "domain_skills":   "",
}

_EMPTY_RESULT: dict[str, Any] = {
    "person_name": "",
    "headline": "",
    "biography": None,
    "education": [],
    "early_achievements": [],
    "work_experience": [],
    "domain_skills": []
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _strip_code_fences(raw: str) -> str:
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    return cleaned


def _validate_result(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        logger.error("_validate_result: top-level is not a dict (%s).", type(data))
        return _EMPTY_RESULT.copy()

    def _str(val: Any) -> str | None:
        if val is None:
            return None
        return str(val).strip()

    def _list(val: Any) -> list:
        if isinstance(val, list):
            return val
        return []

    return {
        "person_name": _str(data.get("person_name")),
        "headline": _str(data.get("headline")),
        "biography": _str(data.get("biography")),
        "education": _list(data.get("education")),
        "early_achievements": _list(data.get("early_achievements")),
        "work_experience": _list(data.get("work_experience")),
        "domain_skills": _list(data.get("domain_skills")),
    }


def _rescue_from_raw(raw: str) -> dict[str, Any]:
    result = _EMPTY_RESULT.copy()
    result["Group_1_General"]          = _EMPTY_GROUP1.copy()
    result["Group_2_Company_Specific"] = _EMPTY_GROUP2.copy()

    for field, group_key, sub_key in [
        (r'"education_and_marks"\s*:\s*"((?:[^"\\]|\\.)*)"',
         "Group_1_General",          "education_and_marks"),
        (r'"early_achievements"\s*:\s*"((?:[^"\\]|\\.)*)"',
         "Group_1_General",          "early_achievements"),
        (r'"work_experience"\s*:\s*"((?:[^"\\]|\\.)*)"',
         "Group_2_Company_Specific", "work_experience"),
        (r'"domain_skills"\s*:\s*"((?:[^"\\]|\\.)*)"',
         "Group_2_Company_Specific", "domain_skills"),
    ]:
        m = re.search(field, raw, re.DOTALL)
        if m:
            result[group_key][sub_key] = m.group(1).replace('\\"', '"').strip()
            logger.debug("_rescue_from_raw: recovered '%s'.", sub_key)

    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def format_profile_insights(
    raw_profile_text: str,
    company_name: str,
    company_domain: str,
) -> dict[str, Any]:
    """
    Send raw LinkedIn profile text to Gemini and return a structured dict.
    Retries up to MAX_RETRIES times on JSON parse errors.
    Falls back to regex rescue on all retries exhausted.
    """
    if not raw_profile_text or not raw_profile_text.strip():
        logger.warning("format_profile_insights: empty profile text — returning empty result.")
        return _EMPTY_RESULT

    print("DEBUG RAW TEXT (First 500 chars):", raw_profile_text[:500])
    print("-" * 60)

    MAX_CHARS = 80_000
    if len(raw_profile_text) > MAX_CHARS:
        logger.warning(
            "format_profile_insights: profile text truncated from %d -> %d chars.",
            len(raw_profile_text), MAX_CHARS,
        )
        raw_profile_text = raw_profile_text[:MAX_CHARS]

    prompt = _SYSTEM_PROMPT + "\n\n" + _HUMAN_TEMPLATE.format(
        company_name=company_name   or "Unknown",
        company_domain=company_domain or "Unknown",
        profile_text=raw_profile_text,
    )

    raw_output = ""
    last_exc: Exception | None = None

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            logger.info(
                "format_profile_insights: Gemini call attempt %d/%d ...",
                attempt, _MAX_RETRIES,
            )
            raw_output = _call_gemini(prompt)
            logger.debug("Raw Gemini response (first 600 chars):\n%s", raw_output[:600])

            cleaned = _strip_code_fences(raw_output)
            data    = json.loads(cleaned)
            result  = _validate_result(data)

            all_empty = all(
                not v
                for group in result.values()
                if isinstance(group, dict)
                for v in group.values()
            )
            if all_empty:
                logger.warning(
                    "format_profile_insights: all fields empty after attempt %d.",
                    attempt,
                )

            logger.info(
                "format_profile_insights: OK on attempt %d — "
                "edu=%d | achievements=%d | experience=%d | skills=%d",
                attempt,
                len(result.get("education", [])),
                len(result.get("early_achievements", [])),
                len(result.get("work_experience", [])),
                len(result.get("domain_skills", [])),
            )
            return result

        except json.JSONDecodeError as exc:
            last_exc = exc
            logger.warning(
                "format_profile_insights: JSON parse error attempt %d/%d: %s",
                attempt, _MAX_RETRIES, exc,
            )
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_DELAY)

        except Exception as exc:
            last_exc = exc
            logger.error(
                "format_profile_insights: Gemini failed attempt %d/%d: %s",
                attempt, _MAX_RETRIES, exc, exc_info=True,
            )
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_DELAY)

    logger.error(
        "format_profile_insights: all %d attempts failed. Last: %s. Trying regex rescue ...",
        _MAX_RETRIES, last_exc,
    )
    if raw_output:
        rescued = _rescue_from_raw(raw_output)
        any_rescued = any(
            v for group in rescued.values()
            if isinstance(group, dict)
            for v in group.values()
        )
        if any_rescued:
            logger.info("format_profile_insights: regex rescue recovered some fields.")
            return rescued

    logger.error(
        "format_profile_insights: all %d attempts failed. Last: %s.",
        _MAX_RETRIES, last_exc,
    )
    return _EMPTY_RESULT.copy()
