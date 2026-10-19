import type {
  AudienceQuestion,
  ParticipantIdentity,
  PollDefinition,
  Presentation,
  PresentationSession,
} from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgoraWorkerApp } from '../../apps/worker/src/index';

describe('Security & Abuse Prevention Integration Tests (SPEC-018)', () => {
  const adminSecret = 'agora-admin-secure-token';
  let app: ReturnType<typeof createAgoraWorkerApp>;
  let presentation: Presentation;
  let session: PresentationSession & { presenterToken: string };
  let attendee: ParticipantIdentity;

  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminSecret}`,
  };

  beforeEach(async () => {
    app = createAgoraWorkerApp({
      adminToken: adminSecret,
      maxQuestionsPerWindow: 2,
      maxReactionsPerWindow: 3,
      rateWindowMs: 5000,
    });

    // Create presentation
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Security Hardened Presentation',
          endingSlideId: 'slide-last',
          slides: [
            {
              id: 'slide-1',
              presentationId: 'pres-sec',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-2-secret',
              presentationId: 'pres-sec',
              title: 'Secret Upcoming Slide',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 'slide-last',
              presentationId: 'pres-sec',
              title: 'Ending Slide',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    presentation = (await presRes.json()) as Presentation;

    // Upload assets
    await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/presentations/${presentation.id}/assets?slideId=slide-1`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            kind: 'slide-png',
            slideId: 'slide-1',
            revision: presentation.revision,
            base64: btoa('png-slide-1'),
          }),
        },
      ),
    );

    await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/presentations/${presentation.id}/assets?slideId=slide-2-secret`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            kind: 'slide-png',
            slideId: 'slide-2-secret',
            revision: presentation.revision,
            base64: btoa('png-slide-2'),
          }),
        },
      ),
    );

    await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${presentation.id}/assets`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          kind: 'deck-pdf',
          revision: presentation.revision,
          base64: btoa('pdf-content'),
        }),
      }),
    );

    // Create session
    const sessionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${presentation.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    session = (await sessionRes.json()) as PresentationSession & {
      presenterToken: string;
    };

    // Attendee joins
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Mallory' }),
      }),
    );
    attendee = (await joinRes.json()) as ParticipantIdentity;
  });

  it('enforces admin authentication on privileged routes', async () => {
    // Attempt presentation creation without token
    const unauthCreate = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hacked Presentation' }),
      }),
    );
    expect(unauthCreate.status).toBe(401);

    // Attempt presentation creation with invalid token
    const invalidCreate = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token',
        },
        body: JSON.stringify({ title: 'Hacked Presentation' }),
      }),
    );
    expect(invalidCreate.status).toBe(401);
  });

  it('blocks attendees from advancing or changing presenter slide', async () => {
    // Attendee tries to advance slide using attendee token
    const attendeeNav = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({ slideId: 'slide-2-secret' }),
      }),
    );
    expect(attendeeNav.status).toBe(403);

    // Unauthenticated attempt
    const anonNav = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId: 'slide-2-secret' }),
      }),
    );
    expect(anonNav.status).toBe(403);
  });

  it('blocks unrevealed slide access and unrevealed PNG downloads', async () => {
    // Initial state: only slide-1 is revealed
    expect(session.revealedSlideIds).toEqual(['slide-1']);

    // Attempt accessing unrevealed slide-2 metadata
    const slide2Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slides/slide-2-secret`),
    );
    expect(slide2Res.status).toBe(403);

    // Attempt downloading unrevealed slide-2 PNG
    const png2Res = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/slides/slide-2-secret/download`,
      ),
    );
    expect(png2Res.status).toBe(403);
  });

  it('blocks pre-ending-slide full PDF download', async () => {
    const pdfRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/download`),
    );
    expect(pdfRes.status).toBe(403);
  });

  it('sanitizes XSS payloads in submitted questions', async () => {
    const xssPayload =
      '<script>alert("pwned")</script>How do you prevent XSS?<img src=x onerror=alert(1)>';

    const submitRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 'slide-1',
          content: xssPayload,
        }),
      }),
    );

    expect(submitRes.status).toBe(201);
    const question = (await submitRes.json()) as AudienceQuestion;
    expect(question.content).not.toContain('<script>');
    expect(question.content).not.toContain('alert(');
    expect(question.content).toContain('How do you prevent XSS?');
  });

  it('prevents duplicate votes on single-choice polls', async () => {
    // Presenter creates single-choice poll
    const pollRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({
          slideId: 'slide-1',
          question: 'Choice',
          type: 'single',
          status: 'open',
          options: [
            { id: 'opt-a', label: 'Option A' },
            { id: 'opt-b', label: 'Option B' },
          ],
        }),
      }),
    );
    const poll = (await pollRes.json()) as PollDefinition;

    // First vote -> succeeds 200
    const vote1 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls/${poll.id}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({ optionId: 'opt-a' }),
      }),
    );
    expect(vote1.status).toBe(200);

    // Duplicate vote attempt by same participant -> rejected with 409 Conflict
    const vote2 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls/${poll.id}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({ optionId: 'opt-b' }),
      }),
    );
    expect(vote2.status).toBe(409);
  });

  it('deduplicates events via coordinator processed_events', () => {
    const coordinator = app.getCoordinator(session.id);
    const eventId = 'evt-unique-dedup-1';

    expect(coordinator.isEventProcessed(eventId)).toBe(false);

    coordinator.broadcast({
      id: eventId,
      type: 'slide.changed',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      payload: { slideId: 'slide-1' },
    });

    expect(coordinator.isEventProcessed(eventId)).toBe(true);
  });

  it('enforces per-participant rate limiting with 429 Too Many Requests', async () => {
    // Limit is configured as 2 questions per window
    const postQ = () =>
      app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${attendee.token}`,
          },
          body: JSON.stringify({
            slideId: 'slide-1',
            content: 'Question under rate limit',
          }),
        }),
      );

    const r1 = await postQ();
    expect(r1.status).toBe(201);

    const r2 = await postQ();
    expect(r2.status).toBe(201);

    // 3rd question in quick succession exceeds limit -> 429
    const r3 = await postQ();
    expect(r3.status).toBe(429);
    const errData = (await r3.json()) as { error: string };
    expect(errData.error).toContain('Rate limit exceeded');
  });
});
