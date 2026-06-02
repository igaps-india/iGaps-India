"""
founder_scraper.py
Authenticated LinkedIn Scraper — Company People Page + Individual Profiles

Responsibilities:
  - Launch a stealthy Chrome WebDriver session.
  - Inject saved LinkedIn cookies so we appear to be a logged-in user.
  - Navigate to the /people/ page of a LinkedIn company (scrape_company_people).
  - Scroll to trigger lazy-loaded profile cards.
  - Discover co-founders from the raw People page text (discover_cofounders).
  - Scrape individual founder/co-founder LinkedIn /in/ profile pages (scrape_linkedin_profile).
  - Return the raw visible text of each page for downstream LLM parsing.

Environment variables:
  COOKIES_PATH  (optional) — path to linkedin_cookies.pkl.
                             Defaults to 'linkedin_cookies.pkl' in cwd.
"""

from __future__ import annotations

import logging
import os
import pickle
import random
import re
import time
import urllib.parse
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException, ElementNotInteractableException
from webdriver_manager.chrome import ChromeDriverManager

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

_COOKIES_PATH: Path = Path(os.environ.get("COOKIES_PATH", "linkedin_cookies.pkl"))
_LINKEDIN_BASE = "https://www.linkedin.com"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_driver() -> webdriver.Chrome:
    """
    Create a Chrome WebDriver with anti-detection / stealth settings.
    Uses webdriver-manager to auto-install the correct chromedriver binary.
    """
    options = Options()

    # --- Core stealth flags ---------------------------------------------------
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    # --- Realistic browser environment ----------------------------------------
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
    options.add_argument("--window-size=1440,900")
    options.add_argument("--start-maximized")
    options.add_argument("--lang=en-US,en;q=0.9")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-infobars")
    options.add_argument("--disable-extensions")

    # Uncomment the next line to run headless (less detectable on servers):
    # options.add_argument("--headless=new")

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)

    # Mask the `navigator.webdriver` property via CDP
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {
            "source": (
                "Object.defineProperty(navigator, 'webdriver', "
                "{get: () => undefined});"
            )
        },
    )

    logger.debug("Chrome WebDriver started.")
    return driver


def _slug_from_url(linkedin_company_url: str) -> str:
    """
    Extract the company slug from a LinkedIn company URL.

    Examples:
      https://www.linkedin.com/company/stripe/        → stripe
      https://linkedin.com/company/openai             → openai
      https://www.linkedin.com/company/stripe/about/  → stripe
    """
    parsed = urllib.parse.urlparse(linkedin_company_url)
    parts = [p for p in parsed.path.split("/") if p]
    # path looks like ['company', 'stripe', ...]
    try:
        company_idx = parts.index("company")
        return parts[company_idx + 1]
    except (ValueError, IndexError):
        # Fallback: use the last non-empty path segment
        return parts[-1] if parts else linkedin_company_url


def _load_cookies(driver: webdriver.Chrome) -> None:
    """
    Navigate to LinkedIn's root, inject cookies from the pickle file, and
    refresh so that the authenticated session is active.
    """
    if not _COOKIES_PATH.exists():
        raise FileNotFoundError(
            f"Cookie file not found: {_COOKIES_PATH}. "
            "Please run your cookie-capture script first."
        )

    logger.info("Loading LinkedIn cookies from '%s' …", _COOKIES_PATH)
    driver.get(_LINKEDIN_BASE)
    time.sleep(random.uniform(2.0, 3.5))

    with open(_COOKIES_PATH, "rb") as fh:
        cookies: list[dict] = pickle.load(fh)

    for cookie in cookies:
        # Selenium requires the 'sameSite' value to be one of a fixed set
        cookie.pop("sameSite", None)
        try:
            driver.add_cookie(cookie)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Skipped cookie '%s': %s", cookie.get("name"), exc)

    logger.info("Cookies injected. Refreshing page …")
    driver.refresh()
    time.sleep(random.uniform(3.0, 5.0))


def _gradual_scroll(driver: webdriver.Chrome, step_px: int = 800) -> None:
    """
    Scroll the current page from top to bottom in *step_px*-pixel increments,
    pausing between each step so LinkedIn's lazy-load XHR requests can fire
    and inject the Experience, Education, and Awards sections into the DOM.

    Algorithm:
      - Read the current scrollY position and document height before each step.
      - Scroll down by *step_px* pixels.
      - Sleep 1.5 -- 2.0 seconds (randomised to mimic human behaviour).
      - Stop when scrollY + window.innerHeight >= document.body.scrollHeight
        (i.e. we have genuinely reached the bottom).
      - Safety cap: at most 60 steps (~48 000 px) so we never loop forever
        on an infinite-scroll page.
    """
    MAX_STEPS = 60
    for step in range(MAX_STEPS):
        # Capture position BEFORE scrolling
        before = driver.execute_script("return window.scrollY;")
        page_h = driver.execute_script("return document.body.scrollHeight;")
        win_h  = driver.execute_script("return window.innerHeight;")

        driver.execute_script(f"window.scrollBy(0, {step_px});")
        pause = random.uniform(1.5, 2.0)
        logger.debug(
            "Gradual scroll step %d: scrollY=%d  pageH=%d  sleeping %.1fs",
            step + 1, before, page_h, pause,
        )
        time.sleep(pause)

        # Check whether we have reached the bottom
        after = driver.execute_script("return window.scrollY;")
        if after + win_h >= page_h:
            logger.info(
                "_gradual_scroll: reached page bottom after %d step(s) "
                "(scrollY=%d, pageH=%d).",
                step + 1, after, page_h,
            )
            break
        # If scroll position didn't change at all, also stop
        if after == before:
            logger.info(
                "_gradual_scroll: scroll position unchanged -- page bottom reached "
                "after %d step(s).",
                step + 1,
            )
            break
    else:
        logger.warning(
            "_gradual_scroll: hit safety cap of %d steps -- page may be very long "
            "or infinite-scroll.",
            MAX_STEPS,
        )


