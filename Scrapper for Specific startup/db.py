"""
db.py
Standalone VC Data Enrichment Pipeline — Database Layer (Standalone Edition)

Configured for the actual Supabase schema:
  Table : public.target_companies
  Columns: id (uuid), company_name (text), linkedin_url (text), domain (text),
           status (text)  ← added via migration below
           error_reason (text) ← added via migration below

⚠️  FIRST-TIME SETUP — run this SQL once in your Supabase SQL Editor:
----------------------------------------------------------------------
ALTER TABLE public.target_companies
  ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS error_reason TEXT;

UPDATE public.target_companies SET status = 'pending' WHERE status IS NULL;
----------------------------------------------------------------------

Functions:
  get_pending_company()    → fetch one company with status='pending' or NULL
  save_founder()           → upsert a founder record into `founders`
  mark_company_completed() → set status='completed'
  mark_company_failed()    → set status='failed' + store error reason

Environment variables:
  SUPABASE_URL   — e.g. https://xyzxyz.supabase.co
  SUPABASE_KEY   — service-role key (NOT the anon key)
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from dotenv import load_dotenv
from supabase import Client, create_client

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
# TABLE & COLUMN NAMES — matched to your actual Supabase schema
# ---------------------------------------------------------------------------
_COMPANIES_TABLE: str = "target_companies"
_FOUNDERS_TABLE:  str = "founders"
_NAME_COLUMN:     str = "company_name"

# ---------------------------------------------------------------------------
# Supabase client (module-level singleton)
# ---------------------------------------------------------------------------
_SUPABASE_URL: str = os.environ["SUPABASE_URL"]
_SUPABASE_KEY: str = os.environ["SUPABASE_KEY"]

_db: Client = create_client(_SUPABASE_URL, _SUPABASE_KEY)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def get_pending_company() -> Optional[dict[str, Any]]:
    """
    Fetch a single company from `target_companies` that still needs enrichment.

    Tries three strategies in order:
      1. status = 'pending'        (explicit pending flag)
      2. status IS NULL            (status column exists but value was never set)
      3. Any row at all            (status column doesn't exist yet — safe fallback)
         filtered to exclude IDs already present in the founders table.

    Returns the row dict, or None if truly nothing left to process.
    """
    # ------------------------------------------------------------------
    # Strategy 1: status = 'pending'
    # ------------------------------------------------------------------
    try:
        result = (
            _db.table(_COMPANIES_TABLE)
            .select("*")
            .eq("status", "pending")
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if rows:
            company = rows[0]
            logger.info(
                "Fetched pending company (status=pending): '%s' (id=%s)",
                company.get(_NAME_COLUMN, company["id"]),
                company["id"],
            )
            return company
    except Exception as exc:  # noqa: BLE001
        logger.warning("Strategy 1 (status=pending) failed: %s", exc)

    # ------------------------------------------------------------------
    # Strategy 2: status IS NULL
    # ------------------------------------------------------------------
    try:
        result = (
            _db.table(_COMPANIES_TABLE)
            .select("*")
            .is_("status", "null")
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if rows:
            company = rows[0]
            logger.info(
                "Fetched pending company (status=NULL): '%s' (id=%s)",
                company.get(_NAME_COLUMN, company["id"]),
                company["id"],
            )
            return company
    except Exception as exc:  # noqa: BLE001
        logger.warning("Strategy 2 (status IS NULL) failed: %s", exc)

    # ------------------------------------------------------------------
    # Strategy 3: Fallback — fetch ANY company not yet in founders table
    # (handles the case where the status column doesn't exist at all)
    # ------------------------------------------------------------------
    try:
        logger.info(
            "Falling back to Strategy 3: fetch any company not yet in founders table ..."
        )

        # Get IDs of companies already enriched (have at least one founder)
        enriched_res = _db.table(_FOUNDERS_TABLE).select("company_id").execute()
        enriched_ids: list[str] = list(
            {row["company_id"] for row in (enriched_res.data or [])}
        )

        # Fetch all companies and pick first one not in enriched set
        all_res = _db.table(_COMPANIES_TABLE).select("*").execute()
        all_companies: list[dict] = all_res.data or []

        for company in all_companies:
            if company["id"] not in enriched_ids:
                logger.info(
                    "Fetched company via fallback strategy: '%s' (id=%s)",
                    company.get(_NAME_COLUMN, company["id"]),
                    company["id"],
                )
                return company

        logger.info("No unprocessed companies found via any strategy.")
        return None

    except Exception as exc:  # noqa: BLE001
        logger.error("Strategy 3 (fallback) also failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Write — Founders
# ---------------------------------------------------------------------------

def save_founder(
    startup_id: str,
    founder_data: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """
    Upsert a founder record into the `founders` table.

    The unique constraint (startup_id, first_name, last_name) prevents
    duplicates if the pipeline runs twice on the same company.

    Args:
        startup_id:   UUID of the parent company (from target_companies.id).
        founder_data: Dict with keys: first_name, last_name, role, email,
                      linkedin_url. Extra keys are silently ignored.

    Returns the saved row dict, or None on failure.
    """
    first = str(founder_data.get("first_name", "")).strip()
    last  = str(founder_data.get("last_name",  "")).strip()

    if not first or not last:
        logger.warning(
            "save_founder: skipping record with missing name (startup_id=%s): %s",
            startup_id, founder_data,
        )
        return None

    record: dict[str, Any] = {
        "company_id":   startup_id,
        "first_name":   first,
        "last_name":    last,
        "role":         founder_data.get("role"),
        "email":        founder_data.get("email"),
        "linkedin_url": founder_data.get("linkedin_url"),
    }

    try:
        result = (
            _db.table(_FOUNDERS_TABLE)
            .upsert(
                record,
                on_conflict="company_id,first_name,last_name",
            )
            .execute()
        )
        saved = result.data[0] if result.data else None
        logger.info(
            "Saved founder '%s %s' (role=%s) for startup_id=%s.",
            first, last, record["role"], startup_id,
        )
        return saved

    except Exception as exc:  # noqa: BLE001
        logger.error(
            "save_founder() failed for '%s %s' (startup_id=%s): %s",
            first, last, startup_id, exc,
        )
        return None


# ---------------------------------------------------------------------------
# Write — Company status updates
# ---------------------------------------------------------------------------

def mark_company_completed(startup_id: str) -> bool:
    """Set status = 'completed' for the given company. Returns True on success."""
    return _update_status(startup_id, "completed")


def mark_company_failed(
    startup_id: str,
    reason: Optional[str] = None,
) -> bool:
    """
    Set status = 'failed' and optionally store the error reason.
    Returns True on success.
    """
    extra: dict[str, Any] = {}
    if reason:
        extra["error_reason"] = str(reason)[:255]
    return _update_status(startup_id, "failed", extra_fields=extra)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _update_status(
    startup_id: str,
    status: str,
    extra_fields: Optional[dict[str, Any]] = None,
) -> bool:
    """Update the status column (and optionally other fields) by company id."""
    payload: dict[str, Any] = {"status": status}
    if extra_fields:
        payload.update(extra_fields)

    try:
        _db.table(_COMPANIES_TABLE).update(payload).eq("id", startup_id).execute()
        logger.info("Marked id=%s as '%s'.", startup_id, status)
        return True

    except Exception as exc:  # noqa: BLE001
        logger.error(
            "_update_status('%s', '%s') failed: %s", startup_id, status, exc
        )
        return False


# ---------------------------------------------------------------------------
# Write — New Pipeline: Startup Insights
# ---------------------------------------------------------------------------

_INSIGHTS_TABLE: str = "startup_insights"


def save_startup_insights(
    company_name: str,
    company_domain: str | None,
    founder_name: str,
    founder_email: str | None,
    company_overview: dict,
    founder_insights: dict | None,
    cofounder_insights: dict | None,
) -> Optional[dict[str, Any]]:
    """
    Upsert a full startup insights record into the `startup_insights` table.

    The unique constraint on (company_name, company_domain) ensures that
    re-running the pipeline on the same startup updates the existing row
    rather than creating a duplicate.

    Args:
        company_name:       The startup's name (required — part of unique key).
        company_domain:     The startup's domain (part of unique key; may be None).
        founder_name:       Full name of the primary founder.
        founder_email:      Email address of the primary founder.
        company_overview:   Dict from parse_company_overview() — JSONB column.
        founder_insights:   Dict from format_profile_insights() — JSONB column.
        cofounder_insights: Dict from format_profile_insights() for co-founder,
                            or None if no co-founder was found.

    Returns:
        The saved row dict on success, or None on failure.
    """
    if not company_name or not company_name.strip():
        logger.error("save_startup_insights: company_name is required — skipping.")
        return None

    import json as _json

    record: dict[str, Any] = {
        "company_name":        company_name.strip(),
        "company_domain":      (company_domain or "").strip() or None,
        "founder_name":        (founder_name or "").strip() or None,
        "founder_email":       (founder_email or "").strip() or None,
        # Store the complete payload exactly as the given format in a single JSONB column
        "insights": {
            "Company_Overview":   company_overview or {},
            "Founder_Insights":   founder_insights or {},
            "CoFounder_Insights": cofounder_insights
        }
    }

    logger.info(
        "Saving startup insights for '%s' (domain=%s) …",
        record["company_name"], record["company_domain"],
    )
    logger.debug(
        "Payload preview — overview keys: %s | founder_insights keys: %s",
        list((company_overview or {}).keys()),
        list((founder_insights or {}).keys()),
    )

    try:
        result = (
            _db.table(_INSIGHTS_TABLE)
            .upsert(
                record,
                on_conflict="company_name,company_domain",
            )
            .execute()
        )
        saved = result.data[0] if result.data else None
        logger.info(
            "✓ Startup insights saved for '%s'.", record["company_name"]
        )
        return saved

    except Exception as exc:  # noqa: BLE001
        logger.error(
            "save_startup_insights() failed for '%s': %s",
            company_name, exc,
        )
        return None
