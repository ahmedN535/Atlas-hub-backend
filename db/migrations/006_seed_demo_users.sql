-- Seed demo-switcher users in public.users without touching auth users or profiles.

INSERT INTO public.users (username, email, display_name, bio)
VALUES
  ('ada', 'ada@demo.local', 'Ada', ''),
  ('grace', 'grace@demo.local', 'Grace', ''),
  ('alan', 'alan@demo.local', 'Alan', '')
ON CONFLICT (username) DO UPDATE SET
  email = EXCLUDED.email,
  display_name = COALESCE(NULLIF(public.users.display_name, ''), EXCLUDED.display_name),
  bio = COALESCE(public.users.bio, EXCLUDED.bio);
