-- ============================================================================
-- D1 Administrative Persistence Schema (Migration 0001)
-- presentations, slides, asset_manifests, navigation_rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS presentations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_name TEXT,
  revision TEXT NOT NULL,
  revision_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  ending_slide_id TEXT NOT NULL,
  branding_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slides (
  id TEXT NOT NULL,
  presentation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  horizontal_index INTEGER NOT NULL,
  vertical_index INTEGER NOT NULL,
  slide_order INTEGER NOT NULL,
  is_qa_slide INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (presentation_id, id),
  FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slides_presentation ON slides (presentation_id);

CREATE VIEW IF NOT EXISTS slide_metadata AS
SELECT
  id,
  presentation_id,
  title,
  horizontal_index,
  vertical_index,
  slide_order AS "order",
  is_qa_slide
FROM slides;

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
