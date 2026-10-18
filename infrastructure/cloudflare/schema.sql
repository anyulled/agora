-- ============================================================================
-- D1 Administrative Persistence Schema
-- presentations, slides, asset_manifests, navigation_rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS presentations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_name TEXT,
  revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  ending_slide_id TEXT NOT NULL,
  branding_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slides (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  horizontal_index INTEGER NOT NULL,
  vertical_index INTEGER NOT NULL,
  slide_order INTEGER NOT NULL,
  is_qa_slide INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slides_presentation ON slides (presentation_id);

CREATE TABLE IF NOT EXISTS asset_manifests (
  asset_id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  kind TEXT NOT NULL,
  slide_id TEXT,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assets_presentation_revision ON asset_manifests (presentation_id, revision);

CREATE TABLE IF NOT EXISTS navigation_rules (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  source_slide_id TEXT NOT NULL,
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  min_vote_threshold INTEGER NOT NULL DEFAULT 1,
  min_percentage_threshold REAL,
  target_slide_id TEXT NOT NULL,
  target_horizontal_index INTEGER NOT NULL,
  target_vertical_index INTEGER NOT NULL,
  FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nav_rules_presentation ON navigation_rules (presentation_id);

-- ============================================================================
-- Durable Object Embedded SQLite Live Persistence Schema
-- session_state, participants, questions, question_upvotes, reactions,
-- polls, poll_votes, wordcloud_submissions, processed_events
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  presentation_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  current_slide_id TEXT,
  revealed_slide_ids_json TEXT NOT NULL DEFAULT '[]',
  pdf_download_unlocked INTEGER NOT NULL DEFAULT 0,
  audience_url TEXT,
  qr_code_data_url TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  display_name TEXT,
  joined_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants (session_id);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  slide_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_name TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  upvotes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_session_slide ON questions (session_id, slide_id);

CREATE TABLE IF NOT EXISTS question_upvotes (
  question_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (question_id, participant_id),
  UNIQUE (question_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_upvotes_session ON question_upvotes (session_id);

CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  slide_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reactions_session_slide ON reactions (session_id, slide_id);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  slide_id TEXT NOT NULL,
  question TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single',
  options_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  results_revealed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_polls_session_slide ON polls (session_id, slide_id);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, participant_id),
  UNIQUE (poll_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id);

CREATE TABLE IF NOT EXISTS wordcloud_submissions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  slide_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  raw_term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wordclouds_prompt ON wordcloud_submissions (prompt_id);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_events_session ON processed_events (session_id);
