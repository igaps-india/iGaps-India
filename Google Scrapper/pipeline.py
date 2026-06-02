#!/usr/bin/env python3
"""
pipeline.py
===========
Startup IP & License Intelligence Pipeline
-------------------------------------------
Scrapes Google Patents (via SerpApi) and business licensing signals
(via Google Custom Search) for a given startup, then persists the
structured results into a Supabase PostgreSQL database.

Usage (live):
    python pipeline.py \\
        --company-name  "igaps" \\
        --website-url   "igaps.ai" \\
        --founder-name  "Indranil Datta" \\
        --linkedin-url  "https://www.linkedin.com/company/igaps"

Usage (dry-run — no network calls, no DB writes):
    python pipeline.py \\
        --company-name  "igaps" \\
        --website-url   "igaps.ai" \\
        --founder-name  "Indranil Datta" \\
        --linkedin-url  "https://www.linkedin.com/company/igaps" \\
        --dry-run

Required .env keys (live mode only):
    SERPAPI_API_KEY   — SerpApi account key
    GOOGLE_API_KEY    — Google Cloud API key (Custom Search enabled)
    GOOGLE_CSE_ID     — Google Programmable Search Engine ID
    SUPABASE_URL      — https://<project-ref>.supabase.co
    SUPABASE_KEY      — Supabase service-role key (NOT the anon key)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

import requests
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Optional Supabase import — only required for live mode
# ---------------------------------------------------------------------------
try:
    from supabase import Client, create_client  # type: ignore
except ImportError:
    create_client = None  # will be caught at runtime if live mode is used
    Client = None


# ===========================================================================
# 1. CLI ARGUMENT PARSING
# ===========================================================================

def build_arg_parser() -> argparse.ArgumentParser:
    """Return a fully configured ArgumentParser for the pipeline CLI."""
    parser = argparse.ArgumentParser(
        prog="pipeline.py",
        description=(
            "Startup IP & Licensing Intelligence Pipeline — "
            "scrapes Google Patents and business licence signals "
            "and persists results in Supabase."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--company-name",
        dest="company_name",
        type=str,
        metavar="NAME",
        help="Legal or operating name of the startup (e.g. 'igaps').",
    )
    parser.add_argument(
        "--website-url",
        dest="website_url",
        type=str,
        metavar="URL",
        help="Official company domain (e.g. 'igaps.ai').",
    )
    parser.add_argument(
        "--founder-name",
        dest="founder_name",
        type=str,
        metavar="NAME",
        help="Full name of the primary founder.",
    )
    parser.add_argument(
        "--linkedin-url",
        dest="linkedin_url",
        type=str,
        metavar="URL",
        help="URL to the corporate LinkedIn profile.",
    )
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        default=False,
        help=(
            "Mock all API calls, simulate the DB payload, "
            "print to console, and exit without writing anything."
        ),
    )
    return parser


def validate_args(args: argparse.Namespace) -> None:
    """
    Enforce required-field logic.  All four company fields are required
    unless --dry-run is active (where we can substitute placeholder values).
    """
    if args.dry_run:
        # Backfill defaults so the rest of the script always has values
        if not args.company_name:
            args.company_name = "ACME Corp (dry-run)"
        if not args.website_url:
            args.website_url = "example.com"
        if not args.founder_name:
            args.founder_name = "Jane Doe"
        if not args.linkedin_url:
            args.linkedin_url = "https://www.linkedin.com/company/example"
        return

    missing: list[str] = []
    if not args.company_name:
        missing.append("--company-name")
    if not args.website_url:
        missing.append("--website-url")
    if not args.founder_name:
        missing.append("--founder-name")
    if not args.linkedin_url:
        missing.append("--linkedin-url")

    if missing:
        print(
            f"[ERROR] The following arguments are required in live mode: "
            f"{', '.join(missing)}\n"
            f"        Add --dry-run to run without real credentials.",
            file=sys.stderr,
        )
        sys.exit(1)


# ===========================================================================
# 2. ENVIRONMENT CONFIGURATION
# ===========================================================================

_REQUIRED_LIVE_KEYS = (
    "SERPAPI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CSE_ID",
    "SUPABASE_URL",
    "SUPABASE_KEY",
)


def load_env() -> dict[str, str]:
    """
    Load .env from the current working directory and return a dict of
    the required keys.  Raises SystemExit with a descriptive message
    if any key is missing (live mode only — caller is responsible for
    deciding whether to call this).
    """
    load_dotenv()

    config: dict[str, str] = {}
    missing: list[str] = []

    for key in _REQUIRED_LIVE_KEYS:
        value = os.getenv(key, "").strip()
        if not value:
            missing.append(key)
        else:
            config[key] = value

    if missing:
        print(
            "[CONFIG ERROR] The following environment variables are not set "
            f"in your .env file:\n  " + "\n  ".join(missing) + "\n"
            "  Create a .env file in the same directory as pipeline.py "
            "with those keys, or pass --dry-run to skip live execution.",
            file=sys.stderr,
        )
        sys.exit(1)

    return config


# ===========================================================================
# 3. MODULE A — GOOGLE PATENTS EXTRACTION (SerpApi)
# ===========================================================================

SERPAPI_PATENTS_ENDPOINT = "https://serpapi.com/search"


def check_google_patents(
    company: str,
    founder: str,
    api_key: str,
    timeout: int = 20,
) -> list[dict[str, Any]]:
    """
    Query SerpApi's Google Patents engine for IP associated with a
    company (as assignee) or its founder (as inventor).

    Parameters
    ----------
    company : str
        Company name to look up as patent assignee.
    founder : str
        Founder name to look up as patent inventor.
    api_key : str
        SerpApi account key.
    timeout : int
        HTTP request timeout in seconds.

    Returns
    -------
    list[dict]
        Each dict contains: patent_id, title, snippet, link,
        publication_date.
    """
    # Boolean query that hits both assignee and inventor fields
    query = f'assignee:("{company}") OR inventor:("{founder}")'

    params = {
        "engine":  "google_patents",
        "q":       query,
        "api_key": api_key,
        "num":     10,        # max results per page
    }

    print(f"[PATENTS] Querying SerpApi — {query!r}")

    try:
        response = requests.get(
            SERPAPI_PATENTS_ENDPOINT,
            params=params,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.exceptions.Timeout:
        print("[PATENTS][ERROR] Request timed out.", file=sys.stderr)
        return []
    except requests.exceptions.HTTPError as exc:
        # Avoid leaking the API key that may be in the response URL
        print(
            f"[PATENTS][ERROR] HTTP {exc.response.status_code} from SerpApi.",
            file=sys.stderr,
        )
        return []
    except requests.exceptions.RequestException as exc:
        print(f"[PATENTS][ERROR] Network error: {exc}", file=sys.stderr)
        return []

    try:
        data = response.json()
    except ValueError:
        print("[PATENTS][ERROR] Non-JSON response from SerpApi.", file=sys.stderr)
        return []

    raw_results: list[dict] = data.get("organic_results", [])
    patents: list[dict[str, Any]] = []

    for item in raw_results:
        patents.append(
            {
                "patent_id":        item.get("patent_id") or item.get("result_id", ""),
                "title":            item.get("title", ""),
                "snippet":          item.get("snippet", ""),
                "link":             item.get("patent_link") or item.get("link", ""),
                "publication_date": item.get("publication_date", ""),
            }
        )

    print(f"[PATENTS] Found {len(patents)} result(s).")
    return patents


# ===========================================================================
# 4. MODULE B — LICENSE SIGNAL EXTRACTION (Google Custom Search)
# ===========================================================================

GOOGLE_CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1"


def check_license_signals(
    company: str,
    api_key: str,
    cse_id: str,
    timeout: int = 20,
) -> list[dict[str, Any]]:
    """
    Use the Google Custom Search JSON API to detect regulatory / licensing
    footprints for the given company.

    Parameters
    ----------
    company : str
        Company name to query.
    api_key : str
        Google Cloud API key with Custom Search enabled.
    cse_id : str
        Google Programmable Search Engine (CSE) ID.
    timeout : int
        HTTP request timeout in seconds.

    Returns
    -------
    list[dict]
        Each dict contains: source_title, source_link, snippet.
    """
    # Targeted boolean query for regulatory / licence signals
    query = (
        f'"{company}" AND '
        '("license approved" OR "regulatory approval" OR "FSSAI" '
        'OR "RBI approved" OR "registered trademark")'
    )

    params = {
        "key": api_key,
        "cx":  cse_id,
        "q":   query,
        "num": 5,          # top 5 results
    }

    print(f"[LICENSES] Querying Google Custom Search — {query!r}")

    try:
        response = requests.get(
            GOOGLE_CSE_ENDPOINT,
            params=params,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.exceptions.Timeout:
        print("[LICENSES][ERROR] Request timed out.", file=sys.stderr)
        return []
    except requests.exceptions.HTTPError as exc:
        print(
            f"[LICENSES][ERROR] HTTP {exc.response.status_code} from Google CSE.",
            file=sys.stderr,
        )
        return []
    except requests.exceptions.RequestException as exc:
        print(f"[LICENSES][ERROR] Network error: {exc}", file=sys.stderr)
        return []

    try:
        data = response.json()
    except ValueError:
        print("[LICENSES][ERROR] Non-JSON response from Google CSE.", file=sys.stderr)
        return []

    raw_items: list[dict] = data.get("items", [])
    signals: list[dict[str, Any]] = []

    for item in raw_items:
        signals.append(
            {
                "source_title": item.get("title", ""),
                "source_link":  item.get("link", ""),
                "snippet":      item.get("snippet", ""),
            }
        )

    print(f"[LICENSES] Found {len(signals)} signal(s).")
    return signals


# ===========================================================================
# 5. SUPABASE INTEGRATION MODULE
# ===========================================================================

def save_to_supabase(
    startup_data: dict[str, Any],
    patent_data: list[dict[str, Any]],
    license_data: list[dict[str, Any]],
    supabase_url: str,
    supabase_key: str,
) -> None:
    """
    Persist the scraped intelligence into Supabase.

    Steps:
        1. Insert the startup profile → retrieve the generated UUID.
        2. Batch-insert all patent records linked to that UUID.
        3. Batch-insert all licence signals linked to that UUID.

    Parameters
    ----------
    startup_data  : dict with keys company_name, website_url,
                    founder_name, linkedin_url
    patent_data   : list returned by check_google_patents()
    license_data  : list returned by check_license_signals()
    supabase_url  : Supabase project URL
    supabase_key  : Supabase service-role key
    """
    if create_client is None:
        print(
            "[DB][ERROR] supabase-py is not installed. "
            "Run: pip install supabase",
            file=sys.stderr,
        )
        sys.exit(1)

    print("[DB] Connecting to Supabase …")

    try:
        client: Client = create_client(supabase_url, supabase_key)
    except Exception as exc:
        print(f"[DB][ERROR] Could not initialise Supabase client: {exc}", file=sys.stderr)
        sys.exit(1)

    # ------------------------------------------------------------------
    # Step 1 — Insert startup profile
    # ------------------------------------------------------------------
    print(f"[DB] Inserting startup: {startup_data['company_name']!r}")

    try:
        response = (
            client.table("startups")
            .insert(startup_data)
            .execute()
        )
        inserted = response.data
        if not inserted:
            raise ValueError("Supabase returned no data after startup insert.")
        startup_id: str = inserted[0]["id"]
        print(f"[DB] Startup inserted — id={startup_id}")
    except Exception as exc:
        print(
            f"[DB][ERROR] Failed to insert startup record. "
            f"Reason: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ------------------------------------------------------------------
    # Step 2 — Batch-insert patents
    # ------------------------------------------------------------------
    if patent_data:
        print(f"[DB] Inserting {len(patent_data)} patent record(s) …")
        patent_rows = [
            {**p, "startup_id": startup_id}
            for p in patent_data
        ]
        try:
            client.table("patents").insert(patent_rows).execute()
            print("[DB] Patents inserted.")
        except Exception as exc:
            print(
                f"[DB][ERROR] Failed to insert patents. "
                f"Reason: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            # Non-fatal — continue to licences
    else:
        print("[DB] No patents to insert.")

    # ------------------------------------------------------------------
    # Step 3 — Batch-insert licence signals
    # ------------------------------------------------------------------
    if license_data:
        print(f"[DB] Inserting {len(license_data)} licence signal(s) …")
        license_rows = [
            {**lic, "startup_id": startup_id}
            for lic in license_data
        ]
        try:
            client.table("licenses").insert(license_rows).execute()
            print("[DB] Licence signals inserted.")
        except Exception as exc:
            print(
                f"[DB][ERROR] Failed to insert licences. "
                f"Reason: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
    else:
        print("[DB] No licence signals to insert.")

    print("[DB] All done. ✓")


# ===========================================================================
# 6. DRY-RUN MOCK DATA GENERATOR
# ===========================================================================

def _mock_patents(company: str, founder: str) -> list[dict[str, Any]]:
    """Return realistic-looking mock patent records."""
    return [
        {
            "patent_id":        "US20230012345A1",
            "title":            f"AI-Driven Market Gap Analysis System — {company}",
            "snippet":          (
                f"A system and method attributed to {company} that leverages "
                "large language models to identify unmet market needs in real time."
            ),
            "link":             "https://patents.google.com/patent/US20230012345A1",
            "publication_date": "2023-03-15",
        },
        {
            "patent_id":        "IN202341056789",
            "title":            f"Personalised Recommendation Engine — {founder}",
            "snippet":          (
                f"Invented by {founder}, this patent covers a probabilistic "
                "recommendation algorithm with sub-100 ms latency."
            ),
            "link":             "https://patents.google.com/patent/IN202341056789",
            "publication_date": "2023-11-02",
        },
    ]


def _mock_licenses(company: str) -> list[dict[str, Any]]:
    """Return realistic-looking mock licence signal records."""
    return [
        {
            "source_title": f"{company} receives DPIIT Startup India recognition",
            "source_link":  f"https://startupindia.gov.in/recognised/{company.lower().replace(' ', '-')}",
            "snippet":      (
                f"{company} has been officially recognised by DPIIT under the "
                "Startup India initiative, conferring tax benefits and IPR fast-track access."
            ),
        },
        {
            "source_title": f"RBI Approved: {company} fintech sandbox clearance",
            "source_link":  "https://rbi.org.in/sandbox/approved-entities",
            "snippet":      (
                f"{company} has successfully cleared Phase 2 of the RBI Regulatory "
                "Sandbox for its AI-powered credit decisioning product."
            ),
        },
        {
            "source_title": f"Registered Trademark — {company}",
            "source_link":  "https://ipindia.gov.in/trademark-registry",
            "snippet":      (
                f"The wordmark '{company}' (Class 42 — Software as a Service) is "
                "registered under the Indian Trade Marks Act, 1999."
            ),
        },
    ]


def run_dry_run(args: argparse.Namespace) -> None:
    """
    Execute the pipeline entirely with mock data — no network calls,
    no database writes.  Prints structured JSON to stdout.
    """
    banner = "=" * 64
    print(banner)
    print("  DRY-RUN MODE — No API calls or DB writes will be made")
    print(banner)

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    fake_startup_id = str(uuid.uuid4())

    startup_payload: dict[str, Any] = {
        "id":           fake_startup_id,
        "company_name": args.company_name,
        "website_url":  args.website_url,
        "founder_name": args.founder_name,
        "linkedin_url": args.linkedin_url,
        "created_at":   now_iso,
    }

    patent_records = _mock_patents(args.company_name, args.founder_name)
    license_records = _mock_licenses(args.company_name)

    # Attach startup_id to each child record (as would happen on DB insert)
    patent_db_rows = [
        {**p, "startup_id": fake_startup_id, "id": str(uuid.uuid4())}
        for p in patent_records
    ]
    license_db_rows = [
        {**lic, "startup_id": fake_startup_id, "id": str(uuid.uuid4()),
         "found_at": now_iso}
        for lic in license_records
    ]

    output = {
        "dry_run":  True,
        "startup":  startup_payload,
        "patents":  patent_db_rows,
        "licenses": license_db_rows,
    }

    print("\n[DRY-RUN] Simulated database payload:\n")
    print(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"\n[DRY-RUN] Would insert 1 startup, "
          f"{len(patent_db_rows)} patent(s), "
          f"{len(license_db_rows)} licence signal(s).")
    print("[DRY-RUN] Exiting cleanly — nothing was written.")


# ===========================================================================
# 7. MAIN ENTRY POINT
# ===========================================================================

def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    validate_args(args)

    # -----------------------------------------------------------------------
    # DRY-RUN branch — fully mocked, exits here
    # -----------------------------------------------------------------------
    if args.dry_run:
        run_dry_run(args)
        sys.exit(0)

    # -----------------------------------------------------------------------
    # LIVE branch — load credentials & run real pipeline
    # -----------------------------------------------------------------------
    config = load_env()

    startup_data: dict[str, Any] = {
        "company_name": args.company_name,
        "website_url":  args.website_url,
        "founder_name": args.founder_name,
        "linkedin_url": args.linkedin_url,
    }

    # -- Module A: Patents ---------------------------------------------------
    patent_data = check_google_patents(
        company=args.company_name,
        founder=args.founder_name,
        api_key=config["SERPAPI_API_KEY"],
    )

    # -- Module B: Licence signals -------------------------------------------
    license_data = check_license_signals(
        company=args.company_name,
        api_key=config["GOOGLE_API_KEY"],
        cse_id=config["GOOGLE_CSE_ID"],
    )

    # -- Persist results -----------------------------------------------------
    save_to_supabase(
        startup_data=startup_data,
        patent_data=patent_data,
        license_data=license_data,
        supabase_url=config["SUPABASE_URL"],
        supabase_key=config["SUPABASE_KEY"],
    )

    print("\n✓ Pipeline completed successfully.")


if __name__ == "__main__":
    main()
