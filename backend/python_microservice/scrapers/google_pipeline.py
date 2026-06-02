import os
import requests
from typing import Any, Dict, List
import logging

logger = logging.getLogger(__name__)

SERPAPI_PATENTS_ENDPOINT = "https://serpapi.com/search"
GOOGLE_CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1"

def check_google_patents(company: str, founder: str, api_key: str, timeout: int = 20) -> List[Dict[str, Any]]:
    query = f'assignee:("{company}") OR inventor:("{founder}")'
    params = {
        "engine": "google_patents",
        "q": query,
        "api_key": api_key,
        "num": 10,
    }
    logger.info(f"[PATENTS] Querying SerpApi — {query!r}")
    try:
        response = requests.get(SERPAPI_PATENTS_ENDPOINT, params=params, timeout=timeout)
        response.raise_for_status()
    except Exception as exc:
        logger.error(f"[PATENTS][ERROR] Network error: {exc}")
        return []

    data = response.json()
    raw_results = data.get("organic_results", [])
    patents = []
    for item in raw_results:
        patents.append({
            "patent_id": item.get("patent_id") or item.get("result_id", ""),
            "title": item.get("title", ""),
            "snippet": item.get("snippet", ""),
            "link": item.get("patent_link") or item.get("link", ""),
            "publication_date": item.get("publication_date", ""),
        })
    logger.info(f"[PATENTS] Found {len(patents)} result(s).")
    return patents


def check_license_signals(company: str, api_key: str, cse_id: str, timeout: int = 20) -> List[Dict[str, Any]]:
    query = f'"{company}" AND ("license approved" OR "regulatory approval" OR "FSSAI" OR "RBI approved" OR "registered trademark")'
    params = {
        "key": api_key,
        "cx": cse_id,
        "q": query,
        "num": 5,
    }
    logger.info(f"[LICENSES] Querying Google Custom Search — {query!r}")
    try:
        response = requests.get(GOOGLE_CSE_ENDPOINT, params=params, timeout=timeout)
        response.raise_for_status()
    except Exception as exc:
        logger.error(f"[LICENSES][ERROR] Network error: {exc}")
        return []

    data = response.json()
    raw_items = data.get("items", [])
    signals = []
    for item in raw_items:
        signals.append({
            "source_title": item.get("title", ""),
            "source_link": item.get("link", ""),
            "snippet": item.get("snippet", ""),
        })
    logger.info(f"[LICENSES] Found {len(signals)} signal(s).")
    return signals

def run_google_pipeline(company_name: str, founder_name: str) -> Dict[str, Any]:
    serpapi_key = os.environ.get("SERPAPI_KEY") or os.environ.get("SERPAPI_API_KEY")
    google_key = os.environ.get("GOOGLE_API_KEY")
    cse_id = os.environ.get("GOOGLE_CSE_ID")

    patents = []
    licenses = []
    
    if serpapi_key:
        patents = check_google_patents(company_name, founder_name, serpapi_key)
    else:
        logger.warning("SERPAPI_API_KEY not set. Skipping patents.")

    if google_key and cse_id:
        licenses = check_license_signals(company_name, google_key, cse_id)
    else:
        logger.warning("GOOGLE_API_KEY or GOOGLE_CSE_ID not set. Skipping licenses.")

    return {
        "patents": patents,
        "licenses": licenses
    }
