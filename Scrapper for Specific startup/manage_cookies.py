"""
manage_cookies.py
Standalone VC Data Enrichment Pipeline — LinkedIn Session Capture

PURPOSE:
  This is a ONE-TIME, HUMAN-IN-THE-LOOP script. It opens a visible Chrome
  browser window, navigates to the LinkedIn login page, and waits up to 120
  seconds for YOU to log in manually. Once it detects a successful login
  (by watching the URL), it immediately saves the authenticated session
  cookies to 'linkedin_cookies.pkl'.

  Run this script whenever your session expires and you need to refresh the
  saved cookies before running the main enrichment pipeline.

USAGE:
    python manage_cookies.py

NO CREDENTIALS ARE STORED OR HARDCODED in this script. You type them in the
browser window yourself, exactly as you would on a normal login page.

Output:
  linkedin_cookies.pkl — reusable session cookies for scraper.py.

Environment variables:
  COOKIES_PATH   (optional) — override the output path for the pickle file.
                               Defaults to 'linkedin_cookies.pkl' in cwd.
"""

from __future__ import annotations

import logging
import os
import pickle
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("manage_cookies")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_COOKIES_PATH:  Path = Path(os.environ.get("COOKIES_PATH", "linkedin_cookies.pkl"))
_LOGIN_URL:     str  = "https://www.linkedin.com/login"
_LOGIN_TIMEOUT: int  = 120    # seconds to wait for the human to log in

# URL substrings that indicate a successful LinkedIn login
_SUCCESS_INDICATORS: tuple[str, ...] = (
    "/feed/",
    "/in/",
    "/mynetwork/",
    "/jobs/",
    "/messaging/",
    "#global-nav",
)


# ---------------------------------------------------------------------------
# Driver factory
# ---------------------------------------------------------------------------

def _build_visible_driver() -> webdriver.Chrome:
    """
    Build a standard, fully visible Chrome WebDriver.
    We intentionally do NOT use headless mode — the human needs to see the
    login page and interact with it.
    """
    options = Options()

    # Standard realistic user-agent
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
    options.add_argument("--window-size=1280,800")
    options.add_argument("--start-maximized")
    options.add_argument("--lang=en-US,en;q=0.9")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    service = Service(ChromeDriverManager().install())
    driver  = webdriver.Chrome(service=service, options=options)

    # Mask navigator.webdriver via CDP so LinkedIn doesn't flag the session
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"},
    )

    return driver


# ---------------------------------------------------------------------------
# Login-detection helpers
# ---------------------------------------------------------------------------

def _is_logged_in(current_url: str) -> bool:
    """Return True if *current_url* indicates a successful LinkedIn login."""
    return any(indicator in current_url for indicator in _SUCCESS_INDICATORS)


def _wait_for_login(driver: webdriver.Chrome, timeout: int) -> bool:
    """
    Poll the browser URL every second for up to *timeout* seconds.

    Returns True if login was detected, False if the timeout expired.
    """
    logger.info(
        "Waiting up to %d seconds for you to log in to LinkedIn ...", timeout
    )
    deadline = time.time() + timeout

    while time.time() < deadline:
        current_url: str = driver.current_url
        if _is_logged_in(current_url):
            logger.info("Login detected! Current URL: %s", current_url)
            return True
        time.sleep(1)

    logger.error(
        "Login not detected within %d seconds. Aborting.", timeout
    )
    return False


# ---------------------------------------------------------------------------
# Cookie persistence
# ---------------------------------------------------------------------------

def _save_cookies(driver: webdriver.Chrome, path: Path) -> None:
    """Extract all cookies from *driver* and write them to *path* as a pickle."""
    cookies: list[dict] = driver.get_cookies()

    if not cookies:
        logger.warning("No cookies returned by the browser -- nothing to save.")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        pickle.dump(cookies, fh)

    logger.info(
        "Saved %d cookies to '%s'.", len(cookies), path.resolve()
    )

    # Log cookie names (not values) for transparency / debugging
    names = [c.get("name", "?") for c in cookies]
    logger.debug("Cookie names: %s", names)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def capture_session() -> None:
    """
    Full cookie-capture workflow:
      1. Open Chrome and navigate to the LinkedIn login page.
      2. Wait for the human to log in (up to _LOGIN_TIMEOUT seconds).
      3. Save cookies to disk.
      4. Close the browser.
    """
    logger.info("=" * 60)
    logger.info("LinkedIn Session Capture -- manage_cookies.py")
    logger.info("Output file: %s", _COOKIES_PATH.resolve())
    logger.info("=" * 60)
    logger.info(
        "IMPORTANT: Please log in to LinkedIn in the browser window that\n"
        "           is about to open. Do NOT close it manually.\n"
        "           The script will save your session and close it for you."
    )

    driver = _build_visible_driver()
    try:
        # Navigate to the login page
        logger.info("Opening LinkedIn login page ...")
        driver.get(_LOGIN_URL)

        # Give the page a moment to render before we start polling
        time.sleep(2)

        # Wait for the human to complete the login flow
        login_successful = _wait_for_login(driver, timeout=_LOGIN_TIMEOUT)

        if not login_successful:
            logger.error(
                "Session NOT saved. Re-run this script and log in within "
                "%d seconds.", _LOGIN_TIMEOUT
            )
            sys.exit(1)

        # Small buffer to let any post-login redirects settle
        logger.info("Login confirmed -- waiting 3 seconds for page to settle ...")
        time.sleep(3)

        # Extract and persist cookies
        _save_cookies(driver, _COOKIES_PATH)

        logger.info("")
        logger.info("Session capture complete!")
        logger.info("    You can now run:  python main.py")

    except KeyboardInterrupt:
        logger.warning("Interrupted by user -- session NOT saved.")
        sys.exit(1)

    except Exception as exc:                    # noqa: BLE001
        logger.error("Unexpected error during session capture: %s", exc, exc_info=True)
        sys.exit(1)

    finally:
        logger.info("Closing browser ...")
        driver.quit()


if __name__ == "__main__":
    capture_session()
