CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  bio TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE TABLE agents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  manual TEXT,

  category VARCHAR(50),
  model VARCHAR(100),

  tools_integrations TEXT DEFAULT '',
  prerequisites TEXT DEFAULT '',
  input_format TEXT DEFAULT '',
  output_format TEXT DEFAULT '',
  use_cases TEXT DEFAULT '',
  example_prompts TEXT DEFAULT '',
  limitations TEXT DEFAULT '',
  when_to_use TEXT DEFAULT '',
  when_not_to_use TEXT DEFAULT '',
  setup_instructions TEXT DEFAULT '',
  expected_users TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}',

  file_name TEXT,
  file_content TEXT,

  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  visibility TEXT NOT NULL DEFAULT 'public',
  deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT agents_visibility_check CHECK (visibility IN ('public', 'private', 'followers'))
);

CREATE TABLE agent_embeddings (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,

  indexed_text TEXT NOT NULL,
  embedding vector(1536),

  embedding_model TEXT NOT NULL DEFAULT 'openai/text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, agent_id)
);

CREATE INDEX idx_agents_user_id ON agents(user_id);
CREATE INDEX idx_agents_category ON agents(category);
CREATE INDEX idx_agents_visibility ON agents(visibility);
CREATE INDEX idx_agents_deleted_at ON agents(deleted_at);
CREATE INDEX idx_agents_user_visibility ON agents(user_id, visibility);
CREATE INDEX idx_follows_follower_id ON follows(follower_id);
CREATE INDEX idx_follows_following_id ON follows(following_id);
CREATE INDEX idx_reviews_agent_id ON reviews(agent_id);

-- IVFFlat is intentionally disabled for the hackathon MVP.
-- With only a few agents, exact vector search is more reliable.
-- CREATE INDEX idx_agent_embeddings_vector
-- ON agent_embeddings
-- USING ivfflat (embedding vector_cosine_ops)
-- WITH (lists = 100);
