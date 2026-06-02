"""
pipeline.py
New Founder Insights Pipeline — Main Orchestrator

Runs the full 5-step enrichment flow for a single startup given direct inputs.
No database polling — inputs are provided explicitly via CLI or function call.

STEP 1 — Company Data Extraction
  • Scrape LinkedIn /about/ + /people/ pages (authenticated cookie session).
  • Scrape the provided company website URL for additional context.
  • Merge both sources into a Company_Overview dict via Gemini (llm_parser.py).

STEP 2 — Co-Founder Discovery
  • Scan the raw People page text for titles: Co-founder, Co-Founder, Partner.
  • Exclude the known Founder Name.
  • Extract LinkedIn profile URL(s) for discovered co-founder(s).
  • Optional fallback: DuckDuckGo search if a co-founder name is found but
    no URL is visible on the People page.

STEP 3 — Individual Profile Extraction
  • Scrape the Founder's LinkedIn /in/ profile (authenticated).
  • Expand all sections (Education, Experience, Honors & Awards) before capture.
  • Scrape the Co-founder's LinkedIn /in/ profile (if found).
  • Log explicit errors if either scrape fails — never silently return null.

STEP 4 — Data Transformation & Grouping
  • Format each raw profile text via Gemini (insights_formatter.py) into:
      Group_1_General        : education_and_marks | early_achievements
      Group_2_Company_Specific: work_experience    | domain_skills
  • Retries up to 3 times on bad JSON before falling back to regex rescue.

STEP 5 — Database Load
  • Upsert Company_Overview, Founder_Insights, CoFounder_Insights into the
    `startup_insights` Supabase table via save_startup_insights() in db.py.

Usage (CLI):
    python pipeline.py \\
        --company-name   "Acme Inc" \\
        --website-url    "https://www.acme.com/about" \\
        --founder-name   "Jane Doe" \\
        --founder-email  "jane@acme.com" \\
        [--linkedin-url  "https://www.linkedin.com/company/acme-inc/"] \\
        [--founder-linkedin-url "https://www.linkedin.com/in/janedoe"] \\
        [--dry-run]

    --dry-run  Runs all steps but skips the Supabase write. Useful for testing.

Usage (as a module):
    from pipeline import run_pipeline
    run_pipeline(
        company_name="Acme Inc",
        website_url="https://www.acme.com/about",
        founder_name="Jane Doe",
        founder_email="jane@acme.com",
        linkedin_url="https://www.linkedin.com/company/acme-inc/",
    )

Environment variables:
    SUPABASE_URL   — Supabase project URL
    SUPABASE_KEY   — Supabase service-role key
    COOKIES_PATH   — (optional) path to linkedin_cookies.pkl
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Load environment BEFORE any module that reads env vars at import time
# ---------------------------------------------------------------------------
from dotenv import load_dotenv
load_dotenv()

import argparse
import logging
import random
import re
import sys
import time
import urllib.parse
from typing import Any, Optional

# ── Local pipeline modules ──────────────────────────────────────────────────
from founder_scraper import (
    scrape_company_people,
    discover_cofounders,
    scrape_linkedin_profile,
)
from website_scraper import scrape_specific_url, extract_domain_from_url
from llm_parser import parse_company_overview
from insights_formatter import format_profile_insights
from db import save_startup_insights

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("pipeline")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_SESSION_SLEEP_MIN: float = 4.0
_SESSION_SLEEP_MAX: float = 8.0


# ---------------------------------------------------------------------------
# Co-founder LinkedIn URL fallback (DuckDuckGo search)
# ---------------------------------------------------------------------------

def _search_linkedin_profile_url(full_name: str, company_name: str) -> Optional[str]:
    """
    Attempt to find a LinkedIn /in/ URL for *full_name* at *company_name*.

    Strategy 1: DuckDuckGo HTML search via requests (no headless browser —
                avoids CAPTCHA blocks that headless Selenium triggers).
    Strategy 2: Google dork search via requests as a second fallback.

    Returns the first matching URL or None.
    """
    import requests
    from bs4 import BeautifulSoup

    _HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    LI_PATTERN = re.compile(r"https?://(?:www\.)?linkedin\.com/in/[\w\-]+", re.I)

    # ── Strategy 1: DuckDuckGo HTML (requests, no browser) ──────────────────
    try:
        query = f'site:linkedin.com/in/ "{full_name}" "{company_name}"'
        ddg_url = (
            f"https://html.duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
        )
        logger.info("  ↳ DuckDuckGo profile search (requests): %s", ddg_url)
        resp = requests.get(ddg_url, headers=_HEADERS, timeout=15)
        soup = BeautifulSoup(resp.text, "html.parser")

        for a in soup.find_all("a", href=True):
            href = a["href"]
            # DDG wraps real URLs in a redirect; real URL is in the 'uddg' param
            parsed_href = urllib.parse.urlparse(href)
            qs = urllib.parse.parse_qs(parsed_href.query)
            real_url = qs.get("uddg", [href])[0]
            if "linkedin.com/in/" in real_url:
                clean = real_url.split("?")[0]
                logger.info("  ↳ DDG (requests) found profile URL: %s", clean)
                return clean

        # Also scan raw text in case DDG returned inline links
        for m in LI_PATTERN.finditer(resp.text):
            clean = m.group(0).split("?")[0]
            logger.info("  ↳ DDG text-scan found profile URL: %s", clean)
            return clean

        logger.info("  ↳ DDG (requests): no LinkedIn /in/ URL found.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("  ↳ DuckDuckGo search failed: %s", exc)

    # ── Strategy 2: Bing search via requests ────────────────────────────────
    try:
        query2 = f'site:linkedin.com/in "{full_name}" "{company_name}"'
        bing_url = (
            f"https://www.bing.com/search?q={urllib.parse.quote_plus(query2)}"
        )
        logger.info("  ↳ Bing profile search (requests): %s", bing_url)
        resp2 = requests.get(bing_url, headers=_HEADERS, timeout=15)
        soup2 = BeautifulSoup(resp2.text, "html.parser")
        for a in soup2.find_all("a", href=True):
            href = a["href"]
            if "linkedin.com/in/" in href:
                clean = href.split("?")[0]
                logger.info("  ↳ Bing found profile URL: %s", clean)
                return clean
        logger.info("  ↳ Bing: no LinkedIn /in/ URL found.")
    except Exception as exc2:  # noqa: BLE001
        logger.warning("  ↳ Bing search failed: %s", exc2)

    return None


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------

def run_pipeline(
    company_name: str,
    website_url:  Optional[str],
    founder_name: str,
    founder_email: Optional[str],
    linkedin_url: Optional[str]          = None,
    founder_linkedin_url: Optional[str]  = None,
    dry_run: bool                        = False,
) -> dict[str, Any]:
    """
    Execute the full 5-step founder insights pipeline for a single startup.

    Args:
        company_name:         Name of the startup (required).
        website_url:          Full URL to the company website or a specific page,
                              e.g. "https://www.igaps.ai/about" (optional).
                              The root domain is extracted automatically.
        founder_name:         Full name of the known founder (required).
        founder_email:        Email address of the known founder (optional).
        linkedin_url:         LinkedIn company page URL (optional).
        founder_linkedin_url: Direct LinkedIn /in/ URL for the founder.
                              Skips the URL-discovery step when provided.
        dry_run:              If True, skip the Supabase write.

    Returns:
        {
            "Company_Overview"   : dict,
            "Founder_Insights"   : dict | None,
            "CoFounder_Insights" : dict | None,
            "saved"              : bool,
        }
    """
    # ── Extract root domain from the website URL ───────────────────────────
    company_domain: Optional[str] = (
        extract_domain_from_url(website_url) if website_url else None
    )

    logger.info("=" * 68)
    logger.info("▶  Founder Insights Pipeline")
    logger.info("   Company      : %s", company_name)
    logger.info("   Website URL  : %s", website_url  or "(not provided)")
    logger.info("   Domain       : %s", company_domain or "(could not extract)")
    logger.info("   Founder      : %s <%s>", founder_name, founder_email or "no email")
    logger.info("   Company LI   : %s", linkedin_url         or "(not provided)")
    logger.info("   Founder LI   : %s", founder_linkedin_url or "(will auto-discover)")
    logger.info("   Dry run      : %s", dry_run)
    logger.info("=" * 68)

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 1A — Scrape LinkedIn company page
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("\n── STEP 1 ─ Company Data Extraction ──────────────────────────────")

    if not linkedin_url:
        logger.info("  [1a] No --linkedin-url provided. Searching for official URL...")
        from linkedin_api import find_company_linkedin
        discovered_url = find_company_linkedin(company_name)
        if discovered_url:
            linkedin_url = discovered_url
            logger.info("  ↳ Auto-discovered LinkedIn URL: %s", linkedin_url)
        else:
            logger.warning("  ↳ Could not auto-discover a LinkedIn URL.")

    people_page_text: Optional[str] = None
    if linkedin_url:
        logger.info("  [1a] Scraping LinkedIn company page: %s", linkedin_url)
        people_page_text = scrape_company_people(linkedin_url)
        if people_page_text:
            logger.info("  ↳ LinkedIn scrape: %d characters.", len(people_page_text))
        else:
            logger.warning("  ↳ LinkedIn scrape returned empty — continuing without it.")
    else:
        logger.info("  [1a] Skipping LinkedIn company scrape (URL not found).")

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 1B — Scrape the provided website URL for company context
    # ══════════════════════════════════════════════════════════════════════════
    website_text: Optional[str] = None
    if website_url:
        logger.info("  [1b] Scraping website URL: %s", website_url)
        website_text = scrape_specific_url(website_url)
        if website_text:
            logger.info("  ↳ Website scrape: %d characters.", len(website_text))
        else:
            logger.warning("  ↳ Website scrape returned empty — continuing without it.")
    else:
        logger.info("  [1b] No --website-url provided — skipping website scrape.")

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 1C — Build Company_Overview via Gemini
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("  [1c] Building Company_Overview via Gemini …")

    if not people_page_text and not website_text:
        logger.warning(
            "  [1c] No scraped text available — injecting company name/domain "
            "as minimal context so Gemini can populate at least those fields."
        )
        synthetic_context = (
            f"Company name: {company_name}\n"
            f"Website domain: {company_domain or 'unknown'}\n"
            "Note: No further details are available from LinkedIn or the website."
        )
        company_overview = parse_company_overview(
            linkedin_text=synthetic_context,
            website_text=None,
        )
    else:
        company_overview = parse_company_overview(
            linkedin_text=people_page_text,
            website_text=website_text,
        )

    # Always backfill from CLI inputs if Gemini could not extract them
    if not company_overview.get("domain") and company_domain:
        company_overview["domain"] = company_domain
    if not company_overview.get("company_name"):
        company_overview["company_name"] = company_name

    logger.info(
        "  ↳ Company_Overview: name=%s | industry=%s | location=%s",
        company_overview.get("company_name"),
        company_overview.get("industry"),
        company_overview.get("location"),
    )

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 2 — Co-Founder Discovery
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("\n── STEP 2 ─ Co-Founder Discovery ─────────────────────────────────")

    cofounders: list[dict[str, Any]] = []
    if people_page_text:
        logger.info("  [2] Scanning People page for co-founder titles …")
        cofounders = discover_cofounders(
            people_page_text=people_page_text,
            known_founder_name=founder_name,
        )
        if cofounders:
            logger.info(
                "  ↳ Discovered %d co-founder(s): %s",
                len(cofounders), [cf["name"] for cf in cofounders],
            )
        else:
            logger.info("  ↳ No co-founders found on People page.")
    else:
        logger.info("  [2] No People page text — skipping co-founder discovery.")

    # For co-founders without a URL, try DuckDuckGo
    for cf in cofounders:
        if not cf.get("linkedin_url"):
            logger.info(
                "  ↳ '%s' has no LinkedIn URL — trying DuckDuckGo …", cf["name"]
            )
            cf["linkedin_url"] = _search_linkedin_profile_url(cf["name"], company_name)
            if cf["linkedin_url"]:
                logger.info("  ↳ DDG found URL for '%s': %s", cf["name"], cf["linkedin_url"])
            else:
                logger.warning(
                    "  ↳ DDG could not find a LinkedIn URL for co-founder '%s'.", cf["name"]
                )

    primary_cofounder: Optional[dict[str, Any]] = cofounders[0] if cofounders else None

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 3 — Individual Profile Extraction
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("\n── STEP 3 ─ Profile Extraction ───────────────────────────────────")

    # ── Resolve founder profile URL ──────────────────────────────────────────
    if founder_linkedin_url:
        logger.info(
            "  [3a] Using directly supplied founder LinkedIn URL: %s",
            founder_linkedin_url,
        )
        founder_profile_url: Optional[str] = founder_linkedin_url
    else:
        founder_profile_url = _find_founder_profile_url(
            people_page_text=people_page_text,
            founder_name=founder_name,
            company_name=company_name,
        )

    # ── Scrape founder profile ───────────────────────────────────────────────
    founder_profile_text: Optional[str] = None
    if founder_profile_url:
        logger.info("  [3a] Scraping founder profile: %s", founder_profile_url)
        _sleep_between_sessions()
        try:
            founder_profile_text = scrape_linkedin_profile(founder_profile_url)
            if founder_profile_text:
                logger.info(
                    "  ↳ Founder profile scraped: %d characters.", len(founder_profile_text)
                )
            else:
                logger.error(
                    "  ↳ SCRAPE FAILED — scrape_linkedin_profile() returned empty text "
                    "for founder URL: %s\n"
                    "     Possible causes: cookie session expired, LinkedIn blocked the "
                    "request, or the profile is private.\n"
                    "     → Founder_Insights will be null this run.",
                    founder_profile_url,
                )
        except Exception as exc:    # noqa: BLE001
            logger.error(
                "  ↳ SCRAPE EXCEPTION for founder '%s' (%s): %s\n"
                "     → Founder_Insights will be null this run.",
                founder_name, founder_profile_url, exc, exc_info=True,
            )
    else:
        logger.error(
            "  [3a] COULD NOT LOCATE LinkedIn profile URL for founder '%s'.\n"
            "       Tried: People-page scan + DuckDuckGo fallback.\n"
            "       → Pass --founder-linkedin-url to supply it directly.\n"
            "       → Founder_Insights will be null this run.",
            founder_name,
        )

    # ── Scrape co-founder profile ────────────────────────────────────────────
    cofounder_profile_text: Optional[str] = None
    if primary_cofounder and primary_cofounder.get("linkedin_url"):
        logger.info(
            "  [3b] Scraping co-founder profile: %s", primary_cofounder["linkedin_url"]
        )
        _sleep_between_sessions()
        try:
            cofounder_profile_text = scrape_linkedin_profile(primary_cofounder["linkedin_url"])
            if cofounder_profile_text:
                logger.info(
                    "  ↳ Co-founder profile scraped: %d characters.",
                    len(cofounder_profile_text),
                )
            else:
                logger.error(
                    "  ↳ SCRAPE FAILED — scrape_linkedin_profile() returned empty text "
                    "for co-founder URL: %s\n"
                    "     → CoFounder_Insights will be null this run.",
                    primary_cofounder["linkedin_url"],
                )
        except Exception as exc:    # noqa: BLE001
            logger.error(
                "  ↳ SCRAPE EXCEPTION for co-founder '%s' (%s): %s\n"
                "     → CoFounder_Insights will be null this run.",
                primary_cofounder.get("name"), primary_cofounder["linkedin_url"],
                exc, exc_info=True,
            )
    else:
        logger.info("  [3b] No co-founder LinkedIn URL — skipping co-founder profile scrape.")

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 4 — Data Transformation & Grouping via Gemini
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("\n── STEP 4 ─ Data Transformation & Grouping ───────────────────────")

    founder_insights: Optional[dict[str, Any]] = None
    if founder_profile_text:
        logger.info("  [4a] Extracting Founder_Insights via Gemini …")
        founder_insights = format_profile_insights(
            raw_profile_text=founder_profile_text,
            company_name=company_name,
            company_domain=company_domain or "",
        )
        _log_insights_summary("Founder_Insights", founder_insights)
    else:
        logger.error(
            "  [4a] Skipping Founder_Insights — no profile text available. "
            "See Step 3 errors above."
        )

    cofounder_insights: Optional[dict[str, Any]] = None
    if cofounder_profile_text:
        logger.info("  [4b] Extracting CoFounder_Insights via Gemini …")
        cofounder_insights = format_profile_insights(
            raw_profile_text=cofounder_profile_text,
            company_name=company_name,
            company_domain=company_domain or "",
        )
        _log_insights_summary("CoFounder_Insights", cofounder_insights)
    else:
        logger.info("  [4b] No co-founder profile text — CoFounder_Insights will be null.")

    # ── Assemble payload ───────────────────────────────────────────────────────
    payload: dict[str, Any] = {
        "Company_Overview":   company_overview,
        "Founder_Insights":   founder_insights,
        "CoFounder_Insights": cofounder_insights,
    }

    # ══════════════════════════════════════════════════════════════════════════
    # STEP 5 — Database Load
    # ══════════════════════════════════════════════════════════════════════════
    logger.info("\n── STEP 5 ─ Database Load ─────────────────────────────────────────")

    if dry_run:
        logger.info("  [5] DRY RUN — skipping Supabase write.")
        logger.info("  Payload:\n%s", _pretty(payload))
        payload["saved"] = False
        return payload

    logger.info("  [5] Upserting to Supabase `startup_insights` …")
    saved = save_startup_insights(
        company_name=company_name,
        company_domain=company_domain,
        founder_name=founder_name,
        founder_email=founder_email,
        company_overview=company_overview,
        founder_insights=founder_insights,
        cofounder_insights=cofounder_insights,
    )
    payload["saved"] = saved is not None

    if saved:
        logger.info("  ✓ Record saved to Supabase.")
    else:
        logger.error("  ✗ Supabase save failed — check logs above.")

    logger.info("=" * 68)
    logger.info("Pipeline complete for '%s'.", company_name)
    logger.info("=" * 68)
    return payload


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _find_founder_profile_url(
    people_page_text: Optional[str],
    founder_name: str,
    company_name: str,
) -> Optional[str]:
    """
    Try to locate the founder's LinkedIn /in/ profile URL.

    Strategy 1 — PROFILE_LINKS section: The scraper now embeds a structured
                  ``=== PROFILE_LINKS (name → url) ===`` block with one
                  ``name url`` pair per line.  We do a fuzzy first+last name
                  match against every entry — this is the most reliable path.

    Strategy 2 — People page line scan: Look for a linkedin.com/in/ URL
                  within 7 lines of the founder's name in the raw text.

    Strategy 3 — DuckDuckGo / Bing search fallback (requests, no browser).
    """
    LI_IN_PATTERN = re.compile(
        r"https?://(?:www\.)?linkedin\.com/in/[\w\-]+", re.IGNORECASE
    )

    if people_page_text:
        name_lower  = founder_name.lower().strip()
        name_parts  = name_lower.split()          # [first, last, ...]
        lines       = people_page_text.splitlines()

        # ── Strategy 1: PROFILE_LINKS structured section ─────────────────────
        in_links_section = False
        for line in lines:
            stripped = line.strip()
            if "=== PROFILE_LINKS" in stripped:
                in_links_section = True
                continue
            if in_links_section:
                if stripped.startswith("==="):
                    break                           # left the section
                m = LI_IN_PATTERN.search(stripped)
                if not m:
                    continue
                url       = m.group(0).split("?")[0]
                line_low  = stripped.lower()
                # Accept if ALL name parts appear in this line (first + last)
                if all(part in line_low for part in name_parts):
                    logger.info(
                        "_find_founder_profile_url: PROFILE_LINKS match for '%s': %s",
                        founder_name, url,
                    )
                    return url

        # ── Strategy 2: sliding-window scan through raw People text ──────────
        for i, line in enumerate(lines):
            if name_lower in line.lower():
                for j in range(i, min(i + 7, len(lines))):
                    m = LI_IN_PATTERN.search(lines[j])
                    if m:
                        url = m.group(0).split("?")[0]
                        logger.info(
                            "_find_founder_profile_url: line-scan match for '%s': %s",
                            founder_name, url,
                        )
                        return url

    # ── Strategy 3: web search fallback ──────────────────────────────────────
    logger.info(
        "_find_founder_profile_url: '%s' not found in People page — trying web search …",
        founder_name,
    )
    return _search_linkedin_profile_url(founder_name, company_name)


def _sleep_between_sessions() -> None:
    """Polite randomised sleep between Selenium browser sessions."""
    pause = random.uniform(_SESSION_SLEEP_MIN, _SESSION_SLEEP_MAX)
    logger.debug("Sleeping %.1f s between sessions …", pause)
    time.sleep(pause)


def _log_insights_summary(label: str, insights: Optional[dict[str, Any]]) -> None:
    """Log a compact summary of extracted insights for quick validation."""
    if not insights:
        logger.info("  ↳ %s: (empty / null)", label)
        return

    g1 = insights.get("Group_1_General", {})
    g2 = insights.get("Group_2_Company_Specific", {})

    edu   = g1.get("education_and_marks", "")
    ach   = g1.get("early_achievements", "")
    work  = g2.get("work_experience", "")
    skills = g2.get("domain_skills", "")

    logger.info(
        "  ↳ %s — edu=%d chars | achievements=%d chars | "
        "work_exp=%d chars | skills=%d chars",
        label,
        len(edu)   if isinstance(edu,    str) else 0,
        len(ach)   if isinstance(ach,    str) else 0,
        len(work)  if isinstance(work,   str) else 0,
        len(skills) if isinstance(skills, str) else 0,
    )


def _pretty(obj: Any, indent: int = 2) -> str:
    """Return a pretty-printed JSON string (for dry-run logging)."""
    import json
    try:
        return json.dumps(obj, indent=indent, default=str, ensure_ascii=False)
    except Exception:
        return str(obj)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pipeline.py",
        description=(
            "Founder Insights Pipeline — scrape LinkedIn + website data for a "
            "startup and push structured insights to Supabase."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=r"""
