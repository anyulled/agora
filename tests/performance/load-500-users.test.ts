import type { ParticipantIdentity, Presentation, PresentationSession } from '@agora/contracts';
import { describe, expect, it } from 'vitest';
import { createAgoraWorkerApp } from '../../apps/worker/src/index';

function computeP95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return sorted[index] ?? 0;
}

describe('Performance & Load Tests (SPEC-020)', () => {
  it('handles 500 concurrent participants: join, slide sync (<500ms p95), reactions (<1s p95), upvotes, and reconnect', async () => {
    const app = createAgoraWorkerApp({
      maxQuestionsPerWindow: 100,
      maxReactionsPerWindow: 100,
      rateWindowMs: 1000,
    });

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer agora-admin-secret-token',
    };

    // 1. Create presentation & session
    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'High Concurrency Presentation',
          endingSlideId: 'end',
          slides: [
            {
              id: 'slide-perf-1',
              presentationId: 'pres-perf',
              title: 'Slide 1',
              horizontalIndex: 0,
              verticalIndex: 0,
              order: 0,
            },
            {
              id: 'slide-perf-2',
              presentationId: 'pres-perf',
              title: 'Slide 2',
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
    const session = (await sRes.json()) as PresentationSession & {
      presenterToken: string;
    };
    const sessionId = session.id;

    // 2. 500 Concurrent Attendee Joins
    const participantCount = 500;
    const joinLatencies: number[] = [];

    const joinPromises = Array.from({ length: participantCount }, async (_, i) => {
      const start = performance.now();
      const res = await app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: `Attendee ${i + 1}` }),
        }),
      );
      const elapsed = performance.now() - start;
      joinLatencies.push(elapsed);
      expect(res.status).toBe(201);
      return (await res.json()) as ParticipantIdentity;
    });

    const participants = await Promise.all(joinPromises);
    expect(participants.length).toBe(participantCount);

    const joinP95 = computeP95(joinLatencies);
    expect(joinP95).toBeLessThan(500); // well within latency targets

    // 3. Slide Sync: Presenter changes slide, sync latency measured
    const syncLatencies: number[] = [];
    const syncStart = performance.now();
    const navRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/slide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.presenterToken}`,
        },
        body: JSON.stringify({ slideId: 'slide-perf-2' }),
      }),
    );
    expect(navRes.status).toBe(200);
    const syncDuration = performance.now() - syncStart;
    syncLatencies.push(syncDuration);

    const syncP95 = computeP95(syncLatencies);
    expect(syncP95).toBeLessThan(500); // Target: p95 < 500ms

    // 4. Concurrent Reactions: 500 participants reacting to slide-perf-2
    const reactionLatencies: number[] = [];
    const reactionPromises = participants.map(async (p, idx) => {
      const emojis: ('👍' | '🤔' | '❤️' | '😴')[] = ['👍', '🤔', '❤️', '😴'];
      const emoji = emojis[idx % 4]!;
      const start = performance.now();

      const res = await app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/reactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.token}`,
          },
          body: JSON.stringify({ slideId: 'slide-perf-2', reaction: emoji }),
        }),
      );
      const elapsed = performance.now() - start;
      reactionLatencies.push(elapsed);
      expect(res.status).toBe(200);
    });

    await Promise.all(reactionPromises);
    const reactionP95 = computeP95(reactionLatencies);
    expect(reactionP95).toBeLessThan(1000); // Target: p95 < 1s

    // 5. Concurrent Upvotes on a Question
    // First, submit a question
    const qRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${participants[0]!.token}`,
        },
        body: JSON.stringify({
          slideId: 'slide-perf-2',
          content: 'Performance load test question?',
        }),
      }),
    );
    expect(qRes.status).toBe(201);
    const question = (await qRes.json()) as { id: string };

    // 100 participants upvote question concurrently
    const upvoteSubset = participants.slice(1, 101);
    const upvotePromises = upvoteSubset.map(async (p) => {
      const res = await app.fetch(
        new Request(
          `https://api.agora.test/api/v1/sessions/${sessionId}/questions/${question.id}/upvote`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${p.token}` },
          },
        ),
      );
      expect(res.status).toBe(200);
    });
    await Promise.all(upvotePromises);

    // Verify upvote count
    const qListRes = await app.fetch(
      new Request(`https://api.agora.test/api/v1/sessions/${sessionId}/questions`),
    );
    const qList = (await qListRes.json()) as { id: string; upvotes: number }[];
    const targetQ = qList.find((q) => q.id === question.id);
    expect(targetQ?.upvotes).toBe(100);

    // 6. Clean Reconnect: Attendees re-query session state
    const reconnectPromises = participants.slice(0, 50).map(async () => {
      const res = await app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${sessionId}`),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { session: PresentationSession };
      expect(data.session.currentSlideId).toBe('slide-perf-2');
    });
    await Promise.all(reconnectPromises);
  });

  it('stretch test: handles 1,000 participants joining in a burst', async () => {
    const app = createAgoraWorkerApp();

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer agora-admin-secret-token',
    };

    const presRes = await app.fetch(
      new Request('https://api.agora.test/api/v1/presentations', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: 'Stretch Scale Presentation',
          endingSlideId: 'end',
          slides: [
            {
              id: 's-stretch',
              presentationId: 'p-stretch',
              title: 'Scale Slide',
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
    const session = (await sRes.json()) as PresentationSession;

    const burstCount = 1000;
    const burstPromises = Array.from({ length: burstCount }, (_, i) =>
      app.fetch(
        new Request(`https://api.agora.test/api/v1/sessions/${session.id}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: `Burst User ${i}` }),
        }),
      ),
    );

    const burstResponses = await Promise.all(burstPromises);
    const allSuccessful = burstResponses.every((r) => r.status === 201);
    expect(allSuccessful).toBe(true);
    expect(app.store.participants.size).toBe(burstCount);
  });
});
