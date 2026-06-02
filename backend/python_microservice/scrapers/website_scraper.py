"""
website_scraper.py
New Pipeline — Company Website Scraper

Responsibilities:
  - scrape_website(domain)      : Scrape a domain's homepage.
  - scrape_specific_url(url)    : Scrape any specific URL (e.g. /about, /team).

Both functions:
  - First try a lightweight requests GET + BeautifulSoup parse.
  - If the result is too short (JS-heavy SPA), automatically fall back to a
    headless Selenium session to render the full DOM.
  - Return plain text (max 20 k chars) or None on failure.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_MAX_CHARS: int       = 20_000
_REQUEST_TIMEOUT: int = 15          # seconds
_USER_AGENT: str = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# If requests returns fewer than this many chars, assume JS-only shell
# and retry with Selenium.
_MIN_USEFUL_CHARS: int = 300

# HTML tags that almost never contain useful content
_TAGS_TO_STRIP = [
    "script", "style", "noscript", "header", "footer",
    "nav", "aside", "form", "svg", "img", "figure",
    "iframe", "button", "input", "select", "textarea",
    "meta", "link", "head",
]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _clean_text(raw: str) -> str:
    """Collapse whitespace and remove blank lines from extracted text."""
    text = re.sub(r"\n{3,}", "\n\n", raw)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _parse_html(html: str) -> str:
    """
    Parse *html* with BeautifulSoup, strip noise tags, and return
    clean plain text suitable for LLM input.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag_name in _TAGS_TO_STRIP:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    content = (
        soup.find("main")
        or soup.find("article")
        or soup.find("body")
        or soup
    )

    return _clean_text(content.get_text(separator="\n"))


def _fetch_html_requests(url: str) -> Optional[str]:
    """Fetch raw HTML from *url* via requests. Returns None on any error."""
    headers = {"User-Agent": _USER_AGENT}
    try:
        r = requests.get(url, headers=headers, timeout=_REQUEST_TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        return r.text
    except requests.exceptions.SSLError:
        if url.startswith("https://"):
            http_url = url.replace("https://", "http://", 1)
            logger.warning("SSL error — retrying with HTTP: %s", http_url)
            try:
                r = requests.get(
                    http_url, headers=headers, timeout=_REQUEST_TIMEOUT, allow_redirects=True
                )
                r.raise_for_status()
                return r.text
            except Exception as exc:
                logger.error("HTTP fallback also failed for %s: %s", http_url, exc)
    except requests.exceptions.ConnectionError as exc:
        logger.warning("Connection error fetching %s: %s", url, exc)
    except requests.exceptions.Timeout:
        logger.warning("Timeout fetching %s after %ds.", url, _REQUEST_TIMEOUT)
    except requests.exceptions.HTTPError as exc:
        logger.warning("HTTP error fetching %s: %s", url, exc)
    except Exception as exc:                        # noqa: BLE001
        logger.error("Unexpected error fetching %s: %s", url, exc)
    return None


def _fetch_html_selenium(url: str) -> Optional[str]:
    """
    Fetch *url* with a headless Chrome session to render JS-heavy pages.
    Returns the fully-rendered page source or None on failure.
    """
    try:
        from selenium import webdriver as wd
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager

        options = Options()
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument(f"user-agent={_USER_AGENT}")
        options.add_argument("--window-size=1440,900")

        service = Service(ChromeDriverManager().install())
        driver = wd.Chrome(service=service, options=options)
        try:
            driver.get(url)
            time.sleep(5)                                           # let JS render
            driver.execute_script("window.scrollBy(0, window.innerHeight);")
            time.sleep(2)
            return driver.page_source
        finally:
            driver.quit()

    except Exception as exc:        # noqa: BLE001
        logger.warning("Selenium fallback failed for %s: %s", url, exc)
    return None


def _scrape_url(url: str, label: str = "") -> Optional[str]:
    """
    Core fetch-and-parse logic shared by scrape_website() and
    scrape_specific_url(). Tries requests first, Selenium second.

    Args:
        url:   The full URL to fetch.
        label: Human-readable label for log messages (e.g. "website", "about page").

    Returns:
        Cleaned plain text (truncated to _MAX_CHARS) or None.
    """
    tag = f"[{label}] " if label else ""
    logger.info("%sScraping: %s", tag, url)

    # ── Strategy 1: requests ──────────────────────────────────────────────────
    html  = _fetch_html_requests(url)
    text  = _parse_html(html) if html else ""

    if text:
        logger.info("%sStrategy 1 (requests): %d chars extracted.", tag, len(text))

    # ── Strategy 2: Selenium fallback for JS SPAs ─────────────────────────────
    if len(text) < _MIN_USEFUL_CHARS:
        logger.info(
            "%sStrategy 1 returned only %d chars — trying Selenium JS render …",
            tag, len(text),
        )
        sel_html = _fetch_html_selenium(url)
        if sel_html:
            sel_text = _parse_html(sel_html)
            if len(sel_text) > len(text):
                text = sel_text
                logger.info("%sStrategy 2 (Selenium): %d chars extracted.", tag, len(text))
            else:
                logger.warning(
                    "%sSelenium returned %d chars — not better than requests.",
                    tag, len(sel_text),
                )

    if not text:
        logger.warning("%sAll strategies returned empty text for %s.", tag, url)
        return None

    if len(text) > _MAX_CHARS:
        logger.info(
            "%sTruncating text from %d → %d chars.", tag, len(text), _MAX_CHARS
        )
        text = text[:_MAX_CHARS]

    logger.info("%sScrape complete — %d chars.", tag, len(text))
    return text


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_domain_from_url(website_url: str) -> str:
    """
    Extract the clean root domain from any URL.

    Examples:
        "https://www.igaps.ai/about"  → "igaps.ai"
        "http://acme.com/"            → "acme.com"
        "stripe.com"                  → "stripe.com"

    Args:
        website_url: Any URL string, with or without a scheme.

    Returns:
        The root domain (without 'www.' prefix), or the original string
        unchanged if parsing fails.
    """
    if not website_url:
        return ""
    url = website_url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        hostname = urlparse(url).hostname or ""
        if hostname.startswith("www."):
            hostname = hostname[4:]
        return hostname
    except Exception:
        return website_url


def scrape_specific_url(website_url: str) -> Optional[str]:
    """
    Scrape any specific URL (e.g. an About page, team page, or the homepage).

    Unlike scrape_website() which normalises a bare domain and always hits '/'.
    This function takes whatever URL the caller provides and fetches it as-is.

    Args:
        website_url: Full URL to scrape, e.g. "https://www.igaps.ai/about".

    Returns:
        Plain text (max 20 k chars) or None.
    """
    if not website_url:
        logger.warning("scrape_specific_url: empty URL — skipping.")
        return None

    url = website_url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    return _scrape_url(url, label="website-url")


def scrape_website(domain: str) -> Optional[str]:
    """
    Scrape the **homepage** of *domain*.

    Args:
        domain: Root domain, e.g. "stripe.com". A scheme is optional.

    Returns:
        Plain text (max 20 k chars) or None.
    """
    if not domain:
        logger.warning("scrape_website: empty domain — skipping.")
        return None

    domain = domain.strip().rstrip("/")
    if not domain.startswith(("http://", "https://")):
        url = f"https://{domain}"
    else:
        url = domain

    return _scrape_url(url, label="website-homepage")
