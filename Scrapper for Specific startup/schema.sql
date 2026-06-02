-- ==============================================================================
-- Full Schema for iGaps Scraper Pipeline (Run this in Supabase SQL Editor)
-- This file contains the complete, consolidated schema with all tables,
-- triggers, indexes, and RLS policies.
-- ==============================================================================

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. TARGET COMPANIES (The Input Queue — fill this table to trigger processing)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.target_companies (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name         TEXT NOT NULL,
    domain               TEXT,
    linkedin_url         TEXT,
    -- Pre-fill founder details here if you know them already
    founder_name         TEXT,
    founder_email        TEXT,
    founder_linkedin_url TEXT,
    -- Metadata extracted during scraping
    industry             TEXT,
    location             TEXT,
    employee_count       TEXT,
    -- Pipeline control
    status               TEXT DEFAULT 'pending',
    error_reason         TEXT,
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now()) NOT NULL
);

-- ==============================================================================
-- 2. FOUNDERS (List of all founders discovered)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.founders (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    startup_id   UUID        NOT NULL REFERENCES public.target_companies(id) ON DELETE CASCADE,
    first_name   TEXT        NOT NULL,
    last_name    TEXT        NOT NULL,
    role         TEXT,
    linkedin_url TEXT,
    email        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_founder_per_company UNIQUE (startup_id, first_name, last_name)
);

CREATE INDEX IF NOT EXISTS idx_founders_startup_id ON public.founders (startup_id);

ALTER TABLE public.founders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.founders;
CREATE POLICY "service_role_all" ON public.founders
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ==============================================================================
-- 3. STARTUP INSIGHTS (Final JSON Output — auto-populated by Gemini pipeline)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.startup_insights (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name   TEXT NOT NULL,
    company_domain TEXT,
    founder_name   TEXT,
    founder_email  TEXT,
    insights       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_startup_insights UNIQUE (company_name, company_domain)
);

-- Auto-update `updated_at` trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_startup_insights_updated_at ON public.startup_insights;
CREATE TRIGGER trg_startup_insights_updated_at
    BEFORE UPDATE ON public.startup_insights
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- Indexes for startup_insights
CREATE INDEX IF NOT EXISTS idx_startup_insights_company_name ON public.startup_insights (company_name);
CREATE INDEX IF NOT EXISTS idx_startup_insights_domain ON public.startup_insights (company_domain);
CREATE INDEX IF NOT EXISTS idx_startup_insights_overview_gin ON public.startup_insights USING GIN (("insights"->'Company_Overview'));

ALTER TABLE public.startup_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all_insights" ON public.startup_insights;
CREATE POLICY "service_role_all_insights" ON public.startup_insights
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ==============================================================================
-- 4. VIEWS (Flat Views for easy reading in Supabase Table Editor)
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_founders_with_company AS
SELECT
    f.id              AS founder_id,
    c.id              AS company_id,
    c.company_name,
    c.linkedin_url    AS company_linkedin_url,
    c.domain          AS company_domain,
    c.status          AS company_status,
    f.first_name,
    f.last_name,
    f.role,
    f.email,
    f.linkedin_url    AS founder_linkedin_url,
    f.created_at
FROM public.founders         f
JOIN public.target_companies c ON c.id = f.startup_id;

CREATE OR REPLACE VIEW public.v_startup_insights_flat AS
SELECT
    id,
    company_name,
    company_domain,
    founder_name,
    founder_email,
    insights->'Company_Overview'->>'industry'       AS industry,
    insights->'Company_Overview'->>'location'       AS location,
    insights->'Company_Overview'->>'employee_count' AS employee_count,
    insights->'Company_Overview'->>'description'    AS description,
    insights->'Company_Overview'->>'founded_year'   AS founded_year,
    jsonb_array_length(COALESCE(insights->'Founder_Insights'->'group1_general'->'education', '[]')) AS founder_education_count,
    jsonb_array_length(COALESCE(insights->'Founder_Insights'->'group2_company_specific'->'domain_skills', '[]')) AS founder_skill_count,
    (insights->'CoFounder_Insights' IS NOT NULL) AS has_cofounder,
    created_at,
    updated_at
FROM public.startup_insights;
