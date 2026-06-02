-- ============================================================
--  Supabase PostgreSQL Schema
--  Pipeline: Startup IP & License Intelligence
--  Copy-paste this entire block into the Supabase SQL Editor
--  and click "Run" to initialise the schema.
-- ============================================================

-- Enable UUID generation (already available in Supabase by default)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Table: startups
-- Stores the core profile of each company run through
-- the pipeline.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.startups (
    id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name  TEXT          NOT NULL,
    website_url   TEXT,
    founder_name  TEXT,
    linkedin_url  TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.startups IS 'Root entity. One row per pipeline execution for a given company.';
COMMENT ON COLUMN public.startups.id           IS 'Auto-generated UUID primary key.';
COMMENT ON COLUMN public.startups.company_name IS 'Legal or operating name of the startup.';
COMMENT ON COLUMN public.startups.website_url  IS 'Official company domain (e.g. igaps.ai).';
COMMENT ON COLUMN public.startups.founder_name IS 'Full name of the primary founder.';
COMMENT ON COLUMN public.startups.linkedin_url IS 'URL to the corporate LinkedIn profile.';
COMMENT ON COLUMN public.startups.created_at   IS 'UTC timestamp when this record was inserted.';

-- ------------------------------------------------------------
-- Table: patents
-- One row per patent result returned by the SerpApi
-- Google Patents engine for the linked startup.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patents (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    startup_id       UUID        NOT NULL
                                 REFERENCES public.startups(id)
                                 ON DELETE CASCADE,
    patent_id        TEXT,                    -- e.g. "US20210012345A1"
    title            TEXT,
    snippet          TEXT,
    link             TEXT,
    publication_date TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.patents IS 'Patent records scraped from Google Patents via SerpApi.';
COMMENT ON COLUMN public.patents.startup_id       IS 'FK → startups.id.';
COMMENT ON COLUMN public.patents.patent_id        IS 'Google Patents document ID (e.g. US20210012345A1).';
COMMENT ON COLUMN public.patents.publication_date IS 'Raw publication date string as returned by the API.';

CREATE INDEX IF NOT EXISTS idx_patents_startup_id ON public.patents(startup_id);

-- ------------------------------------------------------------
-- Table: licenses
-- One row per regulatory / licence signal found via
-- Google Custom Search for the linked startup.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.licenses (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    startup_id   UUID        NOT NULL
                             REFERENCES public.startups(id)
                             ON DELETE CASCADE,
    source_title TEXT,
    source_link  TEXT,
    snippet      TEXT,
    found_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.licenses IS 'Regulatory / licence signals scraped via Google Custom Search.';
COMMENT ON COLUMN public.licenses.startup_id   IS 'FK → startups.id.';
COMMENT ON COLUMN public.licenses.source_title IS 'Page title of the search result.';
COMMENT ON COLUMN public.licenses.source_link  IS 'URL of the search result.';
COMMENT ON COLUMN public.licenses.snippet      IS 'Excerpt / summary returned by the search API.';
COMMENT ON COLUMN public.licenses.found_at     IS 'UTC timestamp when this licence signal was discovered.';

CREATE INDEX IF NOT EXISTS idx_licenses_startup_id ON public.licenses(startup_id);

-- ============================================================
-- Row-Level Security (RLS) — enable and lock down to the
-- service-role key used by the pipeline.
-- Uncomment these blocks if you want RLS enforced.
-- ============================================================
-- ALTER TABLE public.startups ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.patents  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- End of schema
-- ============================================================
