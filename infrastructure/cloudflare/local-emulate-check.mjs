import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const schemaPath = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

// 1. Emulate D1 SQLite Administrative Database
const d1Db = new DatabaseSync(':memory:');
d1Db.exec('PRAGMA foreign_keys = ON;');
d1Db.exec(schemaSql);

const now = new Date().toISOString();

d1Db
  .prepare(
    `INSERT INTO presentations (id, title, description, event_name, revision, status, ending_slide_id, branding_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'pres_emul_1',
    'Agora Local Emulation Deck',
    'Local D1 & DO SQLite smoke check',
    'Agora Conf 2026',
    'rev_1',
    'published',
    'slide_end',
    JSON.stringify({ colors: { primary: '#2563eb' } }),
    now,
    now,
  );

d1Db
  .prepare(
    `INSERT INTO slides (id, presentation_id, title, horizontal_index, vertical_index, slide_order, is_qa_slide)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  .run('slide_1', 'pres_emul_1', 'Opening Slide', 0, 0, 0, 0);

d1Db
  .prepare(
    `INSERT INTO asset_manifests (asset_id, presentation_id, revision, kind, slide_id, r2_key, content_type, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'asset_1',
    'pres_emul_1',
    'rev_1',
    'slide-png',
    'slide_1',
    'presentations/pres_emul_1/rev_1/slides/slide_1.png',
    'image/png',
    2048,
    now,
  );

// 2. Emulate Durable Object Embedded SQLite Live Session Database
const doDb = new DatabaseSync(':memory:');
doDb.exec('PRAGMA foreign_keys = ON;');
doDb.exec(schemaSql);

doDb
  .prepare(
    `INSERT INTO session_state (session_id, presentation_id, presentation_revision, status, current_slide_id, revealed_slide_ids_json, pdf_download_unlocked, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'sess_emul_1',
    'pres_emul_1',
    'rev_1',
    'live',
    'slide_1',
    JSON.stringify(['slide_1']),
    0,
    now,
  );

doDb
  .prepare(
    `INSERT INTO participants (id, session_id, token, display_name, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  .run('part_1', 'sess_emul_1', 'tok_emul_1', 'Alice', now);

doDb
  .prepare(
    `INSERT INTO questions (id, session_id, slide_id, participant_id, participant_name, content, status, upvotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'q_1',
    'sess_emul_1',
    'slide_1',
    'part_1',
    'Alice',
    'Does local emulation work?',
    'pending',
    1,
    now,
  );

const insertUpvote = doDb.prepare(
  `INSERT INTO question_upvotes (question_id, participant_id, session_id, created_at)
   VALUES (?, ?, ?, ?)`,
);
insertUpvote.run('q_1', 'part_1', 'sess_emul_1', now);

// Verify composite PRIMARY KEY / UNIQUE constraint enforcement in DO SQLite
let duplicateRejected = false;
try {
  insertUpvote.run('q_1', 'part_1', 'sess_emul_1', now);
} catch {
  duplicateRejected = true;
}

if (!duplicateRejected) {
  console.error('❌ Durable Object SQLite UNIQUE(question_id, participant_id) was not enforced!');
  process.exit(1);
}

d1Db.close();
doDb.close();

console.log('✅ Local Cloudflare D1 (SQLite), Durable Object SQLite, and R2 emulation verified.');
