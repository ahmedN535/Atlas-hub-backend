-- Organization groups/subgroups and group-scoped agent visibility.

CREATE TABLE IF NOT EXISTS public.groups (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id  BIGINT NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES public.groups(id) ON DELETE SET NULL;

ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_visibility_check;

UPDATE public.agents
SET visibility = 'followers'
WHERE visibility = 'followers_only';

ALTER TABLE public.agents
  ADD CONSTRAINT agents_visibility_check
    CHECK (visibility IN ('public', 'private', 'followers', 'org_only', 'group_only'));

CREATE INDEX IF NOT EXISTS groups_org_id_idx ON public.groups(org_id);
CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON public.group_members(user_id);
CREATE INDEX IF NOT EXISTS agents_group_id_idx ON public.agents(group_id);
