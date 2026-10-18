import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalCloudflareEnv,
  LocalD1Database,
  LocalDurableObjectNamespace,
  LocalR2Bucket,
} from '../../apps/worker/src/cloudflare-emulator';
import { createAgoraWorkerApp } from '../../apps/worker/src/index';

describe('Cloudflare Local Emulation Integration Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-emulate-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('LocalD1Database supports prepared statements, schema.sql tables, and disk persistence across restarts', async () => {
    const dbPath = path.join(tmpDir, 'd1.sqlite');
    const d1 = new LocalD1Database(dbPath);
    const now = new Date().toISOString();

    await d1
      .prepare(
        `INSERT INTO presentations (id, title, revision, status, ending_slide_id, branding_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('pres_1', 'Alpha Keynote', 'rev_1', 'published', 'slide_end', '{}', now, now)
      .run();

    const row = await d1
      .prepare('SELECT id, title, revision FROM presentations WHERE id = ?')
      .bind('pres_1')
      .first<{ id: string; title: string; revision: string }>();
    expect(row).toEqual({ id: 'pres_1', title: 'Alpha Keynote', revision: 'rev_1' });

    await d1.batch([
      d1
        .prepare(
          `INSERT INTO slides (id, presentation_id, title, horizontal_index, vertical_index, slide_order, is_qa_slide)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('slide_1', 'pres_1', 'Intro', 0, 0, 0, 0),
      d1
        .prepare(
          `INSERT INTO slides (id, presentation_id, title, horizontal_index, vertical_index, slide_order, is_qa_slide)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('slide_end', 'pres_1', 'Thank You', 1, 0, 1, 0),
    ]);

    const allSlides = await d1
      .prepare('SELECT id, title FROM slides WHERE presentation_id = ? ORDER BY slide_order ASC')
      .bind('pres_1')
      .all<{ id: string; title: string }>();
    expect(allSlides.results).toHaveLength(2);

    d1.close();

    // Reopen from disk and verify persisted D1 SQLite state
    const d1Reopened = new LocalD1Database(dbPath);
    const persisted = await d1Reopened
      .prepare('SELECT id, title FROM presentations WHERE id = ?')
      .bind('pres_1')
      .first<{ id: string; title: string }>();
    expect(persisted).toEqual({ id: 'pres_1', title: 'Alpha Keynote' });
    d1Reopened.close();
  });

  it('LocalR2Bucket supports binary PNG/PDF ops and disk persistence across restarts', async () => {
    const r2 = new LocalR2Bucket(tmpDir);

    const pngMagic = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await r2.put('slides/slide1.png', pngMagic, {
      httpMetadata: { contentType: 'image/png' },
    });

    // Re-instantiate LocalR2Bucket against the same directory to verify disk persistence
    const r2Reopened = new LocalR2Bucket(tmpDir);
    const obj = await r2Reopened.get('slides/slide1.png');
    expect(obj).not.toBeNull();
    expect(obj?.httpMetadata?.contentType).toBe('image/png');
    const bytes = await obj!.bytes();
    expect(bytes).toEqual(pngMagic);

    const headObj = await r2Reopened.head('slides/slide1.png');
    expect(headObj?.size).toBe(pngMagic.length);

    const listed = await r2Reopened.list({ prefix: 'slides/' });
    expect(listed.objects).toHaveLength(1);

    await r2Reopened.delete('slides/slide1.png');
    expect(await r2Reopened.get('slides/slide1.png')).toBeNull();
  });

  it('LocalDurableObjectNamespace supports embedded SQLite ctx.storage.sql, unique constraints, and WebSocket hibernation', () => {
    const doNs = new LocalDurableObjectNamespace(tmpDir);
    const doId = doNs.idFromName('session-room-1');
    const state = doNs.getState(doId);
    const now = new Date().toISOString();

    state.storage.sql.exec(
      `INSERT INTO questions (id, session_id, slide_id, participant_id, content, status, upvotes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'q1',
      'session-room-1',
      'slide_1',
      'part_1',
      'What is local DO SQLite emulation?',
      'pending',
      1,
      now,
    );

    state.storage.sql.exec(
      `INSERT INTO question_upvotes (question_id, participant_id, session_id, created_at)
       VALUES (?, ?, ?, ?)`,
      'q1',
      'part_1',
      'session-room-1',
      now,
    );

    // Duplicate upvote by same participant must violate UNIQUE(question_id, participant_id)
    expect(() => {
      state.storage.sql.exec(
        `INSERT INTO question_upvotes (question_id, participant_id, session_id, created_at)
         VALUES (?, ?, ?, ?)`,
        'q1',
        'part_1',
        'session-room-1',
        now,
      );
    }).toThrow();

    const rows = state.storage.sql
      .exec<{ id: string; content: string }>('SELECT id, content FROM questions WHERE id = ?', 'q1')
      .toArray();
    expect(rows).toEqual([{ id: 'q1', content: 'What is local DO SQLite emulation?' }]);

    const fakeWs = { send: () => {}, close: () => {} } as unknown as WebSocket;
    state.acceptWebSocket(fakeWs, ['attendee']);
    expect(state.getWebSockets('attendee')).toContain(fakeWs);

    doNs.closeAll();
  });

  it('createLocalCloudflareEnv wires DB, ASSETS_BUCKET, and SESSION_COORDINATOR with createAgoraWorkerApp (SPEC-001a, SPEC-001b, SPEC-017)', async () => {
    const env = createLocalCloudflareEnv({ persistDir: tmpDir, adminToken: 'local-secret' });
    const app = createAgoraWorkerApp({ adminToken: env.ADMIN_TOKEN });
    const headers = {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Runtime validation rejects empty title with 400
    const badRes = await app.fetch(
      new Request('http://localhost/api/v1/presentations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: '   ' }),
      }),
      env,
    );
    expect(badRes.status).toBe(400);

    const createRes = await app.fetch(
      new Request('http://localhost/api/v1/presentations', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Cloudflare Emulated Presentation',
          endingSlideId: 's2',
          branding: { colors: { primary: '#f6821f' } },
          slides: [
            {
              id: 's1',
              presentationId: 'p',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 's2',
              presentationId: 'p',
              title: 'End',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
          ],
        }),
      }),
      env,
    );

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      revision: string;
      revisionHash: string;
    };
    expect(created.revision).toBe('rev-1');
    expect(created.revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Verify slide_metadata view in D1 SQLite (SPEC-001b)
    const d1Slides = await env.DB.prepare(
      'SELECT id, title, "order" FROM slide_metadata WHERE presentation_id = ? ORDER BY "order" ASC',
    )
      .bind(created.id)
      .all<{ id: string; title: string; order: number }>();
    expect(d1Slides.results).toEqual([
      { id: 's1', title: 'Intro', order: 0 },
      { id: 's2', title: 'End', order: 1 },
    ]);

    // Upload PNG asset to R2 & D1 manifest for rev-1
    const assetRes = await app.fetch(
      new Request(`http://localhost/api/v1/presentations/${created.id}/assets?slideId=s1`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'slide-png',
          slideId: 's1',
          revision: 'rev-1',
          base64: btoa('png-bytes'),
        }),
      }),
      env,
    );
    expect(assetRes.status).toBe(201);
    const uploadedAsset = (await assetRes.json()) as { r2Key: string };
    expect(await env.ASSETS_BUCKET.head(uploadedAsset.r2Key)).not.toBeNull();

    // Update via PUT /api/v1/presentations/:id -> bumps revision, changes revisionHash, and purges stale R2/D1 assets
    const putRes = await app.fetch(
      new Request(`http://localhost/api/v1/presentations/${created.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          title: 'Cloudflare Emulated Presentation v2',
        }),
      }),
      env,
    );
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as { revision: string; revisionHash: string };
    expect(updated.revision).toBe('rev-2');
    expect(updated.revisionHash).not.toBe(created.revisionHash);

    // Stale R2 object was purged on revision change
    expect(await env.ASSETS_BUCKET.head(uploadedAsset.r2Key)).toBeNull();

    // Uploading an asset with stale revision rev-1 returns 409 Conflict
    const staleUploadRes = await app.fetch(
      new Request(`http://localhost/api/v1/presentations/${created.id}/assets?slideId=s1`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'slide-png',
          slideId: 's1',
          revision: 'rev-1',
          base64: btoa('stale-png'),
        }),
      }),
      env,
    );
    expect(staleUploadRes.status).toBe(409);

    // Duplicate presentation (SPEC-017) persists in D1 and isolates mutations
    const dupRes = await app.fetch(
      new Request(`http://localhost/api/v1/presentations/${created.id}/duplicate`, {
        method: 'POST',
        headers,
      }),
      env,
    );
    expect(dupRes.status).toBe(201);
    const duplicated = (await dupRes.json()) as { id: string; title: string; revisionHash: string };
    expect(duplicated.id).not.toBe(created.id);

    // Simulate Worker restart with fresh app instance reading from persisted D1
    const restartedApp = createAgoraWorkerApp({ adminToken: env.ADMIN_TOKEN });
    const getHydratedRes = await restartedApp.fetch(
      new Request(`http://localhost/api/v1/presentations/${duplicated.id}`),
      env,
    );
    expect(getHydratedRes.status).toBe(200);
    const hydrated = (await getHydratedRes.json()) as {
      id: string;
      revisionStatus: { isCurrent: boolean; revisionHash: string };
    };
    expect(hydrated.id).toBe(duplicated.id);
    expect(hydrated.revisionStatus.isCurrent).toBe(true);
    expect(hydrated.revisionStatus.revisionHash).toBe(duplicated.revisionHash);

    env.close();
  });

  it('SPEC-002: persists live session lifecycle (scheduled -> live -> completed), participants, and WebSocket reconnect restoration in Durable Object SQLite', async () => {
    const env = createLocalCloudflareEnv({ persistDir: tmpDir, adminToken: 'local-secret' });
    const app = createAgoraWorkerApp({ adminToken: env.ADMIN_TOKEN });
    const adminHeaders = {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Create presentation in D1
    const presRes = await app.fetch(
      new Request('http://localhost/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Live DO Session Deck',
          endingSlideId: 's2',
          slides: [
            {
              id: 's1',
              presentationId: 'p',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 's2',
              presentationId: 'p',
              title: 'Ending',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
          ],
        }),
      }),
      env,
    );
    const pres = (await presRes.json()) as { id: string };

    // 2. Create session in 'scheduled' state
    const schedRes = await app.fetch(
      new Request(`http://localhost/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ status: 'scheduled' }),
      }),
      env,
    );
    expect(schedRes.status).toBe(201);
    const scheduled = (await schedRes.json()) as {
      id: string;
      status: string;
      presenterToken: string;
      currentSlideId: string | null;
      audienceUrl: string;
      qrCodeDataUrl: string;
    };
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.currentSlideId).toBeNull();
    expect(scheduled.audienceUrl).toContain(scheduled.id);
    expect(scheduled.qrCodeDataUrl).toContain('data:image/svg+xml');

    // 3. Transition scheduled -> live via POST /api/v1/sessions/:id/start
    const startRes = await app.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${scheduled.presenterToken}` },
      }),
      env,
    );
    expect(startRes.status).toBe(200);
    const liveSession = (await startRes.json()) as {
      status: string;
      currentSlideId: string;
      revealedSlideIds: string[];
    };
    expect(liveSession.status).toBe('live');
    expect(liveSession.currentSlideId).toBe('s1');
    expect(liveSession.revealedSlideIds).toEqual(['s1']);

    // 4. Attendee joins and Presenter navigates to ending slide s2
    const joinRes = await app.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Dana' }),
      }),
      env,
    );
    expect(joinRes.status).toBe(201);
    const participant = (await joinRes.json()) as { id: string; token: string };

    const navRes = await app.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/slide`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scheduled.presenterToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slideId: 's2' }),
      }),
      env,
    );
    expect(navRes.status).toBe(200);

    // 5. Simulate Worker restart with fresh in-memory store reading from persisted DO SQLite
    const restartedApp = createAgoraWorkerApp({ adminToken: env.ADMIN_TOKEN });
    const viewRes = await restartedApp.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}`),
      env,
    );
    expect(viewRes.status).toBe(200);
    const hydratedView = (await viewRes.json()) as {
      session: {
        status: string;
        currentSlideId: string;
        revealedSlideIds: string[];
        pdfDownloadUnlocked: boolean;
        connectedParticipants: number;
      };
    };
    expect(hydratedView.session.status).toBe('live');
    expect(hydratedView.session.currentSlideId).toBe('s2');
    expect(hydratedView.session.revealedSlideIds).toEqual(['s1', 's2']);
    expect(hydratedView.session.pdfDownloadUnlocked).toBe(true);
    expect(hydratedView.session.connectedParticipants).toBe(1);

    // 6. WebSocket reconnection immediately restores authoritative session.state snapshot
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as unknown as WebSocket;
    restartedApp.getCoordinator(scheduled.id).handleConnection(mockWs, 'http://localhost');
    expect(sentMessages).toHaveLength(1);
    const restoredEvent = JSON.parse(sentMessages[0]!) as {
      type: string;
      payload: { currentSlideId: string; revealedSlideIds: string[]; pdfDownloadUnlocked: boolean };
    };
    expect(restoredEvent.type).toBe('session.state');
    expect(restoredEvent.payload.currentSlideId).toBe('s2');
    expect(restoredEvent.payload.revealedSlideIds).toEqual(['s1', 's2']);
    expect(restoredEvent.payload.pdfDownloadUnlocked).toBe(true);

    // 7. Hydrated participant token still works after restart, and presenter can complete session
    const qRes = await restartedApp.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/questions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${participant.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slideId: 's2', content: 'Persisted participant question?' }),
      }),
      env,
    );
    expect(qRes.status).toBe(201);

    const completeRes = await restartedApp.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${scheduled.presenterToken}` },
      }),
      env,
    );
    expect(completeRes.status).toBe(200);
    const completed = (await completeRes.json()) as { status: string; completedAt: string };
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeDefined();

    // Joining a completed session is rejected
    const lateJoin = await restartedApp.fetch(
      new Request(`http://localhost/api/v1/sessions/${scheduled.id}/join`, {
        method: 'POST',
      }),
      env,
    );
    expect(lateJoin.status).toBe(400);

    // 8. Verify OpenAPI 3.1.0 specification and interactive docs endpoints
    const openApiRes = await restartedApp.fetch(
      new Request('http://localhost/api/v1/openapi.json'),
      env,
    );
    expect(openApiRes.status).toBe(200);
    const openApiDoc = (await openApiRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(openApiDoc.openapi).toBe('3.1.0');
    expect(openApiDoc.paths['/api/v1/presentations/{id}/sessions']).toBeDefined();
    expect(openApiDoc.paths['/api/v1/sessions/{id}/start']).toBeDefined();

    const docsRes = await restartedApp.fetch(new Request('http://localhost/api/v1/docs'), env);
    expect(docsRes.status).toBe(200);
    expect(await docsRes.text()).toContain('/api/v1/openapi.json');

    env.close();
  });
});