Examples:
  # Full run with company LinkedIn page and specific about page:
  python pipeline.py \
      --company-name   "Acme Inc" \
      --website-url    "https://www.acme.com/about" \
      --founder-name   "Jane Doe" \
      --founder-email  "jane@acme.com" \
      --linkedin-url   "https://www.linkedin.com/company/acme-inc/" \
      --founder-linkedin-url "https://www.linkedin.com/in/janedoe"

  # Dry run (no DB write):
  python pipeline.py \
      --company-name "igaps" \
      --website-url  "https://www.igaps.ai/about" \
      --founder-name "Indranil Datta" \
      --founder-linkedin-url "https://www.linkedin.com/in/indranil-datta" \
      --dry-run
""",
    )
    parser.add_argument(
        "--company-name",
        required=True,
        metavar="NAME",
        help="Name of the startup (required).",
    )
    parser.add_argument(
        "--website-url",
        default=None,
        metavar="URL",
        help=(
            "Full URL to the company website or a specific page, e.g. "
            "'https://www.igaps.ai/about'. The root domain is extracted "
            "automatically. (optional)"
        ),
    )
    parser.add_argument(
        "--founder-name",
        required=True,
        metavar="NAME",
        help="Full name of the known founder (required).",
    )
    parser.add_argument(
        "--founder-email",
        default=None,
        metavar="EMAIL",
        help="Email of the founder (optional — directly provided, no enrichment).",
    )
    parser.add_argument(
        "--linkedin-url",
        default=None,
        metavar="URL",
        help=(
            "Full LinkedIn company page URL, e.g. "
            "'https://www.linkedin.com/company/acme-inc/' (optional)."
        ),
    )
    parser.add_argument(
        "--founder-linkedin-url",
        default=None,
        metavar="URL",
        help=(
            "Direct LinkedIn /in/ profile URL for the founder, e.g. "
            "'https://www.linkedin.com/in/janedoe'. "
            "When provided, the auto-discovery step is skipped entirely. (optional)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Run all steps but skip the Supabase write. Prints the payload to stdout.",
    )
    return parser


def main() -> None:
    parser = _build_arg_parser()
    args   = parser.parse_args()

    result = run_pipeline(
        company_name=args.company_name,
        website_url=args.website_url,
        founder_name=args.founder_name,
        founder_email=args.founder_email,
        linkedin_url=args.linkedin_url,
        founder_linkedin_url=args.founder_linkedin_url,
        dry_run=args.dry_run,
    )

    if not result.get("saved") and not args.dry_run:
        logger.error("Pipeline finished but record was NOT saved to Supabase.")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