# Keep the old helper as an alias used by scrape_company_people
def _scroll_page(driver: webdriver.Chrome, scrolls: int = 3) -> None:
    """Coarse viewport-height scroll used for the company People page."""
    for i in range(scrolls):
        driver.execute_script("window.scrollBy(0, window.innerHeight * 1.5);")
        pause = random.uniform(2.0, 4.0)
        logger.debug("Scroll %d/%d -- waiting %.1f s", i + 1, scrolls, pause)
        time.sleep(pause)


def _scroll_to_section(driver: webdriver.Chrome, section_heading: str) -> None:
    """
    Scroll down gradually until the specified section is found in the DOM.
    Once found, it scrolls the section into view and stops.
    """
    heading_lower = section_heading.lower()
    xpath = (
        f"//h2[contains("
        f"translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')"
        f", '{heading_lower}')]"
        f"/ancestor-or-self::section[1]"
    )
    
    logger.info("Scrolling down slowly to find '%s' section...", section_heading)
    for step in range(12):
        try:
            elements = driver.find_elements(By.XPATH, xpath)
            if elements:
                # Found it! Scroll it into view and stop.
                driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'start'});", elements[0])
                time.sleep(2.0)
                logger.info("Found '%s' section and stopped scrolling.", section_heading)
                return
        except Exception:
            pass
            
        # Drag the page down by finding the last section and scrolling to it
        driver.execute_script("""
            var sections = document.querySelectorAll("section");
            if (sections.length > 0) {
                sections[sections.length - 1].scrollIntoView({behavior: 'smooth', block: 'end'});
            } else {
                window.scrollBy(0, 800);
            }
        """)
        time.sleep(1.5)
    
    logger.warning("Did not find '%s' section after scrolling.", section_heading)


def _safe_scroll_profile(driver: webdriver.Chrome) -> None:
    """
    Scroll the LinkedIn profile down gradually to trigger lazy-loading of 
    the Experience, Education, and Skills sections.

    We use a sequence of section-targeting scrolls to ensure content loads.
    """
    logger.info("_safe_scroll_profile: Initiating robust sequential section scroll.")
    
    _scroll_to_section(driver, "Experience")
    _scroll_to_section(driver, "Education")
    _scroll_to_section(driver, "Skills")

    # Final forced jump to the very bottom
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);")
    time.sleep(2.0)

    # ── Post-scroll DOM wait: confirm key sections have loaded ────────────────
    # LinkedIn lazy-loads section content via XHR as you scroll.  Give it up
    # to 8 seconds to inject the Experience and Education h2 elements.
    _h2_xpath = (
        "//h2[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'experience') or "
        "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'education')]"
    )
    try:
        WebDriverWait(driver, 8).until(
            EC.presence_of_element_located((By.XPATH, _h2_xpath))
        )
        logger.info("_safe_scroll_profile: Experience/Education sections confirmed in DOM.")
    except TimeoutException:
        logger.warning(
            "_safe_scroll_profile: Experience/Education h2 not found after scroll — "
            "sections may not have loaded. Extraction will still be attempted."
        )




def _wait_for_people_section(driver: webdriver.Chrome, timeout: int = 15) -> None:
    """
    Wait until at least one person card appears, indicating the People section
    has loaded. Falls through gracefully if nothing renders.
    """
    try:
        WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "section.org-people, div[data-view-name='org-view-member-module']")
            )
        )
        logger.debug("People section detected.")
    except Exception:  # noqa: BLE001
        logger.warning("Timed out waiting for people section — proceeding anyway.")


# ---------------------------------------------------------------------------
# DOM link extraction helper
# ---------------------------------------------------------------------------

def _extract_profile_links_from_dom(driver: webdriver.Chrome) -> dict[str, str]:
    """
    Scrape all visible LinkedIn /in/ profile links from the current page DOM.

    LinkedIn renders person-card anchor tags as ``<a href="/in/slug">`` in the
    DOM; these hrefs are NOT present in ``.text`` output.  This helper finds
    every such anchor and returns a mapping of:
        { lowercased_full_name : absolute_linkedin_profile_url }

    The name is taken from the anchor's visible text (first non-empty line).
    Falls through silently and returns {} on any error.
    """
    profile_map: dict[str, str] = {}
    try:
        # LinkedIn person-card links match href starting with /in/
        anchors = driver.find_elements(
            By.XPATH,
            "//a[starts-with(@href, '/in/') or contains(@href, 'linkedin.com/in/')]",
        )
        for anchor in anchors:
            try:
                href = anchor.get_attribute("href") or ""
                if "linkedin.com/in/" not in href and not href.startswith("/in/"):
                    continue
                # Make absolute
                if href.startswith("/"):
                    href = _LINKEDIN_BASE + href
                href = href.split("?")[0].rstrip("/")

                # Use the anchor text as the person name
                raw_text = (anchor.text or "").strip()
                name_line = next(
                    (ln.strip() for ln in raw_text.splitlines() if ln.strip()), ""
                )
                if name_line and "linkedin.com/in/" in href:
                    profile_map[name_line.lower()] = href
            except Exception:  # noqa: BLE001
                continue
    except Exception as exc:  # noqa: BLE001
        logger.debug("_extract_profile_links_from_dom: %s", exc)
    logger.info(
        "_extract_profile_links_from_dom: found %d profile link(s).", len(profile_map)
    )
    return profile_map


# ---------------------------------------------------------------------------
# Employee count extraction (multi-strategy)
# ---------------------------------------------------------------------------

