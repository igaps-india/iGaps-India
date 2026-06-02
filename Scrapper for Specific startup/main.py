"""
main.py
Standalone VC Data Enrichment Pipeline — Orchestrator

Flow (simple):
  1. Pull a pending company row from Supabase `target_companies`.
  2. Read company_name, linkedin_url, founder_name, founder_email,
     founder_linkedin_url directly from the row.
  3. Call run_pipeline() from pipeline.py with those values.
  4. pipeline.py scrapes the founder's LinkedIn /in/ profile, runs
     Gemini extraction, and saves the rich JSON to `startup_insights`.
  5. Mark the company as 'completed' in Supabase.

Usage:
    python main.py

Required columns in target_companies (fill these in Supabase):
    company_name          Name of the startup
    founder_name          Full name of the founder  ← YOU provide this
    linkedin_url          Company LinkedIn URL       (optional)
    founder_linkedin_url  Founder /in/ LinkedIn URL  (optional but recommended)
    founder_email         Founder email              (optional)
    domain                Company domain             (optional)

Environment variables (.env):
    SUPABASE_URL     Supabase project URL
    SUPABASE_KEY     Supabase service-role key
    GOOGLE_API_KEY   Google AI key for Gemini
    COOKIES_PATH     (optional) path to linkedin_cookies.pkl
    BATCH_SIZE       (optional) max companies per run — default 1
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import logging
import os
import random
import sys
import time
from typing import Any

from db import (
    get_pending_company,
    mark_company_completed,
    mark_company_failed,
)
from pipeline import run_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("main")

BATCH_SIZE: int        = int(os.environ.get("BATCH_SIZE", 1))
COMPANY_SLEEP_MIN: float = 3.0
COMPANY_SLEEP_MAX: float = 7.0


def _process_company(company: dict[str, Any]) -> None:
    """
    Run the full Gemini insights pipeline for a single company row.
    Founder details are read directly from the DB row — no scraping for discovery.
    """
    startup_id: str   = company["id"]
    company_name: str = (company.get("company_name") or "").strip()

    logger.info("━" * 64)
    logger.info("Processing: %s  (id=%s)", company_name, startup_id)

    if not company_name:
        raise ValueError("company_name is empty — cannot proceed.")

    # ── Read all fields directly from the DB row ──────────────────────────────
    founder_name: str | None  = (company.get("founder_name") or "").strip() or None
    founder_email: str | None = (company.get("founder_email") or "").strip() or None
    founder_li: str | None    = (company.get("founder_linkedin_url") or "").strip() or None
    company_li: str | None    = (company.get("linkedin_url") or "").strip() or None
    domain: str | None        = (company.get("domain") or "").strip() or None

    # ── Validate: founder_name is required ───────────────────────────────────
    if not founder_name:
        raise ValueError(
            f"founder_name is missing for '{company_name}'. "
            "Please fill it in Supabase → target_companies before running."
        )

    logger.info("  Company     : %s", company_name)
    logger.info("  Domain      : %s", domain or "not provided")
    logger.info("  Company LI  : %s", company_li or "not provided")
    logger.info("  Founder     : %s", founder_name)
    logger.info("  Founder LI  : %s", founder_li or "not provided")
    logger.info("  Founder Email: %s", founder_email or "not provided")

    # ── Run the full Gemini insights pipeline ─────────────────────────────────
    logger.info("\n  🚀 Running Gemini Insights Pipeline …")
    run_pipeline(
        company_name         = company_name,
        website_url          = f"https://www.{domain}" if domain else None,
        founder_name         = founder_name,
        founder_email        = founder_email,
        linkedin_url         = company_li,
        founder_linkedin_url = founder_li,
        dry_run              = False,
    )
    logger.info("  ✓ Done — `startup_insights` table updated for '%s'!", company_name)


def main() -> None:
    logger.info("=" * 64)
    logger.info("VC Data Enrichment Pipeline — Orchestrator")
    logger.info("Max companies this run: %d", BATCH_SIZE)
    logger.info("=" * 64)

    processed = 0

    for iteration in range(1, BATCH_SIZE + 1):

        company: dict[str, Any] | None = get_pending_company()

        if company is None:
            logger.info("No pending companies found. All done!")
            break

        startup_id: str   = company["id"]
        company_name: str = company.get("company_name", startup_id)

        try:
            _process_company(company)
            processed += 1
            mark_company_completed(startup_id)
            logger.info("  ✓ Marked '%s' as completed.\n", company_name)

        except Exception as exc:
            logger.error(
                "Failed for '%s' (id=%s): %s",
                company_name, startup_id, exc,
                exc_info=True,
            )
            try:
                mark_company_failed(startup_id, reason=str(exc)[:255])
            except Exception as db_exc:
                logger.error("Could not mark as failed: %s", db_exc)

        finally:
            if iteration < BATCH_SIZE:
                pause = random.uniform(COMPANY_SLEEP_MIN, COMPANY_SLEEP_MAX)
                logger.info("Sleeping %.1f s before next company …\n", pause)
                time.sleep(pause)

    logger.info("=" * 64)
    logger.info("Pipeline complete. Companies processed: %d", processed)
    logger.info("=" * 64)


if __name__ == "__main__":
    main()
