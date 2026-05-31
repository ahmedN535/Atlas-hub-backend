-- Organizations, organization membership, and organization-scoped agent visibility.
-- This migration is intentionally tolerant of the earlier Supabase-auth style
-- organization SQL that may have already been run manually.

CREATE TABLE IF NOT EXISTS public.organizations (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  avatar_url  TEXT DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.organization_members (
  org_id     BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    TEXT   NOT NULL,
  role       TEXT   NOT NULL DEFAULT 'member'
               CHECK (role IN ('owner', 'admin', 'member')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_created_by_fkey;

ALTER TABLE public.organization_members
  DROP CONSTRAINT IF EXISTS organization_members_user_id_fkey;

ALTER TABLE public.organizations
  ALTER COLUMN created_by TYPE TEXT USING created_by::text,
  ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN avatar_url SET DEFAULT '';

ALTER TABLE public.organization_members
  ALTER COLUMN user_id TYPE TEXT USING user_id::text;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_visibility_check;

UPDATE public.agents
SET visibility = 'followers'
WHERE visibility = 'followers_only';

ALTER TABLE public.agents
  ADD CONSTRAINT agents_visibility_check
    CHECK (visibility IN ('public', 'private', 'followers', 'org_only'));

CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON public.organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_org ON public.agents(org_id);

DROP POLICY IF EXISTS "members can view org" ON public.organizations;
DROP POLICY IF EXISTS "owner or admin can update org" ON public.organizations;
DROP POLICY IF EXISTS "members can view members" ON public.organization_members;
DROP POLICY IF EXISTS "owner or admin can add members" ON public.organization_members;
DROP POLICY IF EXISTS "owner or admin can remove members or self leave" ON public.organization_members;
DROP POLICY IF EXISTS "org members can view org_only agents" ON public.agents;

ALTER TABLE public.organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members DISABLE ROW LEVEL SECURITY;