def _extract_employee_count(driver: webdriver.Chrome) -> str:
    """
    Multi-strategy extraction of employee count from the current LinkedIn page.

    Strategies (in order of reliability):
      1. Regex scan of full page text for patterns like "2-10 employees"
      2. XPath for elements containing 'employee' text with a digit
      3. dt/dd pairs where dt contains "Company size"
      4. "X employees on LinkedIn" alternative pattern

    Returns the employee count string (e.g. "2-10 employees") or "".
    """
    # ── Strategy 1: Regex on full page text ──────────────────────────────
    try:
        body_text = driver.find_element(By.TAG_NAME, "body").text
        # Match patterns like "2-10 employees", "51-200 employees",
        # "1,001-5,000 employees"
        emp_pattern = re.compile(
            r'(\d[\d,]*\s*[-\u2013]\s*\d[\d,]*\s*employees?)',
            re.IGNORECASE,
        )
        match = emp_pattern.search(body_text)
        if match:
            result = match.group(1).strip()
            logger.info("Employee count via regex: '%s'", result)
            return result
    except Exception as exc:  # noqa: BLE001
        logger.debug("Employee count regex strategy failed: %s", exc)

    # ── Strategy 2: XPath for elements with 'employee' text + digit ─────
    try:
        emp_elements = driver.find_elements(
            By.XPATH,
            "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
            " 'abcdefghijklmnopqrstuvwxyz'), 'employee')]",
        )
        for el in emp_elements:
            raw = (el.text or "").strip()
            if raw and len(raw) < 80 and re.search(r'\d', raw):
                logger.info("Employee count via XPath: '%s'", raw)
                return raw
    except Exception as exc:  # noqa: BLE001
        logger.debug("Employee count XPath strategy failed: %s", exc)

    # ── Strategy 3: dt/dd pair for "Company size" ────────────────────────
    try:
        dt_elements = driver.find_elements(
            By.XPATH,
            "//dt[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
            " 'abcdefghijklmnopqrstuvwxyz'), 'company size')]",
        )
        for dt in dt_elements:
            try:
                dd = dt.find_element(By.XPATH, "following-sibling::dd[1]")
                dd_text = (dd.text or "").strip()
                if dd_text:
                    logger.info("Employee count via dt/dd: '%s'", dd_text)
                    return dd_text
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        logger.debug("Employee count dt/dd strategy failed: %s", exc)

    # ── Strategy 4: "X employees on LinkedIn" alternative pattern ────────
    try:
        body_text = driver.find_element(By.TAG_NAME, "body").text
        alt_pattern = re.compile(
            r'(\d[\d,]*)\s+employees?\s+on\s+LinkedIn',
            re.IGNORECASE,
        )
        match = alt_pattern.search(body_text)
        if match:
            result = match.group(0).strip()
            logger.info("Employee count via 'on LinkedIn' pattern: '%s'", result)
            return result
    except Exception:  # noqa: BLE001
        pass

    logger.warning("Employee count: all strategies failed on current page.")
    return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scrape_company_people(linkedin_company_url: str) -> Optional[str]:
    """
    Visit the /people/ page of *linkedin_company_url* using an authenticated
    session and return the raw page text for LLM parsing.

    IMPORTANT: LinkedIn renders person-card profile links as JavaScript anchors
    (href="/in/slug"). They are NOT present in element.text output. This
    function now also extracts those hrefs from the DOM and appends them as
    explicit ``PROFILE_LINKS`` lines so downstream regex can find them.

    Args:
        linkedin_company_url: Full LinkedIn company URL, e.g.
                              'https://www.linkedin.com/company/stripe/'

    Returns:
        A (potentially large) string with all visible text + appended
        PROFILE_LINKS section, or None if the scrape could not be completed.
    """
    slug = _slug_from_url(linkedin_company_url)
    main_url   = f"{_LINKEDIN_BASE}/company/{slug}/"
    about_url  = f"{_LINKEDIN_BASE}/company/{slug}/about/"
    people_url = f"{_LINKEDIN_BASE}/company/{slug}/people/"

    driver = _build_driver()
    try:
        # 1. Inject cookies so we are authenticated
        _load_cookies(driver)

        # ── 2a. Visit MAIN company page to extract employee count from header ──
        employee_count_text: str = ""
        logger.info("Scraping main company page for employee size: %s", main_url)
        driver.get(main_url)
        time.sleep(random.uniform(2.5, 4.0))

        employee_count_text = _extract_employee_count(driver)
        if employee_count_text:
            logger.info("Employee count from main page: '%s'", employee_count_text)

        # ── 2b. Navigate to the /about/ page for detailed company info ─────────
        logger.info("Scraping About page: %s", about_url)
        driver.get(about_url)
        time.sleep(random.uniform(2.5, 4.0))

        # Try employee extraction again on /about/ if main page didn't yield it
        if not employee_count_text:
            employee_count_text = _extract_employee_count(driver)
            if employee_count_text:
                logger.info("Employee count from about page: '%s'", employee_count_text)

        about_text = ""
        try:
            about_container = driver.find_element(By.TAG_NAME, "main")
            about_text = about_container.text
        except Exception:
            try:
                about_text = driver.find_element(By.TAG_NAME, "body").text
            except Exception:
                pass

        # Prepend the extracted employee count as an explicit, unambiguous line
        # so the LLM cannot miss it even if it is buried in the About text.
        if employee_count_text:
            about_text = f"EMPLOYEE_SIZE: {employee_count_text}\n" + about_text

        logger.info("Extracted %d characters from About page.", len(about_text))

        # 3. Navigate to the target /people/ page
        logger.info("Scraping People page: %s", people_url)
        driver.get(people_url)
        time.sleep(random.uniform(3.0, 5.5))

        # 4. Wait for content and scroll to load lazy profiles
        _wait_for_people_section(driver)
        _scroll_page(driver, scrolls=3)

        # 5. Extract raw text from the body
        try:
            people_container = driver.find_element(By.TAG_NAME, "main")
        except Exception:  # noqa: BLE001
            people_container = driver.find_element(By.TAG_NAME, "body")

        people_text = people_container.text
        logger.info("Extracted %d characters from People page.", len(people_text))

        # ── KEY FIX: extract profile hrefs from DOM anchors ──────────────────
        # LinkedIn renders /in/ links as JS-driven <a href="/in/slug"> tags.
        # element.text never includes these URLs, so we pull them explicitly.
        profile_links = _extract_profile_links_from_dom(driver)

        # Append a structured section that downstream regex can reliably parse
        profile_links_section = "\n\n=== PROFILE_LINKS (name → url) ===\n"
        for name, url in profile_links.items():
            profile_links_section += f"{name} {url}\n"

        combined_text = (
            f"=== ABOUT SECTION ===\n{about_text}\n\n"
            f"=== PEOPLE SECTION ===\n{people_text}"
            f"{profile_links_section}"
        )
        return combined_text

    except Exception as exc:  # noqa: BLE001
        logger.error("Scrape failed for '%s': %s", linkedin_company_url, exc)
        return None

    finally:
        driver.quit()
        logger.debug("WebDriver closed.")


