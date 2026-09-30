-- 009: "Where visitors came from" records one visit per browser session (the
-- landing page view). The beacon checks for an existing row by session first.
CREATE INDEX IF NOT EXISTS idx_visits_business_session ON store_visits(business_id, session_id) WHERE session_id IS NOT NULL;
