import type {
  AudienceQuestion,
  AudienceSafeSessionView,
  NavigationSuggestion,
  ParticipantIdentity,
  PollDefinition,
  Presentation,
  PresentationSession,
  WordCloudAggregate,
} from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgoraWorkerApp } from '../../apps/worker/src/index';

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
          options: [
            { id: 'opt-yes', label: 'Yes, show advanced' },
            { id: 'opt-no', label: 'No, keep it high level' },
          ],
        }),
      }),
    );
    expect(pollRes.status).toBe(201);
    const poll = (await pollRes.json()) as PollDefinition;

    // Configure navigation rule for this poll
    app.store.navigationRules.set(pres.id, [
      {
        id: 'rule-adaptive-1',
        presentationId: pres.id,
        sourceSlideId: 'slide-poll',
        pollId: poll.id,
        optionId: 'opt-yes',
        minVoteThreshold: 1,
        targetSlideId: 'slide-advanced',
        targetHorizontalIndex: 1,
        targetVerticalIndex: 1,
      },
    ]);

    // 3. Attendee joins and votes
    const joinRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Charlie' }),
      }),
    );
    const attendee = (await joinRes.json()) as ParticipantIdentity;

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
    const voteData = (await voteRes.json()) as {
      suggestions: NavigationSuggestion[];
    };
    expect(voteData.suggestions.length).toBe(1);
    expect(voteData.suggestions[0]?.targetSlideId).toBe('slide-advanced');
    expect(voteData.suggestions[0]?.targetHorizontalIndex).toBe(1);

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
});
