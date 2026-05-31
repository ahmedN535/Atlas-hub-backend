CREATE TABLE IF NOT EXISTS public.agent_reviews (
  id BIGSERIAL PRIMARY KEY,

  agent_id INTEGER NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  rating_x2 SMALLINT NOT NULL,

  title TEXT DEFAULT '',
  experience TEXT NOT NULL,
  downsides TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_reviews_agent_id
ON public.agent_reviews(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_reviews_user_id
ON public.agent_reviews(user_id);

ALTER TABLE public.agent_reviews
DROP CONSTRAINT IF EXISTS agent_reviews_rating_x2_check;

ALTER TABLE public.agent_reviews
DROP CONSTRAINT IF EXISTS agent_reviews_rating_x2_whole_stars_check;

ALTER TABLE public.agent_reviews
ADD CONSTRAINT agent_reviews_rating_x2_whole_stars_check
CHECK (rating_x2 IN (2, 4, 6, 8, 10));

ALTER TABLE public.agent_reviews
DROP CONSTRAINT IF EXISTS agent_reviews_written_feedback_check;

ALTER TABLE public.agent_reviews
ADD CONSTRAINT agent_reviews_written_feedback_check
CHECK (
  length(trim(experience)) >= 10
  AND length(trim(downsides)) >= 5
);