# ---------------------------------------------------------------------------
# Co-Founder Discovery (parses raw People page text — no extra HTTP call)
# ---------------------------------------------------------------------------

# Titles that indicate a co-founding / founding partner role
_COFOUNDER_TITLE_PATTERN = re.compile(
    r"\b(co[-\s]?founder|cofounder|founding\s+partner|partner)\b",
    re.IGNORECASE,
)

# LinkedIn /in/ profile URL pattern
_LI_PROFILE_URL_PATTERN = re.compile(
    r"https?://(?:www\.)?linkedin\.com/in/[\w\-]+",
    re.IGNORECASE,
)


def discover_cofounders(
    people_page_text: str,
    known_founder_name: str,
) -> list[dict[str, str | None]]:
    """
    Scan raw People-page text for co-founders / founding partners, excluding
    the already-known primary founder.

    The LinkedIn /people/ page typically shows cards like:

        John Smith
        Co-Founder & CTO
        https://www.linkedin.com/in/johnsmith

    This function uses a sliding-window approach over the text lines to
    associate a title line that matches co-founder patterns with the
    closest name-like line above it, and the closest LinkedIn URL below it.

    Args:
        people_page_text:  Raw text scraped from the LinkedIn /people/ page.
        known_founder_name: Full name of the primary founder to exclude
                            (case-insensitive, partial match is fine).

    Returns:
        List of dicts:  [{"name": str, "linkedin_url": str | None}, ...]
        Empty list if none found.
    """
    if not people_page_text:
        return []

    known_lower = known_founder_name.lower().strip() if known_founder_name else ""
    lines = people_page_text.splitlines()
    cofounders: list[dict[str, str | None]] = []
    seen_names: set[str] = set()

    for i, line in enumerate(lines):
        line_stripped = line.strip()
        if not _COFOUNDER_TITLE_PATTERN.search(line_stripped):
            continue

        # Look backwards (up to 5 lines) for a name
        candidate_name: str | None = None
        for j in range(i - 1, max(i - 6, -1), -1):
            prev = lines[j].strip()
            # A name-like line: 2-5 words, mostly title-case, no digits, not a URL
            if (
                prev
                and not prev.startswith("http")
                and len(prev.split()) in range(2, 6)
                and not re.search(r"\d", prev)
                and prev[0].isupper()
            ):
                candidate_name = prev
                break

        if not candidate_name:
            continue

        # Skip if this is the known founder
        if known_lower and known_lower in candidate_name.lower():
            logger.debug("discover_cofounders: skipping known founder '%s'.", candidate_name)
            continue

        # Deduplicate
        name_key = candidate_name.lower()
        if name_key in seen_names:
            continue
        seen_names.add(name_key)

        # Look forwards (up to 5 lines) for a LinkedIn /in/ URL
        profile_url: str | None = None
        for j in range(i + 1, min(i + 6, len(lines))):
            url_match = _LI_PROFILE_URL_PATTERN.search(lines[j])
            if url_match:
                profile_url = url_match.group(0).split("?")[0]  # strip query params
                break

        logger.info(
            "discover_cofounders: found '%s' (title line: '%s') — URL: %s",
            candidate_name, line_stripped, profile_url,
        )
        cofounders.append({"name": candidate_name, "linkedin_url": profile_url})

    logger.info(
        "discover_cofounders: %d co-founder(s) found (excluding '%s').",
        len(cofounders), known_founder_name,
    )
    return cofounders


# ---------------------------------------------------------------------------
# Individual LinkedIn Profile Scraper
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Targeted section-text extraction helper
# ---------------------------------------------------------------------------

# Activity section headings — hard exclusion list used by _extract_section_text
_ACTIVITY_SECTION_KEYWORDS: frozenset[str] = frozenset(
    {"activity", "posts", "comments", "reactions", "reposts", "featured"}
)

def _is_activity_content(text: str) -> bool:
    """
    Guard function to detect if the extracted text contains telltale signs
    of LinkedIn Activity feed / social media posts, which indicates the extraction
    captured the wrong section.

    IMPORTANT — deliberately conservative so we never false-positive on
    legitimate Experience / Education text.  Only return True when MULTIPLE
    independent signals all fire together.
    """
    if not text:
        return False

    lower_text = text.lower()

    # Signal 1 — explicit engagement verb phrases only found in post cards
    has_engage_verb = (
        "liked this" in lower_text
        or "commented on this" in lower_text
        or "reposted this" in lower_text
        or "celebrated this" in lower_text
    )

    # Signal 2 — engagement metric numbers ("47 likes", "12 comments").
    # Only count patterns where the number is followed *immediately* by the
    # engagement word — avoids matching "3 years" or "5 companies".
    has_metric = bool(
        re.search(r'\b\d+\s*(likes?|reposts?)\b', lower_text)
    )

    # Signal 3 — standalone timestamp lines (e.g. a line that is ONLY "3w"
    # or "2mo").  We check each line individually to avoid matching subwords
    # like "3d animation" or "2m experience" inside normal sentences.
    timestamp_lines = sum(
        1 for line in text.splitlines()
        if re.fullmatch(r'\s*\d+\s*(w|d|mo|h|m)\s*', line, re.IGNORECASE)
    )
    has_many_timestamps = timestamp_lines >= 3

    # Signal 4 — the word "activity" appears as a section heading in the text
    has_activity_heading = bool(
        re.search(r'^activity\s*$', lower_text, re.MULTILINE)
    )

    # Require at least TWO independent signals to classify as Activity content
    signals = sum([
        has_engage_verb,
        has_metric,
        has_many_timestamps,
        has_activity_heading,
    ])
    return signals >= 2


