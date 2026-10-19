import type {
  AudienceQuestion,
  AudienceSafeSessionView,
  NavigationRule,
  NavigationSuggestion,
  ParticipantIdentity,
  PollDefinition,
  PollResultsSummary,
  Presentation,
  PresentationSession,
  ReactionCounts,
  WordCloudAggregate,
} from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudienceAppController } from '../../apps/audience/src/index';
import worker, { createAgoraWorkerApp } from '../../apps/worker/src/index';

it('retains configured Worker state across requests', async () => {
  const token = `local-test-${crypto.randomUUID()}`;
  const env = { ADMIN_TOKEN: token };
  const create = await worker.fetch(
    new Request('http://localhost/api/v1/presentations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ title: 'Local presentation' }),
    }),
    env,
  );
  expect(create.status).toBe(201);
  const presentation = (await create.json()) as Presentation;

  const list = await worker.fetch(new Request('http://localhost/api/v1/presentations'), env);
  expect(list.status).toBe(200);
  expect((await list.json()) as Presentation[]).toEqual([presentation]);
});

describe('Worker HTTP API Integration Tests', () => {
  const adminSecret = 'test-admin-secret-token';
  let app: ReturnType<typeof createAgoraWorkerApp>;

  beforeEach(() => {
    app = createAgoraWorkerApp({ adminToken: adminSecret });
  });

  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminSecret}`,
  };

  it('starts polls closed and validates the target slide and options', async () => {
    const origin = 'https://api.agora.test/api/v1';
    const presentationResponse = await app.fetch(
      new Request(`${origin}/presentations`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Poll deck',
          slides: [
            { id: 'slide-1', title: 'Vote', horizontalIndex: 0, verticalIndex: 0, order: 0 },
          ],
        }),
      }),
    );
    const presentation = (await presentationResponse.json()) as Presentation;
    const sessionResponse = await app.fetch(
      new Request(`${origin}/presentations/${presentation.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sessionResponse.json()) as PresentationSession & {
      presenterToken: string;
    };
    const endpoint = `${origin}/sessions/${session.id}/polls`;
    const headers = {
      'Content-Type': 'application/json',
      'x-presenter-token': session.presenterToken,
    };
    const pollBody = {
      slideId: 'slide-1',
      question: 'Ready?',
      type: 'binary',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    };

    const wrongSlide = await app.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...pollBody, slideId: 'missing' }),
      }),
    );
    expect(wrongSlide.status).toBe(400);
    const duplicateOptions = await app.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...pollBody,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'yes', label: 'No' },
          ],
        }),
      }),
    );
    expect(duplicateOptions.status).toBe(400);
    const created = await app.fetch(
      new Request(endpoint, { method: 'POST', headers, body: JSON.stringify(pollBody) }),
    );
    expect(created.status).toBe(201);
    const poll = (await created.json()) as PollDefinition;
    expect(poll.status).toBe('draft');

    const joined = await app.fetch(
      new Request(`${origin}/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    const participant = (await joined.json()) as ParticipantIdentity;
    const vote = await app.fetch(
      new Request(`${endpoint}/${poll.id}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-participant-token': participant.token },
        body: JSON.stringify({ optionId: 'yes' }),
      }),
    );
    expect(vote.status).toBe(400);
  });

  it('performs presentation CRUD, enforces confirmDestroy, and bumps revision on edits', async () => {
    // 1. Create Presentation
    const createRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Deep Learning at Scale',
          description: 'A comprehensive architectural overview',
          eventName: 'TechConf 2026',
          endingSlideId: 'slide-conclusion',
          branding: { colors: { primary: '#0055ff' } },
          slides: [
            {
              id: 'slide-intro',
              presentationId: 'p-1',
              title: 'Introduction',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-conclusion',
              presentationId: 'p-1',
              title: 'Conclusion',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
          ],
        }),
      }),
    );

    expect(createRes.status).toBe(201);
    const pres = (await createRes.json()) as Presentation;
    expect(pres.id).toBeDefined();
    expect(pres.title).toBe('Deep Learning at Scale');
    expect(pres.revision).toBe('rev-1');
    expect(pres.slides?.length).toBe(2);

    // 2. Upload PNG and PDF Assets for rev-1
    const pngUploadRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/presentations/${pres.id}/assets?slideId=slide-intro`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            kind: 'slide-png',
            slideId: 'slide-intro',
            revision: 'rev-1',
            base64: btoa('fake-png-bytes'),
          }),
        },
      ),
    );
    expect(pngUploadRes.status).toBe(201);

    const pdfUploadRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/assets`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          kind: 'deck-pdf',
          revision: 'rev-1',
          base64: btoa('fake-pdf-bytes'),
        }),
      }),
    );
    expect(pdfUploadRes.status).toBe(201);

    // 3. Edit Presentation -> revision bumps to rev-2, invalidating old assets
    const patchRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Deep Learning at Scale (Updated)',
        }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Presentation;
    expect(patched.title).toBe('Deep Learning at Scale (Updated)');
    expect(patched.revision).toBe('rev-2');

    // 4. Delete presentation requires confirmation
    const deleteWithoutConfirm = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}`, {
        method: 'DELETE',
        headers: adminHeaders,
      }),
    );
    expect(deleteWithoutConfirm.status).toBe(400);

    const deleteWithConfirm = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}?confirmDestroy=true`, {
        method: 'DELETE',
        headers: adminHeaders,
      }),
    );
    expect(deleteWithConfirm.status).toBe(200);

    const getDeleted = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}`),
    );
    expect(getDeleted.status).toBe(404);
  });

  it('SPEC-017: duplicates presentation with fresh revision and zero sessions/votes', async () => {
    // Create base presentation
    const createRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Original Keynote',
          endingSlideId: 'end-slide',
          slides: [
            {
              id: 's1',
              presentationId: 'orig',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
          ],
        }),
      }),
    );
    const original = (await createRes.json()) as Presentation;

    // Duplicate
    const dupRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${original.id}/duplicate`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );

    expect(dupRes.status).toBe(201);
    const duplicate = (await dupRes.json()) as Presentation;
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.title).toContain('Copy');
    expect(duplicate.revision).toBe('rev-1');
    expect(duplicate.slides?.[0]?.presentationId).toBe(duplicate.id);

    // Verify zero sessions for duplicate
    expect(app.store.sessions.size).toBe(0);
    expect(app.store.questions.size).toBe(0);
  });

  it('manages live session, participant join, slide revelation, and download unlocking', async () => {
    // 1. Setup presentation with 3 slides
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Full Lifecycle Deck',
          endingSlideId: 'slide-3-ending',
          slides: [
            {
              id: 'slide-1',
              presentationId: 'deck-1',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-2',
              presentationId: 'deck-1',
              title: 'Slide 2',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 'slide-3-ending',
              presentationId: 'deck-1',
              title: 'Ending Slide',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    const presentation = (await presRes.json()) as Presentation;

    // Upload PNG for slide-1 and PDF for current revision
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
            base64: btoa('png-1-data'),
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
          base64: btoa('pdf-deck-data'),
        }),
      }),
    );

    // 2. Start session
    const sessionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${presentation.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    expect(sessionRes.status).toBe(201);
    const sessionPayload = (await sessionRes.json()) as PresentationSession & {
      presenterToken: string;
    };
    const sessionId = sessionPayload.id;
    const presenterToken = sessionPayload.presenterToken;

    expect(sessionPayload.currentSlideId).toBe('slide-1');
    expect(sessionPayload.revealedSlideIds).toEqual(['slide-1']);
    expect(sessionPayload.pdfDownloadUnlocked).toBe(false);

    // 3. Attendee anonymous join
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      }),
    );
    expect(joinRes.status).toBe(201);
    const attendee = (await joinRes.json()) as ParticipantIdentity;
    expect(attendee.token).toBeDefined();

    // 4. Check audience safe view
    const viewRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}`),
    );
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as AudienceSafeSessionView;
    expect(view.session.id).toBe(sessionId);
    expect(view.availablePngSlideIds).toEqual(['slide-1']);
    expect(view.pdfAvailable).toBe(true);

    // 5. Download revealed PNG -> 200
    const pngRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/slides/slide-1/download`),
    );
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('Content-Type')).toBe('image/png');

    // 6. Attempt download of unrevealed slide-2 PNG -> 403 Forbidden
    const unrevealedPng = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/slides/slide-2/download`),
    );
    expect(unrevealedPng.status).toBe(403);

    // 7. Attempt full PDF download before ending slide -> 403 Forbidden
    const lockedPdf = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/download`),
    );
    expect(lockedPdf.status).toBe(403);

    // 8. Presenter navigates to ending slide: unlocks PDF without completing session
    const slideNavRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/slide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${presenterToken}`,
        },
        body: JSON.stringify({ slideId: 'slide-3-ending' }),
      }),
    );
    expect(slideNavRes.status).toBe(200);
    const navSession = (await slideNavRes.json()) as PresentationSession;
    expect(navSession.currentSlideId).toBe('slide-3-ending');
    expect(navSession.pdfDownloadUnlocked).toBe(true);
    expect(navSession.status).toBe('live'); // Visiting ending slide does NOT complete session!

    // 9. Full PDF download now unlocked -> 200
    const unlockedPdf = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/download`),
    );
    expect(unlockedPdf.status).toBe(200);
    expect(unlockedPdf.headers.get('Content-Type')).toBe('application/pdf');

    // 10. Presenter explicitly completes session
    const completeRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${presenterToken}` },
      }),
    );
    expect(completeRes.status).toBe(200);
    const completedSession = (await completeRes.json()) as PresentationSession;
    expect(completedSession.status).toBe('completed');
    expect(completedSession.completedAt).toBeDefined();
  });

  it('serves authenticated presenter fragments and keeps projector fragments free of private controls', async () => {
    const presentationId = 'presenter-deck';
    const sessionId = 'presenter-session';
    const presenterToken = 'presenter-token';
    const slides = [
      {
        id: 'slide-intro',
        presentationId,
        title: 'Opening Slide',
        horizontalIndex: 0,
        verticalIndex: 0,
        order: 0,
      },
      {
        id: 'slide-overview',
        presentationId,
        title: 'Overview',
        horizontalIndex: 1,
        verticalIndex: 0,
        order: 1,
      },
      {
        id: 'slide-detail',
        presentationId,
        title: 'Deep Detail',
        horizontalIndex: 1,
        verticalIndex: 1,
        order: 2,
      },
    ];
    app.store.presentations.set(presentationId, {
      id: presentationId,
      title: 'Presenter Console Deck',
      revision: 'rev-1',
      status: 'published',
      endingSlideId: 'slide-detail',
      branding: { colors: {} },
      slides,
    });
    app.store.slides.set(presentationId, slides);
    app.store.assets.set(presentationId, []);
    app.store.sessions.set(sessionId, {
      id: sessionId,
      presentationId,
      presentationRevision: 'rev-1',
      status: 'live',
      currentSlideId: 'slide-intro',
      revealedSlideIds: ['slide-intro'],
      pdfDownloadUnlocked: false,
      connectedParticipants: 1,
    });
    app.store.presenterTokens.set(sessionId, presenterToken);
    app.store.questions.set(sessionId, [
      {
        id: 'question-1',
        sessionId,
        slideId: 'slide-intro',
        participantId: 'attendee-1',
        content: 'Can we show the architecture breakdown next?',
        status: 'pending',
        upvotes: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    app.store.reactions.set(
      sessionId,
      new Map([['slide-intro', { '👍': 1, '🤔': 0, '❤️': 0, '😴': 0 }]]),
    );

    const unauthorizedPresenter = await app.fetch(
      new Request(`https://api.agora.test/presenter/${sessionId}?fragment=1`),
    );
    expect(unauthorizedPresenter.status).toBe(403);

    const presenterShell = await app.fetch(
      new Request(
        `https://api.agora.test/presenter/${sessionId}?token=${encodeURIComponent(presenterToken)}`,
      ),
    );
    expect(presenterShell.status).toBe(200);
    const presenterShellHtml = await presenterShell.text();
    expect(presenterShellHtml).toContain('Agora Presenter Console');
    expect(presenterShellHtml).toContain('Use arrow keys or the directional pad');

    const presenterFragment = await app.fetch(
      new Request(
        `https://api.agora.test/presenter/${sessionId}?fragment=1&token=${encodeURIComponent(presenterToken)}`,
      ),
    );
    expect(presenterFragment.status).toBe(200);
    expect(presenterFragment.headers.get('Content-Type')).toContain('text/html');
    const presenterHtml = await presenterFragment.text();
    expect(presenterHtml).toContain('Opening Slide');
    expect(presenterHtml).toContain('Coordinates: [0, 0]');
    expect(presenterHtml).toContain('Attendees');
    expect(presenterHtml).toContain('Questions');
    expect(presenterHtml).toContain('👍 1');
    expect(presenterHtml).toContain('data-action="nav-right"');
    expect(presenterHtml).toContain('data-action="complete-session"');
    expect(presenterHtml).toContain('agora-page-state');

    const projectorShell = await app.fetch(
      new Request(`https://api.agora.test/projector/${sessionId}`),
    );
    expect(projectorShell.status).toBe(200);
    const projectorShellHtml = await projectorShell.text();
    expect(projectorShellHtml).toContain('Agora Projector View');

    const projectorFragment = await app.fetch(
      new Request(`https://api.agora.test/projector/${sessionId}?fragment=1`),
    );
    expect(projectorFragment.status).toBe(200);
    const projectorHtml = await projectorFragment.text();
    expect(projectorHtml).toContain('Opening Slide');
    expect(projectorHtml).not.toContain('Attendees');
    expect(projectorHtml).not.toContain('data-action="nav-right"');
    expect(projectorHtml).not.toContain('metrics-hud');
    expect(projectorHtml).not.toContain('Complete Session');
  });

  it('manages Q&A, idempotent upvote toggling, and presenter status updates', async () => {
    // Create presentation and session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Q&A Deck',
          endingSlideId: 'end',
          slides: [
            {
              id: 's1',
              presentationId: 'p',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sRes.json()) as PresentationSession & {
      presenterToken: string;
    };

    // Attendee joins
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Bob' }),
      }),
    );
    const attendee = (await joinRes.json()) as ParticipantIdentity;

    // Submit Question
    const qRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 's1',
          content: 'What is the performance target for Agora?',
        }),
      }),
    );
    expect(qRes.status).toBe(201);
    const q = (await qRes.json()) as AudienceQuestion;
    expect(q.id).toBeDefined();
    expect(q.upvotes).toBe(0);

    // Upvote (1st time -> upvotes: 1)
    const upvote1 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q.id}/upvote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attendee.token}` },
      }),
    );
    expect(upvote1.status).toBe(200);
    const upvoteData1 = (await upvote1.json()) as AudienceQuestion & {
      userUpvoted: boolean;
    };
    expect(upvoteData1.upvotes).toBe(1);
    expect(upvoteData1.userUpvoted).toBe(true);

    // Upvote again (2nd time -> toggle off -> upvotes: 0)
    const upvote2 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q.id}/upvote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attendee.token}` },
      }),
    );
    expect(upvote2.status).toBe(200);
    const upvoteData2 = (await upvote2.json()) as AudienceQuestion & {
      userUpvoted: boolean;
    };
    expect(upvoteData2.upvotes).toBe(0);
    expect(upvoteData2.userUpvoted).toBe(false);

    // Presenter updates status to answered
    const patchQ = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({ status: 'answered' }),
      }),
    );
    expect(patchQ.status).toBe(200);
    const updatedQ = (await patchQ.json()) as AudienceQuestion;
    expect(updatedQ.status).toBe('answered');
  });

  it('manages polls, voting, adaptive navigation suggestions, and word clouds', async () => {
    // 1. Setup presentation with adaptive navigation rule
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Adaptive Deck',
          endingSlideId: 'end',
          slides: [
            {
              id: 'slide-poll',
              presentationId: 'p',
              title: 'Poll Slide',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-advanced',
              presentationId: 'p',
              title: 'Advanced Architecture',
              horizontalIndex: 1,
              verticalIndex: 1,
              order: 1,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sRes.json()) as PresentationSession & {
      presenterToken: string;
    };

    const presenterSocketMessages: string[] = [];
    const audienceSocketMessages: string[] = [];
    const coordinator = app.getCoordinator(session.id);
    const presenterSocket = {
      readyState: WebSocket.OPEN,
      send: (message: string) => presenterSocketMessages.push(message),
      close: () => {},
    } as unknown as WebSocket;
    const audienceSocket = {
      readyState: WebSocket.OPEN,
      send: (message: string) => audienceSocketMessages.push(message),
      close: () => {},
    } as unknown as WebSocket;
    coordinator.handleConnection(presenterSocket, 'https://agora.test', session.presenterToken);

    // 2. Presenter opens poll
    const pollRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({
          slideId: 'slide-poll',
          question: 'Should we dive into Advanced Architecture?',
          type: 'single',
          status: 'open',
          options: [
            { id: 'opt-yes', label: 'Yes, show advanced' },
            { id: 'opt-no', label: 'No, keep it high level' },
          ],
        }),
      }),
    );
    expect(pollRes.status).toBe(201);
    const poll = (await pollRes.json()) as PollDefinition;

    // Configure the branch through presentation settings. The API validates the
    // stable IDs and requires coordinates to match the destination slide.
    const ruleRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/navigation-rules`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          sourceSlideId: 'slide-poll',
          pollId: poll.id,
          optionId: 'opt-yes',
          minVoteThreshold: 1,
          targetSlideId: 'slide-advanced',
          targetHorizontalIndex: 1,
          targetVerticalIndex: 1,
        }),
      }),
    );
    expect(ruleRes.status).toBe(201);

    // 3. Attendee joins and votes
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Charlie' }),
      }),
    );
    const attendee = (await joinRes.json()) as ParticipantIdentity;
    coordinator.handleConnection(audienceSocket, 'https://agora.test', attendee.token);

    const voteRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls/${poll.id}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({ optionId: 'opt-yes' }),
      }),
    );
    expect(voteRes.status).toBe(200);
    const voteData = (await voteRes.json()) as { summary: PollResultsSummary };
    expect(voteData.summary.countsByOptionId['opt-yes']).toBe(1);

    // Poll closure, rather than an individual vote, evaluates rules and sends
    // the presenter's explicitly-confirmable suggestion.
    const closeRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls/${poll.id}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.presenterToken}` },
      }),
    );
    expect(closeRes.status).toBe(200);
    const closedPoll = (await closeRes.json()) as PollDefinition & {
      suggestions: NavigationSuggestion[];
    };
    expect(closedPoll.suggestions).toHaveLength(1);
    expect(closedPoll.suggestions[0]?.targetSlideId).toBe('slide-advanced');
    expect(closedPoll.suggestions[0]?.targetHorizontalIndex).toBe(1);
    expect(presenterSocketMessages.map((message) => JSON.parse(message).type)).toContain(
      'navigation.suggested',
    );
    expect(audienceSocketMessages.map((message) => JSON.parse(message).type)).not.toContain(
      'navigation.suggested',
    );

    const listedRules = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/navigation-rules`, {
        headers: adminHeaders,
      }),
    );
    expect(listedRules.status).toBe(200);
    expect((await listedRules.json()) as NavigationRule[]).toHaveLength(1);

    // 4. Word cloud prompt and submission
    const wcRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/wordclouds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({
          slideId: 'slide-poll',
          prompt: 'Describe your favorite feature in one word',
        }),
      }),
    );
    expect(wcRes.status).toBe(201);
    const wcPrompt = (await wcRes.json()) as { id: string };

    const wcSubRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/wordclouds/${wcPrompt.id}/submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${attendee.token}`,
          },
          body: JSON.stringify({ term: '  Real-Time!  ' }),
        },
      ),
    );
    expect(wcSubRes.status).toBe(200);
    const wcAggregate = (await wcSubRes.json()) as WordCloudAggregate;
    expect(wcAggregate.totalSubmissions).toBe(1);
    expect(wcAggregate.terms[0]?.term).toBe('realtime');
    expect(wcAggregate.terms[0]?.count).toBe(1);
  });

  it('SPEC-003 / SPEC-003b: presenter WebSocket slide.changed synchronization, backward navigation revealed preservation, and unauthorized dispatch rejection', async () => {
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Reveal WS Sync Deck',
          endingSlideId: 'slide-2',
          slides: [
            {
              id: 'slide-0',
              presentationId: 'p-ws',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-1-1',
              presentationId: 'p-ws',
              title: 'Vertical Detail',
              horizontalIndex: 1,
              verticalIndex: 1,
              order: 1,
            },
            {
              id: 'slide-2',
              presentationId: 'p-ws',
              title: 'Conclusion',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sessRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sessRes.json()) as PresentationSession & { presenterToken: string };

    const coordinator = app.getCoordinator(session.id);

    const presenterReceived: string[] = [];
    const presenterWs = {
      readyState: WebSocket.OPEN,
      send: (msg: string) => presenterReceived.push(msg),
      close: () => {},
    } as unknown as WebSocket;

    const audienceReceived: string[] = [];
    const audienceWs = {
      readyState: WebSocket.OPEN,
      send: (msg: string) => audienceReceived.push(msg),
      close: () => {},
    } as unknown as WebSocket;

    // 1. Handshake: both presenter and audience receive initial session.state snapshot
    expect(
      coordinator.handleConnection(presenterWs, 'https://agora.test', session.presenterToken),
    ).toBe(true);
    expect(coordinator.handleConnection(audienceWs, 'https://agora.test', null)).toBe(true);
    expect(presenterReceived.length).toBe(1);
    expect(JSON.parse(presenterReceived[0]!).type).toBe('session.state');

    // 2. Reject unauthenticated/audience navigation dispatch attempt
    const unauthOk = coordinator.handleMessage(
      audienceWs,
      JSON.stringify({
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 'slide-2',
          horizontalIndex: 2,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    expect(unauthOk).toBe(false);
    expect(app.store.sessions.get(session.id)?.currentSlideId).toBe('slide-0');
    const lastAudienceMsg = JSON.parse(audienceReceived[audienceReceived.length - 1]!);
    expect(lastAudienceMsg.type).toBe('error');
    expect(lastAudienceMsg.payload.code).toBe('UNAUTHORIZED_NAVIGATION');

    // 3. Authorized presenter dispatches forward 2D navigation -> p95 < 500ms
    const t0 = performance.now();
    const forwardOk = coordinator.handleMessage(
      presenterWs,
      JSON.stringify({
        id: 'evt-nav-forward',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 'slide-1-1',
          horizontalIndex: 1,
          verticalIndex: 1,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    const latencyMs = performance.now() - t0;
    expect(forwardOk).toBe(true);
    expect(latencyMs).toBeLessThan(500);
    expect(app.store.sessions.get(session.id)?.currentSlideId).toBe('slide-1-1');
    expect(app.store.sessions.get(session.id)?.revealedSlideIds).toEqual(['slide-0', 'slide-1-1']);

    // 4. Backward navigation maintains previously revealed slide status on the server
    const backwardOk = coordinator.handleMessage(
      presenterWs,
      JSON.stringify({
        id: 'evt-nav-backward',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 'slide-0',
          horizontalIndex: 0,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    expect(backwardOk).toBe(true);
    expect(app.store.sessions.get(session.id)?.currentSlideId).toBe('slide-0');
    expect(app.store.sessions.get(session.id)?.revealedSlideIds).toEqual(['slide-0', 'slide-1-1']);
  });

  it('synchronizes AudienceAppController in Follow mode with presenter navigation via WebSocket (SPEC-004)', async () => {
    // 1. Create presentation and session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Realtime Follow Deck',
          endingSlideId: 'slide-end',
          slides: [
            {
              id: 'slide-1',
              presentationId: 'p-follow',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-2',
              presentationId: 'p-follow',
              title: 'Deep Dive',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 'slide-end',
              presentationId: 'p-follow',
              title: 'Summary',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sessRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sessRes.json()) as PresentationSession & { presenterToken: string };
    const coordinator = app.getCoordinator(session.id);

    // 2. Initial audience fetch
    const audienceSafeRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}`),
    );
    const initialView = (await audienceSafeRes.json()) as AudienceSafeSessionView;

    const audience = new AudienceAppController(session.id);
    audience.syncSessionView(initialView);

    expect(audience.isFollowing()).toBe(true);
    expect(audience.getActiveSlide()?.id).toBe('slide-1');
    expect(audience.getViewModel().positionIndicator).toBe('Slide 1 of 3');

    // 3. Connect presenter socket and audience socket to coordinator
    const presenterWs = {
      readyState: WebSocket.OPEN,
      send: () => {},
      close: () => {},
    } as unknown as WebSocket;

    const audienceWs = {
      readyState: WebSocket.OPEN,
      send: (rawMsg: string) => {
        audience.handleMessage(rawMsg);
      },
      close: () => {},
    } as unknown as WebSocket;

    coordinator.handleConnection(presenterWs, 'https://agora.test', session.presenterToken);
    coordinator.handleConnection(audienceWs, 'https://agora.test', null);

    // 4. Presenter navigates forward to slide-2
    coordinator.handleMessage(
      presenterWs,
      JSON.stringify({
        id: 'evt-nav-2',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 'slide-2',
          horizontalIndex: 1,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
    );

    // Audience automatically followed speaker in real time
    expect(audience.getActiveSlide()?.id).toBe('slide-2');
    expect(audience.getActiveSlide()?.title).toBe('Deep Dive');
    expect(audience.getViewModel().positionIndicator).toBe('Slide 2 of 3');
  });

  it('manages Solo mode browsing, locks skipped slides, authorizes revealed slide APIs, and snaps back to Follow (SPEC-005)', async () => {
    // 1. Setup presentation with 4 slides
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Solo Mode Verification Deck',
          endingSlideId: 's-conclusion',
          slides: [
            {
              id: 's-intro',
              presentationId: 'p-solo',
              title: 'Introduction',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 's-architecture',
              presentationId: 'p-solo',
              title: 'Architecture Overview',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 's-skipped',
              presentationId: 'p-solo',
              title: 'Skipped Feature Branch',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
            {
              id: 's-conclusion',
              presentationId: 'p-solo',
              title: 'Conclusion',
              horizontalIndex: 3,
              verticalIndex: 0,
              order: 3,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    // Upload PNG assets for s-intro and s-architecture
    await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/assets?slideId=s-intro`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          kind: 'slide-png',
          slideId: 's-intro',
          revision: pres.revision,
          base64: btoa('png-intro-bytes'),
        }),
      }),
    );

    // 2. Start session
    const sessRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sessRes.json()) as PresentationSession & { presenterToken: string };
    const coordinator = app.getCoordinator(session.id);

    // 3. Attendee joins anonymously
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'SoloExplorer' }),
      }),
    );
    const attendee = (await joinRes.json()) as ParticipantIdentity;

    // 4. Presenter moves to s-architecture
    coordinator.handleMessage(
      {} as WebSocket,
      JSON.stringify({
        id: 'evt-to-arch',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 's-architecture',
          horizontalIndex: 1,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
      session.presenterToken,
    );

    // 5. Presenter skips s-skipped and moves directly to s-conclusion
    coordinator.handleMessage(
      {} as WebSocket,
      JSON.stringify({
        id: 'evt-to-conclusion',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 's-conclusion',
          horizontalIndex: 3,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
      session.presenterToken,
    );

    // 6. Presenter backtracks to s-architecture
    coordinator.handleMessage(
      {} as WebSocket,
      JSON.stringify({
        id: 'evt-backtrack',
        type: 'slide.changed',
        sessionId: session.id,
        payload: {
          slideId: 's-architecture',
          horizontalIndex: 1,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
      session.presenterToken,
    );

    const liveSessionState = app.store.sessions.get(session.id)!;
    expect(liveSessionState.currentSlideId).toBe('s-architecture');
    // s-conclusion remains in revealedSlideIds even after backtracking!
    expect(liveSessionState.revealedSlideIds).toContain('s-intro');
    expect(liveSessionState.revealedSlideIds).toContain('s-architecture');
    expect(liveSessionState.revealedSlideIds).toContain('s-conclusion');
    // s-skipped was never visited, so it is strictly absent
    expect(liveSessionState.revealedSlideIds).not.toContain('s-skipped');

    // 7. Attendee client setup
    const safeViewRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}`),
    );
    const safeView = (await safeViewRes.json()) as AudienceSafeSessionView;
    const audienceClient = new AudienceAppController(session.id, attendee);
    audienceClient.syncSessionView(safeView);

    // In Follow mode, tracks speaker
    expect(audienceClient.isFollowing()).toBe(true);
    expect(audienceClient.getActiveSlideId()).toBe('s-architecture');

    // Toggle to Solo mode
    audienceClient.setMode('solo');
    expect(audienceClient.getMode()).toBe('solo');
    expect(audienceClient.isFollowing()).toBe(false);

    // Solo previous goes to s-intro
    expect(audienceClient.canNavigateSoloPrev()).toBe(true);
    audienceClient.soloPrevious();
    expect(audienceClient.getActiveSlideId()).toBe('s-intro');

    // Solo next goes to s-architecture and then s-conclusion, skipping s-skipped completely
    expect(audienceClient.canNavigateSoloNext()).toBe(true);
    audienceClient.soloNext();
    expect(audienceClient.getActiveSlideId()).toBe('s-architecture');
    audienceClient.soloNext();
    expect(audienceClient.getActiveSlideId()).toBe('s-conclusion');
    expect(audienceClient.canNavigateSoloNext()).toBe(false);

    // 8. Server-side authoritative validation: revealed slides succeed, unrevealed slide fails
    // Valid slide detail
    const revealedSlideRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slides/s-intro`),
    );
    expect(revealedSlideRes.status).toBe(200);

    // Valid PNG download for revealed slide
    const revealedPngRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slides/s-intro/download`),
    );
    expect(revealedPngRes.status).toBe(200);

    // Valid question submission on revealed slide
    const questionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 's-intro',
          content: 'Does Solo mode work on intro slides?',
        }),
      }),
    );
    expect(questionRes.status).toBe(201);

    // Valid reaction on revealed slide
    const reactionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/reactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 's-intro',
          reaction: '❤️',
        }),
      }),
    );
    expect(reactionRes.status).toBe(200);

    // Attempting access/download/question/reaction on unrevealed s-skipped returns 403 Forbidden
    const unrevealedDetailRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slides/s-skipped`),
    );
    expect(unrevealedDetailRes.status).toBe(403);

    const unrevealedPngRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slides/s-skipped/download`),
    );
    expect(unrevealedPngRes.status).toBe(403);

    const unrevealedQuestionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 's-skipped',
          content: 'Can I ask about a locked slide?',
        }),
      }),
    );
    expect(unrevealedQuestionRes.status).toBe(403);

    const unrevealedReactionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/reactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attendee.token}`,
        },
        body: JSON.stringify({
          slideId: 's-skipped',
          reaction: '🤔',
        }),
      }),
    );
    expect(unrevealedReactionRes.status).toBe(403);

    // 9. Toggling back to Follow immediately snaps to the speaker's current slide (s-architecture)
    audienceClient.setMode('follow');
    expect(audienceClient.isFollowing()).toBe(true);
    expect(audienceClient.getActiveSlideId()).toBe('s-architecture');

    // 10. Confirm speaker and session remain unaffected
    expect(app.store.sessions.get(session.id)?.currentSlideId).toBe('s-architecture');
  });

  it('implements SPEC-006 Slide-scoped questions with whole-slide scoping, sanitization, rate limits, and presenter moderation', async () => {
    // 1. Create Presentation & Live Session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Clean Architecture in TypeScript',
          endingSlideId: 's-end',
          slides: [
            {
              id: 's-intro',
              presentationId: 'p-qa',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 's-clean',
              presentationId: 'p-qa',
              title: 'Clean Architecture',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 's-end',
              presentationId: 'p-qa',
              title: 'Conclusion',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    expect(presRes.status).toBe(201);
    const pres = (await presRes.json()) as Presentation;

    const sessionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ status: 'live' }),
      }),
    );
    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as PresentationSession & { presenterToken: string };

    // 2. Join Participants
    const p1Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      }),
    );
    const p1 = (await p1Res.json()) as ParticipantIdentity;

    const p2Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Bob' }),
      }),
    );
    const p2 = (await p2Res.json()) as ParticipantIdentity;

    // 3. Connect presenter & audience to WebSocket to verify real-time events
    const receivedEvents: string[] = [];
    const coordinator = app.getCoordinator(session.id);
    const mockWs = {
      readyState: 1,
      send: (msg: string) => {
        try {
          const parsed = JSON.parse(msg);
          receivedEvents.push(parsed.type);
        } catch {
          // ignore
        }
      },
      close: () => {},
    } as unknown as WebSocket;
    coordinator.handleConnection(mockWs, '*');

    // 4. Whole-slide scoping & input sanitization:
    // Pass fragment index `s-intro#fragment-2` -> must be anchored to whole slide `s-intro`
    // Pass raw HTML with script tag -> script tag and html stripped
    const q1Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p1.token}`,
        },
        body: JSON.stringify({
          slideId: 's-intro#fragment-2',
          content: '<b>What is the memory footprint?</b> <script>alert(1)</script>',
          participantName: '<i>Alice M.</i>',
        }),
      }),
    );
    expect(q1Res.status).toBe(201);
    const q1 = (await q1Res.json()) as AudienceQuestion;
    expect(q1.id).toBeDefined();
    expect(q1.slideId).toBe('s-intro'); // whole-slide scoping verified
    expect(q1.content).toBe('What is the memory footprint?'); // XSS stripped
    expect(q1.participantName).toBe('Alice M.'); // participant name sanitized
    expect(q1.status).toBe('pending');
    expect(q1.upvotes).toBe(0);
    expect(receivedEvents).toContain('question.submitted');

    // 5. Submit question defaulting to participant's registered displayName
    const q2Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p2.token}`,
        },
        body: JSON.stringify({
          slideId: 's-intro',
          content: 'How do you test Durable Objects locally?',
        }),
      }),
    );
    expect(q2Res.status).toBe(201);
    const q2 = (await q2Res.json()) as AudienceQuestion;
    expect(q2.participantName).toBe('Bob');

    // 6. Validation: reject empty content after sanitization
    const emptyQRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p1.token}`,
        },
        body: JSON.stringify({
          slideId: 's-intro',
          content: '<p>   <script>alert("xss")</script>   </p>',
        }),
      }),
    );
    expect(emptyQRes.status).toBe(400);

    // 7. Validation: reject question on unrevealed slide (s-clean is not yet revealed)
    const unrevealedQRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p1.token}`,
        },
        body: JSON.stringify({
          slideId: 's-clean',
          content: 'Is this revealed?',
        }),
      }),
    );
    expect(unrevealedQRes.status).toBe(403);

    // 8. Presenter navigates to reveal s-clean
    coordinator.handleMessage(
      {} as WebSocket,
      JSON.stringify({
        type: 'slide.changed',
        sessionId: session.id,
        token: session.presenterToken,
        payload: {
          slideId: 's-clean',
          horizontalIndex: 1,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
        },
      }),
      session.presenterToken,
    );

    // Now question on s-clean succeeds
    const q3Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p1.token}`,
        },
        body: JSON.stringify({
          slideId: 's-clean',
          content: 'Can domain import application services?',
        }),
      }),
    );
    expect(q3Res.status).toBe(201);
    const q3 = (await q3Res.json()) as AudienceQuestion;
    expect(q3.slideId).toBe('s-clean');

    // 9. Query questions filtered by slideId
    const filterRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions?slideId=s-intro`),
    );
    expect(filterRes.status).toBe(200);
    const introQuestions = (await filterRes.json()) as AudienceQuestion[];
    expect(introQuestions).toHaveLength(2);
    expect(introQuestions.every((q) => q.slideId === 's-intro')).toBe(true);

    // 10. Presenter moderation: mark question answered or dismissed
    // Unauthorized attempt returns 403
    const unauthPatch = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p1.token}`, // attendee token cannot moderate
        },
        body: JSON.stringify({ status: 'answered' }),
      }),
    );
    expect(unauthPatch.status).toBe(403);

    // Authorized presenter marks answered
    const patchAnswered = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({ status: 'answered' }),
      }),
    );
    expect(patchAnswered.status).toBe(200);
    const answeredQ1 = (await patchAnswered.json()) as AudienceQuestion;
    expect(answeredQ1.status).toBe('answered');
    expect(receivedEvents).toContain('question.updated');

    // Authorized presenter marks dismissed
    const patchDismissed = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q2.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({ status: 'dismissed' }),
      }),
    );
    expect(patchDismissed.status).toBe(200);
    const dismissedQ2 = (await patchDismissed.json()) as AudienceQuestion;
    expect(dismissedQ2.status).toBe('dismissed');

    // Invalid status returns 400
    const invalidStatus = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({ status: 'invalid-status' }),
      }),
    );
    expect(invalidStatus.status).toBe(400);

    // 11. Rate limiting: verify flood protection
    // Submit until limit is hit
    let hitRateLimit = false;
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p1.token}`,
          },
          body: JSON.stringify({
            slideId: 's-intro',
            content: `Flood test question ${i}`,
          }),
        }),
      );
      if (res.status === 429) {
        hitRateLimit = true;
        break;
      }
    }
    expect(hitRateLimit).toBe(true);
  });

  it('implements SPEC-007: idempotent upvoting, vote retraction, WebSocket events, and dynamic sorting', async () => {
    // 1. Create presentation & session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Upvote & Sorting Test Deck',
          endingSlideId: 's-end',
          slides: [
            {
              id: 's-1',
              presentationId: 'p-up',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 's-2',
              presentationId: 'p-up',
              title: 'Slide 2',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
            {
              id: 's-end',
              presentationId: 'p-up',
              title: 'Ending',
              horizontalIndex: 2,
              verticalIndex: 0,
              order: 2,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sessionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ status: 'live' }),
      }),
    );
    const session = (await sessionRes.json()) as PresentationSession & { presenterToken: string };

    // 2. Join two attendees
    const joinRes1 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      }),
    );
    const p1 = (await joinRes1.json()) as ParticipantIdentity;

    const joinRes2 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Bob' }),
      }),
    );
    const p2 = (await joinRes2.json()) as ParticipantIdentity;

    // 3. Connect presenter & attendee WebSockets to capture question.upvoted events
    const receivedEvents: Array<{ type: string; payload: unknown }> = [];
    const coordinator = app.getCoordinator(session.id);
    const mockWs = {
      readyState: 1,
      send: (rawMsg: string) => {
        try {
          const parsed = JSON.parse(rawMsg);
          receivedEvents.push({ type: parsed.type, payload: parsed.payload });
        } catch {
          // ignore non-json websocket frames
        }
      },
      close: () => {},
    } as unknown as WebSocket;
    coordinator.handleConnection(mockWs, '*');

    // 4. Submit questions on revealed slide s-1
    const q1Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p1.token}` },
        body: JSON.stringify({ slideId: 's-1', content: 'Question One: Architecture' }),
      }),
    );
    const q1 = (await q1Res.json()) as AudienceQuestion;

    const q2Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p2.token}` },
        body: JSON.stringify({ slideId: 's-1', content: 'Question Two: Performance' }),
      }),
    );
    const q2 = (await q2Res.json()) as AudienceQuestion;

    // Ensure distinct timestamps for sorting verification
    q1.createdAt = '2026-10-19T10:00:00.000Z';
    q2.createdAt = '2026-10-19T10:05:00.000Z';
    const sList = app.store.questions.get(session.id);
    if (sList) {
      const sq1 = sList.find((item) => item.id === q1.id);
      if (sq1) sq1.createdAt = q1.createdAt;
      const sq2 = sList.find((item) => item.id === q2.id);
      if (sq2) sq2.createdAt = q2.createdAt;
    }

    // 5. Upvote Q1 by Alice (1st upvote)
    const up1Res = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p1.token}` },
        },
      ),
    );
    expect(up1Res.status).toBe(200);
    const up1Data = (await up1Res.json()) as AudienceQuestion & {
      userUpvoted: boolean;
      voteCount: number;
      hasUpvoted: boolean;
    };
    expect(up1Data.upvotes).toBe(1);
    expect(up1Data.voteCount).toBe(1);
    expect(up1Data.userUpvoted).toBe(true);
    expect(up1Data.hasUpvoted).toBe(true);
    expect(up1Data.upvotedByParticipantIds).toContain(p1.id);

    // Verify WebSocket event broadcast
    const upEvent = receivedEvents.find((e) => e.type === 'question.upvoted');
    expect(upEvent).toBeDefined();
    expect(upEvent?.payload).toEqual(
      expect.objectContaining({
        questionId: q1.id,
        voteCount: 1,
        upvotes: 1,
        participantId: p1.id,
        hasUpvoted: true,
        userUpvoted: true,
      }),
    );

    // 6. Upvote Q1 by Bob (2nd upvote on Q1)
    const up2Res = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p2.token}` },
        },
      ),
    );
    expect(up2Res.status).toBe(200);
    const up2Data = (await up2Res.json()) as AudienceQuestion & { userUpvoted: boolean };
    expect(up2Data.upvotes).toBe(2);
    expect(up2Data.upvotedByParticipantIds).toContain(p1.id);
    expect(up2Data.upvotedByParticipantIds).toContain(p2.id);

    // 7. Retract upvote: Alice calls upvote again on Q1 -> toggles off to 1 vote
    const retractRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q1.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p1.token}` },
        },
      ),
    );
    expect(retractRes.status).toBe(200);
    const retractData = (await retractRes.json()) as AudienceQuestion & { userUpvoted: boolean };
    expect(retractData.upvotes).toBe(1);
    expect(retractData.userUpvoted).toBe(false);
    expect(retractData.upvotedByParticipantIds).not.toContain(p1.id);
    expect(retractData.upvotedByParticipantIds).toContain(p2.id);

    // 8. Bob upvotes Q2 twice: 1st adds, 2nd adds more upvotes to test sorting
    // Give Q2 3 upvotes from a third participant
    const joinRes3 = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Charlie' }),
      }),
    );
    const p3 = (await joinRes3.json()) as ParticipantIdentity;

    await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q2.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p1.token}` },
        },
      ),
    );
    await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q2.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p2.token}` },
        },
      ),
    );
    await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${q2.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p3.token}` },
        },
      ),
    );

    // Q2 now has 3 upvotes, Q1 has 1 upvote

    // 9. Query questions sorted by votes (descending default)
    const listVotesRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions?sortBy=votes`),
    );
    expect(listVotesRes.status).toBe(200);
    const listVotes = (await listVotesRes.json()) as AudienceQuestion[];
    expect(listVotes).toHaveLength(2);
    expect(listVotes[0]?.id).toBe(q2.id); // 3 upvotes
    expect(listVotes[1]?.id).toBe(q1.id); // 1 upvote

    // Query questions sorted by votes ascending
    const listVotesAscRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions?sortBy=votes&order=asc`,
      ),
    );
    expect(listVotesAscRes.status).toBe(200);
    const listVotesAsc = (await listVotesAscRes.json()) as AudienceQuestion[];
    expect(listVotesAsc[0]?.id).toBe(q1.id);
    expect(listVotesAsc[1]?.id).toBe(q2.id);

    // Query questions sorted by time
    const listTimeRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/questions?sortBy=time`),
    );
    expect(listTimeRes.status).toBe(200);
    const listTime = (await listTimeRes.json()) as AudienceQuestion[];
    expect(listTime[0]?.id).toBe(q2.id); // q2 created after q1

    // 10. Attempt upvoting question on unrevealed slide returns 403 Forbidden
    // Manually push a question with unrevealed slideId into session store
    const unrevealedQ: AudienceQuestion = {
      id: 'q-secret',
      sessionId: session.id,
      slideId: 's-2', // s-2 is not yet revealed
      participantId: p1.id,
      content: 'Secret slide question',
      status: 'pending',
      upvotes: 0,
      createdAt: new Date().toISOString(),
    };
    const sQuestions = app.store.questions.get(session.id) || [];
    sQuestions.push(unrevealedQ);
    app.store.questions.set(session.id, sQuestions);

    const unrevealedUpvoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/questions/${unrevealedQ.id}/upvote`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${p1.token}` },
        },
      ),
    );
    expect(unrevealedUpvoteRes.status).toBe(403);
  });

  it('SPEC-009: Durable Object aggregates reactions, enforces rate limits, rejects unrevealed slides, and broadcasts batched summaries over WebSockets', async () => {
    // 1. Create presentation and session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Reactions Test Deck',
          endingSlideId: 'slide-2',
          slides: [
            {
              id: 'slide-1',
              presentationId: 'p-react',
              title: 'Intro',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-2',
              presentationId: 'p-react',
              title: 'Secret',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sessionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as PresentationSession & { presenterToken: string };

    // 2. Join participant Alice
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      }),
    );
    const alice = (await joinRes.json()) as ParticipantIdentity;

    const coordinator = app.getCoordinator(session.id);
    const receivedMessages: string[] = [];
    const mockWs = {
      readyState: 1,
      send: (data: string) => {
        receivedMessages.push(data);
      },
      close: () => {},
    } as unknown as WebSocket;

    coordinator.handleConnection(mockWs, '*', alice.token);

    // Clear initial snapshot
    receivedMessages.length = 0;

    // 3. Alice sends 👍 reaction on revealed slide-1
    const accepted = coordinator.handleMessage(
      mockWs,
      JSON.stringify({
        type: 'reaction.added',
        token: alice.token,
        payload: {
          slideId: 'slide-1',
          reaction: '👍',
        },
      }),
    );
    expect(accepted).toBe(true);

    // Flush batched reaction summary
    coordinator.flushReactionSummaries();
    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const summaryMsg = JSON.parse(receivedMessages[receivedMessages.length - 1]!);
    expect(summaryMsg.type).toBe('reaction.summary');
    expect(summaryMsg.payload.slideId).toBe('slide-1');
    expect(summaryMsg.payload.counts['👍']).toBe(1);
    expect(summaryMsg.payload.counts['❤️']).toBe(0);

    // 4. Batch aggregation of multiple reactions
    coordinator.handleMessage(
      mockWs,
      JSON.stringify({
        type: 'reaction.added',
        token: alice.token,
        payload: { slideId: 'slide-1', reaction: '👍' },
      }),
    );
    coordinator.handleMessage(
      mockWs,
      JSON.stringify({
        type: 'reaction.added',
        token: alice.token,
        payload: { slideId: 'slide-1', reaction: '❤️' },
      }),
    );

    coordinator.flushReactionSummaries();
    const batchSummary = JSON.parse(receivedMessages[receivedMessages.length - 1]!);
    expect(batchSummary.type).toBe('reaction.summary');
    expect(batchSummary.payload.counts['👍']).toBe(2);
    expect(batchSummary.payload.counts['❤️']).toBe(1);

    // 5. Unrevealed slide rejection over WebSocket
    const unrevealedAccepted = coordinator.handleMessage(
      mockWs,
      JSON.stringify({
        type: 'reaction.added',
        token: alice.token,
        payload: { slideId: 'slide-2', reaction: '😴' },
      }),
    );
    expect(unrevealedAccepted).toBe(false);
    const errSlideMsg = JSON.parse(receivedMessages[receivedMessages.length - 1]!);
    expect(errSlideMsg.type).toBe('error');
    expect(errSlideMsg.payload.code).toBe('SLIDE_NOT_REVEALED');

    // 6. Rate limiting enforcement on rapid reaction flood
    let rateLimitTriggered = false;
    for (let i = 0; i < 15; i++) {
      const ok = coordinator.handleMessage(
        mockWs,
        JSON.stringify({
          type: 'reaction.added',
          token: alice.token,
          payload: { slideId: 'slide-1', reaction: '👍' },
        }),
      );
      if (!ok) {
        rateLimitTriggered = true;
      }
    }
    expect(rateLimitTriggered).toBe(true);
    const lastMsg = JSON.parse(receivedMessages[receivedMessages.length - 1]!);
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.payload.code).toBe('RATE_LIMIT_EXCEEDED');

    // 7. REST API reaction submission with rate limiting and unrevealed slide rejection
    const restReactionRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/reactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.token}`,
        },
        body: JSON.stringify({ slideId: 'slide-1', reaction: '😴' }),
      }),
    );
    expect(restReactionRes.status).toBe(200);
    const restData = (await restReactionRes.json()) as { ok: boolean; summary: ReactionCounts };
    expect(restData.ok).toBe(true);
    expect(restData.summary['😴']).toBe(1);

    // Reject unrevealed slide via REST -> 403
    const restUnrevealedRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/reactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.token}`,
        },
        body: JSON.stringify({ slideId: 'slide-2', reaction: '🤔' }),
      }),
    );
    expect(restUnrevealedRes.status).toBe(403);

    // Destroy coordinator
    coordinator.destroy();
  });

  it('implements SPEC-010: single/multi/binary poll formats, presenter lifecycle, participant voting invariants, and DO persistence', async () => {
    // 1. Setup presentation and session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Interactive Polls Keynote',
          endingSlideId: 'slide-poll-2',
          slides: [
            {
              id: 'slide-poll-1',
              presentationId: 'p-poll',
              title: 'Slide 1 - Architecture Poll',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-poll-2',
              presentationId: 'p-poll',
              title: 'Slide 2 - Feedback Poll',
              horizontalIndex: 1,
              verticalIndex: 0,
              order: 1,
            },
          ],
        }),
      }),
    );
    const pres = (await presRes.json()) as Presentation;

    const sRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/presentations/${pres.id}/sessions`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    const session = (await sRes.json()) as PresentationSession & { presenterToken: string };
    const presenterHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.presenterToken}`,
    };

    const invalidPollPayloads = [
      {
        slideId: 'slide-poll-1',
        question: 'Invalid type',
        type: 'unknown',
        options: [{ id: 'a' }],
      },
      {
        slideId: 'slide-poll-1',
        question: 'Invalid status',
        status: 'revealed',
        options: [{ id: 'a' }],
      },
      { slideId: 'slide-poll-1', question: 'Blank option ID', options: [{ id: '  ' }] },
      {
        slideId: 'slide-poll-1',
        question: 'Duplicate option IDs',
        options: [{ id: 'a' }, { id: 'a' }],
      },
    ];
    for (const payload of invalidPollPayloads) {
      const invalidResponse = await app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
          method: 'POST',
          headers: presenterHeaders,
          body: JSON.stringify(payload),
        }),
      );
      expect(invalidResponse.status).toBe(400);
    }

    // Join attendees Alice and Bob
    const joinAlice = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Alice' }),
      }),
    );
    const alice = (await joinAlice.json()) as ParticipantIdentity;

    const joinBob = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Bob' }),
      }),
    );
    const bob = (await joinBob.json()) as ParticipantIdentity;

    // 2. Presenter creates a single-choice poll on slide-poll-1
    const createSingleRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        method: 'POST',
        headers: presenterHeaders,
        body: JSON.stringify({
          slideId: 'slide-poll-1',
          question: 'What is your primary state storage?',
          type: 'single-choice',
          status: 'open',
          options: [
            { id: 'opt-d1', text: 'Cloudflare D1 SQLite' },
            { id: 'opt-do', text: 'Durable Objects Embedded SQLite' },
            { id: 'opt-kv', text: 'Workers KV' },
          ],
        }),
      }),
    );
    expect(createSingleRes.status).toBe(201);
    const singlePoll = (await createSingleRes.json()) as PollDefinition;
    expect(singlePoll.status).toBe('open');

    // 3. Presenter creates a binary poll on slide-poll-1
    const createBinaryRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        method: 'POST',
        headers: presenterHeaders,
        body: JSON.stringify({
          slideId: 'slide-poll-1',
          question: 'Do you run unit tests in CI on every push?',
          type: 'binary',
          status: 'open',
          options: [
            { id: 'bin-yes', text: 'Yes' },
            { id: 'bin-no', text: 'No' },
          ],
        }),
      }),
    );
    expect(createBinaryRes.status).toBe(201);
    await createBinaryRes.json();

    // 4. Presenter creates a multiple-choice poll on slide-poll-2 (currently unrevealed slide)
    const createMultiRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        method: 'POST',
        headers: presenterHeaders,
        body: JSON.stringify({
          slideId: 'slide-poll-2',
          question: 'Which features do you want next?',
          type: 'multiple-choice',
          status: 'open',
          options: [
            { id: 'm-export', text: 'Slide PNG Export' },
            { id: 'm-charts', text: 'Interactive Charts' },
            { id: 'm-a11y', text: 'A11y Enhancements' },
          ],
        }),
      }),
    );
    expect(createMultiRes.status).toBe(201);
    const multiPoll = (await createMultiRes.json()) as PollDefinition;

    // 5. Voting on an unrevealed slide (slide-poll-2) is rejected with 403
    const unrevealedVoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${multiPoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ selectedOptionIds: ['m-export', 'm-charts'] }),
        },
      ),
    );
    expect(unrevealedVoteRes.status).toBe(403);

    // 6. Voting invariant: single-choice rejects multiple options with 400
    const invalidMultiSelectRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ selectedOptionIds: ['opt-d1', 'opt-do'] }),
        },
      ),
    );
    expect(invalidMultiSelectRes.status).toBe(400);

    // Voting invariant: invalid option ID rejected with 400
    const invalidOptRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ optionId: 'invalid-non-existent-option' }),
        },
      ),
    );
    expect(invalidOptRes.status).toBe(400);

    // 7. Alice votes on single-choice poll -> 200 OK
    const aliceVoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ optionId: 'opt-do' }),
        },
      ),
    );
    expect(aliceVoteRes.status).toBe(200);

    // Voting invariant: Alice voting again in singlePoll rejected with 409 (duplicate vote)
    const duplicateVoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ optionId: 'opt-d1' }),
        },
      ),
    );
    expect(duplicateVoteRes.status).toBe(409);

    // Bob votes on single-choice poll -> 200 OK
    const bobVoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bob.token}`,
          },
          body: JSON.stringify({ optionId: 'opt-do' }),
        },
      ),
    );
    expect(bobVoteRes.status).toBe(200);

    const audienceStateRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}`),
    );
    const audienceState = (await audienceStateRes.json()) as {
      activePolls: Array<{
        pollId: string;
        totalResponses: number;
        countsByOptionId: Record<string, number>;
      }>;
    };
    const audiencePoll = audienceState.activePolls.find((poll) => poll.pollId === singlePoll.id);
    expect(audiencePoll?.totalResponses).toBe(0);
    expect(audiencePoll?.countsByOptionId['opt-do']).toBe(0);
    expect(audienceState.activePolls.some((poll) => poll.pollId === multiPoll.id)).toBe(false);

    const presenterStateRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}`, {
        headers: presenterHeaders,
      }),
    );
    const presenterState = (await presenterStateRes.json()) as {
      activePolls: Array<{
        pollId: string;
        totalResponses: number;
        countsByOptionId: Record<string, number>;
      }>;
    };
    const presenterPoll = presenterState.activePolls.find((poll) => poll.pollId === singlePoll.id);
    expect(presenterPoll?.totalResponses).toBe(2);
    expect(presenterPoll?.countsByOptionId['opt-do']).toBe(2);
    expect(presenterState.activePolls.some((poll) => poll.pollId === multiPoll.id)).toBe(true);

    // 8. Presenter closes poll -> voting while closed rejected with 400
    const closeRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/close`,
        {
          method: 'POST',
          headers: presenterHeaders,
        },
      ),
    );
    expect(closeRes.status).toBe(200);
    const closedData = (await closeRes.json()) as PollDefinition;
    expect(closedData.status).toBe('closed');

    // Voting when closed -> 400
    const voteClosedRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ optionId: 'opt-kv' }),
        },
      ),
    );
    expect(voteClosedRes.status).toBe(400);

    // Presenter can re-open poll on demand
    const reopenRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/open`,
        {
          method: 'POST',
          headers: presenterHeaders,
        },
      ),
    );
    expect(reopenRes.status).toBe(200);

    // 9. Presenter reveals poll results to projector/audience
    const revealRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${singlePoll.id}/reveal`,
        {
          method: 'POST',
          headers: presenterHeaders,
        },
      ),
    );
    expect(revealRes.status).toBe(200);
    const revealSummary = (await revealRes.json()) as {
      pollId: string;
      totalResponses: number;
      countsByOptionId: Record<string, number>;
      percentagesByOptionId: Record<string, number>;
    };
    expect(revealSummary.pollId).toBe(singlePoll.id);
    expect(revealSummary.totalResponses).toBe(2);
    expect(revealSummary.countsByOptionId['opt-do']).toBe(2);

    // 10. Reveal slide 2 and vote on multiple-choice poll
    const revealSlide2Res = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/slide`, {
        method: 'POST',
        headers: presenterHeaders,
        body: JSON.stringify({ slideId: 'slide-poll-2', indexh: 1, indexv: 0 }),
      }),
    );
    expect(revealSlide2Res.status).toBe(200);

    const repeatedChoiceRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${multiPoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ selectedOptionIds: ['m-export', 'm-export'] }),
        },
      ),
    );
    expect(repeatedChoiceRes.status).toBe(400);

    // Multiple-choice poll allows selecting 2 options
    const multiVoteRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${multiPoll.id}/vote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${alice.token}`,
          },
          body: JSON.stringify({ selectedOptionIds: ['m-export', 'm-a11y'] }),
        },
      ),
    );
    expect(multiVoteRes.status).toBe(200);

    // Presenter reveals multiple-choice poll results
    const revealMultiRes = await app.fetch(
      new Request(
        `https://api.agora.test/api/v1/sessions/${session.id}/polls/${multiPoll.id}/reveal`,
        {
          method: 'POST',
          headers: presenterHeaders,
        },
      ),
    );
    expect(revealMultiRes.status).toBe(200);
    const multiSummary = (await revealMultiRes.json()) as {
      totalResponses: number;
      countsByOptionId: Record<string, number>;
    };
    expect(multiSummary.totalResponses).toBe(1);
    expect(multiSummary.countsByOptionId['m-export']).toBe(1);
    expect(multiSummary.countsByOptionId['m-a11y']).toBe(1);

    // 11. Verify GET /api/v1/sessions/:id/polls lists all session polls
    const listPollsRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/polls`, {
        headers: presenterHeaders,
      }),
    );
    expect(listPollsRes.status).toBe(200);
    const listedPolls = (await listPollsRes.json()) as PollDefinition[];
    expect(listedPolls.length).toBe(3);
  });
});
