ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_visibility_check'
      AND conrelid = 'public.agents'::regclass
  ) THEN
    ALTER TABLE public.agents
      ADD CONSTRAINT agents_visibility_check
      CHECK (visibility IN ('public', 'private', 'followers'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agents_visibility ON public.agents(visibility);
CREATE INDEX IF NOT EXISTS idx_agents_deleted_at ON public.agents(deleted_at);
CREATE INDEX IF NOT EXISTS idx_agents_user_visibility ON public.agents(user_id, visibility);