def _extract_section_text(
    driver: webdriver.Chrome,
    section_heading: str,
) -> str:
    """
    Locate a LinkedIn profile section by its *exact heading text* using a
    structural ``//h2[contains(., heading)]/ancestor::section`` XPath.

    This strategy is deliberately free of CSS class names, which LinkedIn
    changes frequently between deployments.  The ``<h2>`` heading is stable
    because it is rendered as visible text that users can read.

    Algorithm:
      1. Build an XPath that walks from the matching ``<h2>`` up to its
         enclosing ``<section>`` element.
      2. Verify the section heading does NOT match any Activity/feed keyword
         (hard exclusion guard).
      3. Inside the matched ``<section>``, use ``WebDriverWait`` + click to
         expand every "see more", "...more", "show all", "show all experiences",
         and "show all education" button before capturing text.
      4. Return ``section.text`` — scoped entirely to that one ``<section>``
         so no Activity posts, nav bars, or ads leak in.

    Args:
        driver:          Active Selenium WebDriver on a LinkedIn /in/ page.
        section_heading: Display heading of the section to extract, e.g.
                         "Experience", "Education", "About", "Skills".

    Returns:
        Visible text of the matched section, or "" if not found.
    """
    # XPath: find a <section> that contains an <h2> whose text matches the
    # requested heading.  The translate() lower-cases both sides so the match
    # is case-insensitive without requiring exact casing.
    #
    # IMPORTANT — use ancestor-or-self::section[1] (the INNERMOST ancestor)
    # rather than plain ancestor::section (which returns ALL ancestors and
    # can grab a massive outer wrapper that contains the Activity feed).
    heading_lower = section_heading.lower()
    xpath = (
        f"//h2[contains("
        f"translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')"
        f", '{heading_lower}')]"
        f"/ancestor-or-self::section[1]"
    )

    try:
        candidate_sections = driver.find_elements(By.XPATH, xpath)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "_extract_section_text: XPath query failed for '%s': %s",
            section_heading, exc,
        )
        return ""

    for section in candidate_sections:
        try:
            # Read back the actual h2 text to apply the Activity exclusion check
            h2_elements = section.find_elements(By.XPATH, ".//h2")
            heading_text = ""
            for h in h2_elements:
                t = (h.text or "").strip().lower()
                if t:
                    heading_text = t
                    break

            # Hard exclusion: never return Activity / feed section content
            if any(kw in heading_text for kw in _ACTIVITY_SECTION_KEYWORDS):
                logger.debug(
                    "_extract_section_text: skipping Activity/feed section "
                    "(h2='%s').", heading_text,
                )
                continue

            # Skip sections that seem to be "People also viewed" or similar sidebar content
            if "people also viewed" in heading_text or "others named" in heading_text:
                continue

            logger.debug(
                "_extract_section_text: matched section h2='%s' for keyword='%s'.",
                heading_text, section_heading,
            )

            # ── Expand hidden content inside this section ──────────────────
            # XPaths are scoped with './/…' so they only match within this
            # <section>, not anywhere else on the page.
            expand_xpaths = [
                # "See more" visible button text
                ".//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'see more')]",
                # "...more" span → parent button (About section truncation)
                ".//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), '...more')]/ancestor::button",
                # Span wrapping 'see more' text → parent button
                ".//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'see more')]/ancestor::button",
                # "Show all experiences"
                ".//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all experiences')]",
                ".//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all experiences')]",
                ".//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all experiences')]/ancestor::button",
                # "Show all education"
                ".//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all education')]",
                ".//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all education')]",
                ".//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all education')]/ancestor::button",
                # Generic "Show all" (Skills, Projects, etc.)
                ".//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all')]",
                ".//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                "'abcdefghijklmnopqrstuvwxyz'), 'show all')]",
            ]

            for xpath_btn in expand_xpaths:
                try:
                    btns = section.find_elements(By.XPATH, xpath_btn)
                    for btn in btns[:5]:
                        try:
                            # Scroll into view first so the click doesn't miss
                            driver.execute_script(
                                "arguments[0].scrollIntoView({block:'center'});", btn
                            )
                            # WebDriverWait: wait up to 3 s for element to be clickable
                            WebDriverWait(driver, 3).until(
                                EC.element_to_be_clickable(btn)
                            )
                            driver.execute_script("arguments[0].click();", btn)
                            time.sleep(1.0)  # mandatory 1-s DOM render wait
                            logger.debug(
                                "_extract_section_text: clicked expand btn in '%s'.",
                                section_heading,
                            )
                        except (TimeoutException, ElementNotInteractableException):
                            pass
                        except Exception:  # noqa: BLE001
                            pass
                except Exception:  # noqa: BLE001
                    pass

            text = (section.text or "").strip()
            
            # Post-extraction guards: content and length checks
            if _is_activity_content(text):
                logger.warning(
                    "_extract_section_text: '%s' text contains Activity feed patterns. Skipping.",
                    section_heading,
                )
                continue

            # 25 000-char cap — a real Experience section with many roles can
            # legitimately run to 15 000+ chars after all expand clicks.
            # The old 8 000-char limit was silently discarding valid sections.
            if len(text) > 25_000:
                logger.warning(
                    "_extract_section_text: '%s' extracted %d chars — exceeds 25 000-char "
                    "cap, likely a leaked page body. Skipping.",
                    section_heading, len(text),
                )
                continue
                
            logger.info(
                "_extract_section_text: '%s' → %d characters extracted.",
                section_heading, len(text),
            )
            return text

        except Exception:  # noqa: BLE001
            continue

    logger.debug(
        "_extract_section_text: no section found for heading '%s'.",
        section_heading,
    )
    return ""


