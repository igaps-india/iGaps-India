from contextlib import asynccontextmanager
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
from VectorSimilarityScorer import score_with_vector_similarity, get_anchor_cache

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ── Lifespan: warm-up the vector model at startup ─────────────────────────────
# This pre-loads the 22MB model and pre-computes all anchor embeddings
# so the first real scoring request is fast (no cold-start delay).
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("[Startup] Pre-warming VectorSimilarityScorer model and anchor embeddings...")
    try:
        get_anchor_cache()  # Pre-compute all embeddings at startup
        logger.info("[Startup] VectorSimilarityScorer ready.")
    except Exception as e:
        logger.warning(f"[Startup] VectorSimilarityScorer warm-up failed (non-fatal): {e}")
    yield  # App runs here
    logger.info("[Shutdown] Microservice shutting down.")


app = FastAPI(title="iGaps Scraper Microservice", lifespan=lifespan)


# ── Request / Response Models ─────────────────────────────────────────────────

class GoogleScrapeRequest(BaseModel):
    company_name: str
    founder_name: str

class LinkedinScrapeRequest(BaseModel):
    company_name: str
    founder_name: str
    cofounder_names: Optional[list[str]] = None
    linkedin_url: Optional[str] = None
    founder_linkedin_url: Optional[str] = None
    website_url: Optional[str] = None

class VectorScoreRequest(BaseModel):
    signal_key: str    # e.g. "openQ4_persona_vividity_score"
    answer_text: str   # The founder's raw answer text


# ── Routes ────────────────────────────────────────────────────────────────────

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
            cofounder_names=request.cofounder_names,
            founder_email=None,
            linkedin_url=request.linkedin_url,
            founder_linkedin_url=request.founder_linkedin_url,
            dry_run=True  # Skips DB save in pipeline.py
        )
        return results
    except Exception as e:
        logger.error(f"LinkedIn scrape failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/score/vector")
async def score_vector(request: VectorScoreRequest):
    """
    Score a founder's answer using local vector similarity.
    No external API. Returns a 0–100 score in < 10ms after warm-up.

    Supported signal_key values:
      - openQ4_persona_vividity_score
      - openQ4_problem_customer_language_score
      - openQ7_solution_persona_fit_score
      - openQ3_leverage_specificity_score
      - openQ10_customer_initiated_score
      - openQ5_problem_severity_score
    """
    try:
        result = score_with_vector_similarity(
            signal_key=request.signal_key,
            answer_text=request.answer_text,
        )
        return result
    except Exception as e:
        logger.error(f"Vector scoring failed for signal '{request.signal_key}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "ok", "vector_scorer_ready": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
