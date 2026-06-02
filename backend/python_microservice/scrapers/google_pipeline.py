import os
import requests
from bs4 import BeautifulSoup
from typing import Any, Dict, List
import logging
import urllib.parse

logger = logging.getLogger(__name__)

DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

def _scrape_ddg(query: str, timeout: int = 20) -> List[Dict[str, str]]:
    """Scrapes DuckDuckGo HTML version for completely free web search results."""
    headers = {"User-Agent": USER_AGENT}
    data = {"q": query}
    try:
        response = requests.post(DDG_HTML_ENDPOINT, data=data, headers=headers, timeout=timeout)
        response.raise_for_status()
    except Exception as exc:
        logger.error(f"[DDG][ERROR] Network error for query '{query}': {exc}")
        return []
    
    soup = BeautifulSoup(response.text, "html.parser")
    results = []
    for result in soup.find_all("div", class_="result"):
        title_tag = result.find("h2", class_="result__title")
        snippet_tag = result.find("a", class_="result__snippet")
        
        if not title_tag or not snippet_tag:
            continue
            
        a_tag = title_tag.find("a")
        if not a_tag:
            continue
            
        title = a_tag.get_text(strip=True)
        link = a_tag.get("href", "")
        # Duckduckgo redirects links through their own proxy, we decode it
        if link.startswith("//duckduckgo.com/l/?uddg="):
            link = urllib.parse.unquote(link.split("uddg=")[1].split("&")[0])
        elif link.startswith("/l/?uddg="):
            link = urllib.parse.unquote(link.split("uddg=")[1].split("&")[0])
            
        snippet = snippet_tag.get_text(strip=True)
        
        results.append({
            "title": title,
            "link": link,
            "snippet": snippet
        })
    return results

def check_google_patents(company: str, founder: str, timeout: int = 20) -> List[Dict[str, Any]]:
    # Search Google Patents via DuckDuckGo completely for free
    query = f'site:patents.google.com "{company}" OR "{founder}"'
    logger.info(f"[PATENTS] Scraping free web search — {query!r}")
    
    raw_results = _scrape_ddg(query, timeout)
    patents = []
    for item in raw_results:
        # Generate patent_id roughly from title or link
        patent_id = ""
        if "patents/" in item["link"]:
            parts = item["link"].split("patents/")
            if len(parts) > 1:
                patent_id = parts[1].split("/")[0]
        
        patents.append({
            "patent_id": patent_id,
            "title": item["title"],
            "snippet": item["snippet"],
            "link": item["link"],
            "publication_date": "", # Not easily available in unstructured search
        })
        if len(patents) >= 10:
            break
            
    logger.info(f"[PATENTS] Found {len(patents)} free result(s).")
    return patents

def check_license_signals(company: str, timeout: int = 20) -> List[Dict[str, Any]]:
    query = f'"{company}" AND ("license approved" OR "regulatory approval" OR "FSSAI" OR "RBI approved" OR "registered trademark")'
    logger.info(f"[LICENSES] Scraping free web search — {query!r}")
    
    raw_results = _scrape_ddg(query, timeout)
    signals = []
    for item in raw_results:
        signals.append({
            "source_title": item["title"],
            "source_link": item["link"],
            "snippet": item["snippet"],
        })
        if len(signals) >= 5:
            break
            
    logger.info(f"[LICENSES] Found {len(signals)} free signal(s).")
    return signals

def run_google_pipeline(company_name: str, founder_name: str) -> Dict[str, Any]:
    patents = check_google_patents(company_name, founder_name)
    licenses = check_license_signals(company_name)

    return {
        "patents": patents,
        "licenses": licenses
    }