def _extract_intro_card(driver: webdriver.Chrome) -> str:
    """
    Extract the hero/intro card at the top of a LinkedIn profile:
    name, headline, and location.

    Strategy — XPath first (no CSS classes), CSS fallback:
      1. Anchor on the ``<h1>`` tag (the profile name) — the only guaranteed
         stable landmark on a LinkedIn /in/ page.  Grab the first ancestor
         element that is either a ``<section>`` or a ``<div>`` and that
         contains the ``<h1>``.  This works whether LinkedIn renders the intro
         card as a ``<section>`` or a ``<div>`` (layout changes often).
      2. Fallback: ``data-view-name='profile-card'`` attribute (stable).
      3. Last resort: ``div.pv-top-card`` (historical, class-based).

    All captured text is passed through ``_is_activity_content()`` before
    being returned — if the guard fires, an empty string is returned instead
    so Activity feed content can never pollute the LLM prompt.

    Returns the card's visible text, or an empty string on failure.
    """
    # XPath strategy: find the <h1> (profile name) and walk up to its
    # immediate structural container — either a <section> or a <div>.
    # Using [1] ensures we always take the topmost / first match.
    # This XPath is intentionally free of CSS class names.
    xpath_strategies = [
        # Prefer the section explicitly tagged as the profile card
        "//section[@data-view-name='profile-card']",
        # Layout-proof: find the first <section> or <div> under <main>
        # that contains an <h1> (the name field).  Works regardless of
        # whether LinkedIn wraps the intro card in a <section> or a <div>.
        "//main//*[(self::section or self::div) and .//h1][1]",
    ]

    for xpath in xpath_strategies:
        try:
            el = driver.find_element(By.XPATH, xpath)
            text = (el.text or "").strip()
            if text:
                # Activity guardrail — never return feed/post content
                if _is_activity_content(text):
                    logger.warning(
                        "_extract_intro_card: XPath '%s' captured Activity feed "
                        "content (%d chars). Discarding and trying next strategy.",
                        xpath, len(text),
                    )
                    continue
                logger.info(
                    "_extract_intro_card: captured %d chars via XPath '%s'.",
                    len(text), xpath,
                )
                return text
        except Exception:  # noqa: BLE001
            continue

    css_fallbacks = [
        "section[data-view-name='profile-card']",
        "div.pv-top-card",
    ]
    for css in css_fallbacks:
        try:
            el = driver.find_element(By.CSS_SELECTOR, css)
            text = (el.text or "").strip()
            if text:
                # Activity guardrail — never return feed/post content
                if _is_activity_content(text):
                    logger.warning(
                        "_extract_intro_card: CSS '%s' captured Activity feed "
                        "content (%d chars). Discarding and trying next strategy.",
                        css, len(text),
                    )
                    continue
                logger.info(
                    "_extract_intro_card: captured %d chars via CSS '%s'.",
                    len(text), css,
                )
                return text
        except Exception:  # noqa: BLE001
            continue

    logger.debug("_extract_intro_card: no intro card element found.")
    return ""


# ---------------------------------------------------------------------------
# Individual LinkedIn Profile Scraper (targeted section-by-section)
# ---------------------------------------------------------------------------

