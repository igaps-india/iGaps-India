import logging
from scraper import scrape_google_for_linkedin_url

logger = logging.getLogger(__name__)

def find_company_linkedin(company_name: str, industry: str | None = None) -> str | None:
    """
    Uses Selenium to search Google for the official LinkedIn company page.
    Optionally accepts an industry (e.g. "ed tech") to improve search accuracy.
    """
    try:
        clean_url = scrape_google_for_linkedin_url(company_name, industry)
        if clean_url:
            logger.info("Found LinkedIn URL for '%s': %s", company_name, clean_url)
            return clean_url
                
        logger.info("Could not find a LinkedIn company URL for '%s'", company_name)
        return None
        
    except Exception as exc:
        logger.error("Error searching for LinkedIn URL for '%s': %s", company_name, exc)
        return None
