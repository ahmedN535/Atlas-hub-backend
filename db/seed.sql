INSERT INTO users (username, email, display_name, bio) VALUES
  ('ada', 'ada@example.com', 'Ada Lovelace', 'Builds practical AI workflows.'),
  ('grace', 'grace@example.com', 'Grace Hopper', 'Enjoys developer tools and automation.'),
  ('alan', 'alan@example.com', 'Alan Turing', 'Explores reasoning agents.');

INSERT INTO agents (user_id, name, description, manual, category, model, file_name, file_content) VALUES
  (
    1,
    'Research Buddy',
    'Summarizes articles and pulls out key questions for deeper research.',
    'Upload an article or paste research notes, then ask for a summary, open questions, and follow-up reading ideas.',
    'research',
    'gpt-4o-mini',
    'research-buddy.md',
    'Prompt: You are a research assistant. Summarize source material, extract claims, and suggest next questions.'
  ),
  (
    1,
    'Meeting Notes Helper',
    'Turns rough meeting notes into clear action items.',
    'Paste meeting notes and ask for decisions, owners, due dates, and unresolved questions.',
    'productivity',
    'gpt-4o-mini',
    'meeting-notes-helper.md',
    'Prompt: Convert messy meeting notes into concise action items grouped by owner.'
  ),
  (
    2,
    'Code Review Assistant',
    'Checks small pull requests for bugs, readability, and missing tests.',
    'Provide a diff and ask for prioritized findings with file references and test gaps.',
    'developer-tools',
    'gpt-4o',
    'code-review-assistant.md',
    'Prompt: Review code changes for correctness, maintainability, regressions, and missing tests.'
  ),
  (
    3,
    'Logic Tutor',
    'Explains logic puzzles step by step for beginners.',
    'Ask for a puzzle walkthrough and request hints before the final answer.',
    'education',
    'gpt-4o-mini',
    'logic-tutor.md',
    'Prompt: Teach logic puzzles with incremental hints and beginner-friendly explanations.'
  );

INSERT INTO reviews (user_id, agent_id, rating, comment) VALUES
  (2, 1, 5, 'Very useful for preparing project briefs.'),
  (3, 1, 4, 'Good summaries, especially for long articles.'),
  (1, 3, 5, 'Helpful review notes without being noisy.'),
  (2, 4, 4, 'Clear explanations for beginner-friendly practice.');