def scrape_linkedin_profile(profile_url: str) -> Optional[str]:
    """
    Scrape an individual LinkedIn /in/ profile page using an authenticated
    cookie session.

    Instead of relying on brittle scroll/click/DOM-parse logic on the main
    profile page, this function navigates directly to LinkedIn's dedicated
    backend detail sub-pages for each section:

      /details/experience/  — full experience history
      /details/education/   — full education history
      /details/skills/      — endorsed skills list

    The main profile page is still visited first to capture the intro card
    (name, headline, location) and any immediately visible About text.

    Each sub-page visit is wrapped in its own try-except block so the scrape
    continues gracefully if a user is missing a specific section.

    The assembled string is written to ``raw_founder_dump.txt`` and
    ``debug_profile_dump.txt`` for debugging, then returned to the caller
    for downstream LLM parsing.

    Args:
        profile_url: Full LinkedIn /in/ profile URL.

    Returns:
        Structured profile text string, or None on failure.
    """
    if not profile_url or "linkedin.com/in/" not in profile_url:
        logger.warning(
            "scrape_linkedin_profile: invalid or missing profile URL: '%s'", profile_url
        )
        return None

    # Normalise URL — strip query params and trailing slash
    clean_url = profile_url.split("?")[0].rstrip("/")

    driver = _build_driver()
    try:
        # ── Step 1: authenticated session ─────────────────────────────────────
        _load_cookies(driver)

        # ── Step 2: navigate to main profile page ─────────────────────────────
        logger.info("Scraping LinkedIn profile (main page): %s", clean_url)
        driver.get(clean_url)
        time.sleep(random.uniform(3.0, 5.0))

        # ── Step 2b: login-wall guard ─────────────────────────────────────────
        if _detect_login_wall(driver):
            logger.error(
                "scrape_linkedin_profile: blocked by LinkedIn login wall for '%s'. "
                "Refresh cookies and retry.",
                clean_url,
            )
            return None

        # ── Step 3: Intro & About — extract from main profile page ────────────
        logger.info("Extracting intro card and about text from main profile page...")
        intro_text = _extract_intro_card(driver)

        about_text = ""
        try:
            about_text = driver.find_element(By.TAG_NAME, "body").text
        except Exception:  # noqa: BLE001
            logger.debug("scrape_linkedin_profile: could not extract body text from main page.")

        intro_about_combined = ""
        if intro_text:
            intro_about_combined += intro_text + "\n\n"
        if about_text:
            intro_about_combined += about_text

        # ── Step 4: Direct navigation to /details/experience/ ─────────────────
        experience_text = ""
        try:
            logger.info("Navigating to experience detail page...")
            driver.get(clean_url + "/details/experience/")
            time.sleep(random.uniform(2.5, 4.0))
            # Expand hidden inline descriptions before capturing text
            try:
                inline_btns = driver.find_elements(
                    By.XPATH,
                    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), 'see more') or "
                    "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), '...more')]",
                )
                for btn in inline_btns[:30]:  # cap at 30 to prevent endless loops
                    try:
                        driver.execute_script(
                            "arguments[0].scrollIntoView({block:'center'});", btn
                        )
                        time.sleep(0.2)
                        driver.execute_script("arguments[0].click();", btn)
                    except Exception:  # noqa: BLE001
                        pass
                time.sleep(1.0)  # wait for all texts to render
                logger.debug(
                    "Experience sub-page: clicked %d inline expand button(s).",
                    len(inline_btns[:30]),
                )
            except Exception as btn_exc:  # noqa: BLE001
                logger.debug("Error expanding inline buttons on experience page: %s", btn_exc)
            experience_text = driver.find_element(By.TAG_NAME, "body").text
            logger.info(
                "Experience page extracted — %d characters.", len(experience_text)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "scrape_linkedin_profile: could not extract experience page: %s", exc
            )

        # ── Step 5: Direct navigation to /details/education/ ──────────────────
        education_text = ""
        try:
            logger.info("Navigating to education detail page...")
            driver.get(clean_url + "/details/education/")
            time.sleep(random.uniform(2.5, 4.0))
            # Expand hidden inline descriptions before capturing text
            try:
                inline_btns = driver.find_elements(
                    By.XPATH,
                    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), 'see more') or "
                    "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), '...more')]",
                )
                for btn in inline_btns[:30]:  # cap at 30 to prevent endless loops
                    try:
                        driver.execute_script(
                            "arguments[0].scrollIntoView({block:'center'});", btn
                        )
                        time.sleep(0.2)
                        driver.execute_script("arguments[0].click();", btn)
                    except Exception:  # noqa: BLE001
                        pass
                time.sleep(1.0)  # wait for all texts to render
                logger.debug(
                    "Education sub-page: clicked %d inline expand button(s).",
                    len(inline_btns[:30]),
                )
            except Exception as btn_exc:  # noqa: BLE001
                logger.debug("Error expanding inline buttons on education page: %s", btn_exc)
            education_text = driver.find_element(By.TAG_NAME, "body").text
            logger.info(
                "Education page extracted — %d characters.", len(education_text)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "scrape_linkedin_profile: could not extract education page: %s", exc
            )

        # ── Step 6: Direct navigation to /details/skills/ ─────────────────────
        skills_text = ""
        try:
            logger.info("Navigating to skills detail page...")
            driver.get(clean_url + "/details/skills/")
            time.sleep(random.uniform(2.5, 4.0))
            # Expand hidden inline descriptions before capturing text
            try:
                inline_btns = driver.find_elements(
                    By.XPATH,
                    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), 'see more') or "
                    "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
                    " 'abcdefghijklmnopqrstuvwxyz'), '...more')]",
                )
                for btn in inline_btns[:30]:  # cap at 30 to prevent endless loops
                    try:
                        driver.execute_script(
                            "arguments[0].scrollIntoView({block:'center'});", btn
                        )
                        time.sleep(0.2)
                        driver.execute_script("arguments[0].click();", btn)
                    except Exception:  # noqa: BLE001
                        pass
                time.sleep(1.0)  # wait for all texts to render
                logger.debug(
                    "Skills sub-page: clicked %d inline expand button(s).",
                    len(inline_btns[:30]),
                )
            except Exception as btn_exc:  # noqa: BLE001
                logger.debug("Error expanding inline buttons on skills page: %s", btn_exc)
            skills_text = driver.find_element(By.TAG_NAME, "body").text
            logger.info(
                "Skills page extracted — %d characters.", len(skills_text)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "scrape_linkedin_profile: could not extract skills page: %s", exc
            )

        # ── Step 7: assemble structured payload ───────────────────────────────
        parts: list[str] = []

        if intro_about_combined.strip():
            parts.append(f"=== INTRO & ABOUT ===\n{intro_about_combined.strip()}")
        if experience_text.strip():
            parts.append(f"=== EXPERIENCE ===\n{experience_text.strip()}")
        if education_text.strip():
            parts.append(f"=== EDUCATION ===\n{education_text.strip()}")
        if skills_text.strip():
            parts.append(f"=== SKILLS ===\n{skills_text.strip()}")

        raw_scraped_text = "\n\n".join(parts)

        # ── Step 8: diagnostic dumps ──────────────────────────────────────────
        # raw_founder_dump.txt  — original debug file (kept for compatibility)
        # debug_profile_dump.txt — new canonical dump written BEFORE Gemini call
        with open("raw_founder_dump.txt", "w", encoding="utf-8") as f:
            f.write(raw_scraped_text)
        with open("debug_profile_dump.txt", "w", encoding="utf-8") as f:
            f.write(raw_scraped_text)
        logger.info(
            "Debug dumps written — raw_founder_dump.txt & debug_profile_dump.txt "
            "(%d chars).", len(raw_scraped_text)
        )

        # ── Step 9: per-section extraction summary (aids debugging) ───────────
        logger.info(
            "Section extraction summary — "
            "intro_about=%d chars | experience=%d chars | "
            "education=%d chars | skills=%d chars",
            len(intro_about_combined), len(experience_text),
            len(education_text), len(skills_text),
        )

        # ── Step 10: text-density safety guardrail ────────────────────────────
        char_count = len(raw_scraped_text)
        logger.info(
            "Direct sub-page extraction complete — %d characters total, profile: %s",
            char_count, clean_url,
        )

        if char_count < 500:
            logger.warning(
                "Low text density after direct sub-page extraction (%d chars). "
                "Sections present: intro_about=%s exp=%s edu=%s skills=%s. "
                "Check cookies or try again — profile: %s",
                char_count,
                bool(intro_about_combined.strip()), bool(experience_text.strip()),
                bool(education_text.strip()), bool(skills_text.strip()),
                clean_url,
            )
            print(
                f"WARNING: Low text density ({char_count} chars) — "
                f"page may not have loaded correctly — {clean_url}"
            )

        # raw_scraped_text is returned here — Gemini call happens in the caller
        # (pipeline.py → format_profile_insights).  Both debug files above are
        # written immediately before this return, satisfying the requirement.
        return raw_scraped_text if raw_scraped_text.strip() else None

    except Exception as exc:   # noqa: BLE001
        logger.error(
            "scrape_linkedin_profile: failed for '%s': %s", profile_url, exc
        )
        return None

    finally:
        driver.quit()
        logger.debug("WebDriver closed after profile scrape.")



