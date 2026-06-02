"""
scraper.py
Compatibility shim + Google Dork fallback scraper.

Exports:
  scrape_company_people  — re-exported from founder_scraper.py (LinkedIn /people/)
  scrape_google_dork     — headless Google search fallback when LinkedIn yields no founders
"""

from __future__ import annotations

import logging
import time
import urllib.parse
from typing import Optional

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from webdriver_manager.chrome import ChromeDriverManager

from founder_scraper import scrape_company_people  # noqa: F401  (re-export)

logger = logging.getLogger(__name__)

__all__ = ["scrape_company_people", "scrape_google_dork"]


def scrape_google_for_linkedin_url(company_name: str, industry: str | None = None) -> Optional[str]:
    """
    Search DuckDuckGo HTML for the official LinkedIn company page using Selenium to avoid blocks.
    DuckDuckGo is far less aggressive with CAPTCHAs than Google.
    """
    if industry:
        query = f'"{company_name}" {industry} site:linkedin.com/company'
    else:
        query = f'"{company_name}" site:linkedin.com/company'
        
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
    logger.info("DuckDuckGo search for LinkedIn URL -> %s", url)
    
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    
    try:
        driver.get(url)
        time.sleep(3)
        links = driver.find_elements(By.XPATH, "//a[@class='result__url']")
        for link in links:
            href = link.get_attribute("href")
            if not href:
                continue
            
            # Extract actual URL from DuckDuckGo's redirect wrapper
            parsed_query = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            actual_url = parsed_query.get('uddg', [href])[0]
            
            if "linkedin.com/company/" in actual_url:
                return actual_url.split("?")[0]
        return None
    except Exception as exc:
        logger.error("LinkedIn URL search failed: %s", exc)
        return None
    finally:
        driver.quit()

def scrape_google_dork(company_name: str, industry: str | None = None) -> Optional[str]:
    """
    Fallback scraper: run a Google dork search to find LinkedIn profiles of
    Founders / CEOs at *company_name*.
    """
    if industry:
        # No quotes around industry so it's a soft match
        query = f'site:linkedin.com/in/ "Founder" OR "CEO" "{company_name}" {industry}'
    else:
        query = f'site:linkedin.com/in/ "Founder" OR "CEO" "{company_name}"'

    url   = f"https://www.google.com/search?q={urllib.parse.quote_plus(query)}"
    logger.info("Google dork fallback for '%s' -> %s", company_name, url)

    # ── Build a headless Chrome driver ────────────────────────────────────────
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    service = Service(ChromeDriverManager().install())
    driver  = webdriver.Chrome(service=service, options=options)

    try:
        driver.get(url)
        time.sleep(3)   # let results render

        try:
            body = driver.find_element(By.ID, "search")
        except Exception:            # noqa: BLE001
            body = driver.find_element(By.TAG_NAME, "body")

        text = body.text
        logger.info(
            "Google dork returned %d characters for '%s'.", len(text), company_name
        )
        return text if text.strip() else None

    except Exception as exc:         # noqa: BLE001
        logger.error("Google dork scrape failed for '%s': %s", company_name, exc)
        return None

    finally:
        driver.quit()
