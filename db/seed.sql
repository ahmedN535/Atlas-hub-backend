INSERT INTO users (username, email, display_name, bio) VALUES
  ('ada', 'ada@example.com', 'Ada Lovelace', 'Builds practical AI workflows.'),
  ('grace', 'grace@example.com', 'Grace Hopper', 'Enjoys developer tools and automation.'),
  ('alan', 'alan@example.com', 'Alan Turing', 'Explores reasoning agents.');

INSERT INTO agents (user_id, name, description, category, model) VALUES
  (1, 'Research Buddy', 'Summarizes articles and pulls out key questions for deeper research.', 'research', 'gpt-4o-mini'),
  (1, 'Meeting Notes Helper', 'Turns rough meeting notes into clear action items.', 'productivity', 'gpt-4o-mini'),
  (2, 'Code Review Assistant', 'Checks small pull requests for bugs, readability, and missing tests.', 'developer-tools', 'gpt-4o'),
  (3, 'Logic Tutor', 'Explains logic puzzles step by step for beginners.', 'education', 'gpt-4o-mini');

INSERT INTO reviews (user_id, agent_id, rating, comment) VALUES
  (2, 1, 5, 'Very useful for preparing project briefs.'),
  (3, 1, 4, 'Good summaries, especially for long articles.'),
  (1, 3, 5, 'Helpful review notes without being noisy.'),
  (2, 4, 4, 'Clear explanations for beginner-friendly practice.');