def _detect_login_wall(driver: webdriver.Chrome) -> bool:
    """
    Return True if the browser landed on a LinkedIn login / auth-gate page
    rather than the intended profile or company page.

    Checked signals:
      - URL contains '/login' or '/authwall'
      - Page title contains 'Log In' or 'Sign In'
      - A visible 'Sign in' form/button is present in the DOM
    """
    try:
        current_url = driver.current_url.lower()
        if "/login" in current_url or "/authwall" in current_url:
            logger.critical(
                "LOGIN WALL DETECTED: current URL is '%s'. "
                "Cookies may have expired -- re-run manage_cookies.py.",
                driver.current_url,
            )
            return True

        title = driver.title.lower()
        if "log in" in title or "sign in" in title:
            logger.critical(
                "LOGIN WALL DETECTED: page title is '%s'.", driver.title
            )
            return True

        # Check for a visible sign-in button / form
        signin_indicators = driver.find_elements(
            By.XPATH,
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
            "'abcdefghijklmnopqrstuvwxyz'), 'sign in')]"
            "| //a[contains(translate(@href,'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
            "'abcdefghijklmnopqrstuvwxyz'), '/login')]",
        )
        if signin_indicators:
            logger.critical(
                "LOGIN WALL DETECTED: sign-in element found on page '%s'.",
                driver.current_url,
            )
            return True
    except Exception as exc:  # noqa: BLE001
        logger.debug("_detect_login_wall check error: %s", exc)

    return False


def _expand_profile_sections(driver: webdriver.Chrome) -> None:
    """
    Systematically expand every collapsible section on a LinkedIn profile page
    to reveal the full Experience, Education, and Honors & Awards content.

    Strategy (in order):
      1. Click section-level 'Show all X experiences / educations / honors' links
         (anchor and button variants).
      2. Click all inline 'See more', 'Show more', and 'Show all' buttons/spans
         that expand hidden description text inside individual roles or cards.
      3. Final full-page scroll-to-bottom to flush any remaining lazy sections.

    Each click is followed by a mandatory 1-second DOM-render wait so that the
    newly injected paragraphs and bullet points are present before text capture.
    """
    # -- Phase 1: section-level 'Show all …' links/buttons --------------------
    # Targets:
    #   "Show all experiences"  /  "Show all N experiences"
    #   "Show all education"    /  "Show all N educations"
    #   "Show all honors"       /  "Show all N honors & awards"
    #   Generic "Show all" on buttons (Skills, Projects, Publications, etc.)
    section_xpaths = [
        # Anchor tags: 'show all … experience'
        "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all') and "
        "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'experience')]",
        # Anchor tags: 'show all … education'
        "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all') and "
        "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'education')]",
        # Anchor tags: 'show all … honor'
        "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all') and "
        "contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'honor')]",
        # Button text: 'Show all experiences'
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all experiences')]",
        # Button text: 'Show all education'
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all education')]",
        # Span text: 'Show all experiences' → click parent button
        "//span[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all experiences')]/ancestor::button",
        # Span text: 'Show all education' → click parent button
        "//span[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all education')]/ancestor::button",
        # Generic 'Show all' buttons (Skills, Projects, Certifications, etc.)
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all')]",
        # Generic 'Show all' spans → parent button
        "//span[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show all')]/ancestor::button",
    ]

    clicked_section = 0
    for xpath in section_xpaths:
        try:
            elements = driver.find_elements(By.XPATH, xpath)
            for el in elements[:5]:  # at most 5 per pattern to be safe
                try:
                    driver.execute_script(
                        "arguments[0].scrollIntoView({block:'center'});", el
                    )
                    time.sleep(0.4)
                    driver.execute_script("arguments[0].click();", el)
                    time.sleep(1.0)  # mandatory 1-second wait for DOM to render
                    clicked_section += 1
                    logger.debug(
                        "_expand_profile_sections [section]: clicked element matched '%s'.",
                        xpath[:80],
                    )
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

    logger.debug(
        "_expand_profile_sections: %d section-level expand element(s) clicked.",
        clicked_section,
    )

    # -- Phase 2: inline 'See more' / 'Show more' expanders -------------------
    # Targets:
    #   "See more"  buttons (inline role/education description truncation)
    #   "Show more" buttons (aria-label variant)
    #   LinkedIn's own class-based expander (.inline-show-more-text)
    inline_xpaths = [
        # Button with visible text 'See more'
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'see more')]",
        # Span with text 'See more' → click parent button
        "//span[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'see more')]/ancestor::button",
        # Button with aria-label containing 'show more'
        "//button[@aria-label and contains("
        "translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ',"
        "'abcdefghijklmnopqrstuvwxyz'), 'show more')]",
        # LinkedIn class-based inline expander (experience descriptions)
        "//button[contains(@class,'inline-show-more-text')]",
    ]

    clicked_inline = 0
    for xpath in inline_xpaths:
        try:
            buttons = driver.find_elements(By.XPATH, xpath)
            for btn in buttons[:20]:  # raised cap: expand every occurrence on the page
                try:
                    driver.execute_script(
                        "arguments[0].scrollIntoView({block:'center'});", btn
                    )
                    time.sleep(0.3)
                    driver.execute_script("arguments[0].click();", btn)
                    time.sleep(1.0)  # mandatory 1-second wait for hidden text to render
                    clicked_inline += 1
                    logger.debug(
                        "_expand_profile_sections [inline]: clicked element matched '%s'.",
                        xpath[:80],
                    )
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

    if clicked_inline:
        logger.debug(
            "_expand_profile_sections: %d inline expand button(s) clicked.",
            clicked_inline,
        )
        time.sleep(random.uniform(1.0, 2.0))  # let DOM fully settle after batch

    # -- Phase 3: scroll back to top so section XPaths match from a clean
    #    viewport position.  We deliberately do NOT scroll to the page bottom
    #    here — that triggers LinkedIn's infinite Activity feed via XHR,
    #    which pollutes the DOM and causes _extract_section_text to capture
    #    Activity content instead of the intended profile sections.
    try:
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(0.5)
    except Exception:  # noqa: BLE001
        pass

    total = clicked_section + clicked_inline
    logger.info(
        "_expand_profile_sections: total %d element(s) expanded "
        "(%d section-level 'Show all', %d inline 'See more' / 'Show more').",
        total, clicked_section, clicked_inline,
    )
