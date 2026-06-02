from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import os
import sys
import logging
from dotenv import load_dotenv

# Load the backend's .env file so the microservice shares the same API keys
backend_env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
load_dotenv(backend_env_path)

# Add the 'scrapers' directory to the Python path so the existing scripts can find each other
scrapers_dir = os.path.join(os.path.dirname(__file__), "scrapers")
sys.path.append(scrapers_dir)

# Ensure the LinkedIn scraper looks for the cookie file exactly where it was generated
os.environ["COOKIES_PATH"] = os.path.join(scrapers_dir, "linkedin_cookies.pkl")

from google_pipeline import run_google_pipeline
from linkedin_pipeline import run_pipeline as run_linkedin_pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="iGaps Scraper Microservice")

class GoogleScrapeRequest(BaseModel):
    company_name: str
    founder_name: str

class LinkedinScrapeRequest(BaseModel):
    company_name: str
    founder_name: str
    linkedin_url: Optional[str] = None
    founder_linkedin_url: Optional[str] = None
    website_url: Optional[str] = None

@app.post("/scrape/google")
async def scrape_google(request: GoogleScrapeRequest):
    try:
        results = run_google_pipeline(
            company_name=request.company_name,
            founder_name=request.founder_name
        )
        return results
    except Exception as e:
        logger.error(f"Google scrape failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scrape/linkedin")
async def scrape_linkedin(request: LinkedinScrapeRequest):
    try:
        results = run_linkedin_pipeline(
            company_name=request.company_name,
            website_url=request.website_url,
            founder_name=request.founder_name,
            founder_email=None,
            linkedin_url=request.linkedin_url,
            founder_linkedin_url=request.founder_linkedin_url,
            dry_run=True  # Skips DB save in pipeline.py
        )
        return results
    except Exception as e:
        logger.error(f"LinkedIn scrape failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
