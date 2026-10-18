import type {
  AssetManifest,
  AudienceQuestion,
  NavigationRule,
  PollDefinition,
  PollResultsSummary,
  Presentation,
  SlideMetadata,
  WordCloudPrompt,
} from '@agora/contracts';
import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  aggregateWordCloudSubmissions,
  bumpRevision,
  canDownloadFullPdf,
  canDownloadSlidePng,
  completeSession,
  createLiveSession,
  createPresentation,
  duplicatePresentation,
  editPresentationSlide,
  evaluateAdaptiveNavigationRules,
  getSoloNavigableSlides,
  isSlideRevealed,
  navigatePresenterSlide,
  navigateSoloMode,
  normalizeWordCloudTerm,
  recordPollVote,
  sanitizeAndValidateQuestion,
  sortQuestions,
  startScheduledSession,
  toggleQuestionUpvote,
  validateSlideAccess,
} from '../index.js';

describe('Domain Logic — SPEC-001 through SPEC-024', () => {
  const sampleSlides: SlideMetadata[] = [
    {
      id: 'slide-1',
      presentationId: 'pres-1',
      title: 'Title Slide',
      horizontalIndex: 0,
      verticalIndex: 0,
      order: 0,
    },
    {
      id: 'slide-2',
      presentationId: 'pres-1',
      title: 'Architecture Overview',
      horizontalIndex: 1,
      verticalIndex: 0,
      order: 1,
    },
    {
      id: 'slide-3',
      presentationId: 'pres-1',
      title: 'Deep Dive',
      horizontalIndex: 2,
      verticalIndex: 0,
      order: 2,
    },
    {
      id: 'slide-ending',
      presentationId: 'pres-1',
      title: 'Conclusion & Q&A',
      horizontalIndex: 3,
      verticalIndex: 0,
      order: 3,
      isQaSlide: true,
    },
  ];

  const samplePresentation: Presentation = {
    id: 'pres-1',
    title: 'Cloudflare Architectures',
    description: 'A deep dive into distributed web apps',
    eventName: 'TechConf 2026',
    revision: 'rev-1',
    status: 'draft',
    endingSlideId: 'slide-ending',
    branding: {
      colors: { primary: '#f6821f', background: '#000000' },
      logoAssetId: 'logo-1',
    },
    slides: sampleSlides,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  };

  describe('SPEC-001 & SPEC-017: Presentation administration, revision bumps & duplication', () => {
    it('creates presentation with validated inputs and defaults', () => {
      const pres = createPresentation({
        id: 'pres-1',
        title: 'New Deck',
        endingSlideId: 'slide-ending',
        branding: { colors: { primary: '#fff' } },
      });

      expect(pres.id).toBe('pres-1');
      expect(pres.title).toBe('New Deck');
      expect(pres.revision).toBe('rev-1');
      expect(pres.status).toBe('draft');
      expect(pres.slides).toEqual([]);
      expect(pres.createdAt).toBeDefined();
    });

    it('rejects invalid inputs on presentation creation', () => {
      expect(() =>
        createPresentation({
          id: '',
          title: 'Deck',
          endingSlideId: 'slide-ending',
          branding: { colors: {} },
        }),
      ).toThrow('Presentation ID is required');

      expect(() =>
        createPresentation({
          id: 'pres-1',
          title: '   ',
          endingSlideId: 'slide-ending',
          branding: { colors: {} },
        }),
      ).toThrow('Presentation title cannot be empty');

      expect(() =>
        createPresentation({
          id: 'pres-1',
          title: 'Deck',
          endingSlideId: '  ',
          branding: { colors: {} },
        }),
      ).toThrow('Ending slide ID is required');
    });

    it('bumps revisions monotonically', () => {
      expect(bumpRevision('rev-1')).toBe('rev-2');
      expect(bumpRevision('rev-9')).toBe('rev-10');
      expect(bumpRevision('v1')).toBe('v2');
      expect(bumpRevision('draft')).toBe('draft-2');
    });

    it('edits slide, bumps revision and invalidates stale generated assets (SPEC-001, SPEC-013, SPEC-015)', () => {
      const initialAssets: AssetManifest = {
        presentationId: 'pres-1',
        revision: 'rev-1',
        slidePngs: {
          'slide-1': {
            assetId: 'asset-1',
            presentationId: 'pres-1',
            revision: 'rev-1',
            kind: 'slide-png',
            slideId: 'slide-1',
            r2Key: 'png/pres-1/rev-1/slide-1.png',
            contentType: 'image/png',
            byteSize: 1024,
            createdAt: '2026-10-18T10:00:00.000Z',
          },
        },
        deckPdf: {
          assetId: 'asset-pdf',
          presentationId: 'pres-1',
          revision: 'rev-1',
          kind: 'deck-pdf',
          r2Key: 'pdf/pres-1/rev-1/deck.pdf',
          contentType: 'application/pdf',
          byteSize: 50000,
          createdAt: '2026-10-18T10:00:00.000Z',
        },
        logo: {
          assetId: 'asset-logo',
          presentationId: 'pres-1',
          revision: 'rev-1',
          kind: 'logo',
          r2Key: 'logo/pres-1/logo.png',
          contentType: 'image/png',
          byteSize: 200,
          createdAt: '2026-10-18T10:00:00.000Z',
        },
      };

      const updatedSlide: SlideMetadata = {
        ...sampleSlides[0]!,
        title: 'Updated Title Slide',
      };

      const result = editPresentationSlide(samplePresentation, initialAssets, updatedSlide);

      expect(result.presentation.revision).toBe('rev-2');
      expect(result.presentation.slides?.[0]?.title).toBe('Updated Title Slide');
      expect(result.assetManifest.revision).toBe('rev-2');
      expect(result.assetManifest.slidePngs).toEqual({});
      expect(result.assetManifest.deckPdf).toBeUndefined();
      expect(result.assetManifest.logo?.assetId).toBe('asset-logo');
    });

    it('duplicates presentation without copying live state (SPEC-001, SPEC-017)', () => {
      const dup = duplicatePresentation(samplePresentation, sampleSlides, 'pres-dup-1', 'rev-1');

      expect(dup.presentation.id).toBe('pres-dup-1');
      expect(dup.presentation.title).toBe('Cloudflare Architectures (Copy)');
      expect(dup.presentation.revision).toBe('rev-1');
      expect(dup.presentation.revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(dup.presentation.status).toBe('draft');
      expect(dup.presentation.endingSlideId).toBe('slide-ending');
      expect(dup.slides[0]?.presentationId).toBe('pres-dup-1');
      expect(dup.presentation.branding.colors.primary).toBe('#f6821f');
    });

    it('computes deterministic SHA-256 revision hash and changes hash when slide content or sequence changes (SPEC-001b)', () => {
      const presA = createPresentation({
        id: 'pres-hash-1',
        title: 'Deterministic Deck',
        endingSlideId: 'slide-2',
        branding: { colors: { primary: '#112233', accent: '#445566' } },
        slides: sampleSlides,
      });
      const presB = createPresentation({
        id: 'pres-hash-2',
        title: 'Deterministic Deck',
        endingSlideId: 'slide-2',
        branding: { colors: { accent: '#445566', primary: '#112233' } },
        slides: sampleSlides,
      });

      expect(presA.revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(presA.revisionHash).toBe(presB.revisionHash);

      const edited = editPresentationSlide(presA, undefined, {
        ...sampleSlides[0]!,
        title: 'Modified Slide Title',
      });
      expect(edited.presentation.revisionHash).not.toBe(presA.revisionHash);
    });
  });

  describe('SPEC-002, SPEC-003 & SPEC-023: Live sessions & presenter navigation authority', () => {
    it('creates live session with initial state and transitions scheduled -> live -> completed (SPEC-002)', () => {
      const scheduled = createLiveSession(samplePresentation, 'sess-sched', 'https://agora.live', {
        initialStatus: 'scheduled',
      });
      expect(scheduled.status).toBe('scheduled');
      expect(scheduled.startedAt).toBeUndefined();
      expect(scheduled.currentSlideId).toBeNull();

      expect(() => startScheduledSession(scheduled, sampleSlides, 'attendee')).toThrow(
        'Unauthorized',
      );
      const started = startScheduledSession(scheduled, sampleSlides, 'presenter');
      expect(started.status).toBe('live');
      expect(started.startedAt).toBeDefined();
      expect(started.currentSlideId).toBe('slide-1');
      expect(started.revealedSlideIds).toEqual(['slide-1']);

      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      expect(session.id).toBe('sess-100');
      expect(session.status).toBe('live');
      expect(session.currentSlideId).toBeNull();
      expect(session.revealedSlideIds).toEqual([]);
      expect(session.pdfDownloadUnlocked).toBe(false);
      expect(session.audienceUrl).toBe('https://agora.live/session/sess-100');
      expect(session.qrCodeDataUrl).toContain('data:image/svg+xml');
    });

    it('rejects navigation if actor is attendee (SPEC-003, SPEC-023)', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      expect(() => navigatePresenterSlide(session, sampleSlides, 'slide-1', 'attendee')).toThrow(
        'Unauthorized: attendee cannot navigate presenter slide',
      );
    });

    it('allows presenter and admin to navigate and updates authoritative state', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');
      const step1 = navigatePresenterSlide(session, sampleSlides, 'slide-1', 'presenter');

      expect(step1.currentSlideId).toBe('slide-1');
      expect(step1.revealedSlideIds).toEqual(['slide-1']);
      expect(step1.pdfDownloadUnlocked).toBe(false);

      const step2 = navigatePresenterSlide(step1, sampleSlides, 'slide-2', 'admin');
      expect(step2.currentSlideId).toBe('slide-2');
      expect(step2.revealedSlideIds).toEqual(['slide-1', 'slide-2']);
    });

    it('completes session explicitly only by authorized role (SPEC-002, SPEC-022)', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      expect(() => completeSession(session, 'attendee')).toThrow('Unauthorized');

      const completed = completeSession(session, 'presenter');
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeDefined();

      expect(() => navigatePresenterSlide(completed, sampleSlides, 'slide-1', 'presenter')).toThrow(
        'Cannot navigate completed session',
      );
    });
  });

  describe('SPEC-004 & SPEC-005: Follow and Solo mode revealed slides & backtracking', () => {
    it('preserves revealed slides when presenter backtracks and leaves skipped slides unrevealed', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      // Presenter visits slide 1
      const s1 = navigatePresenterSlide(session, sampleSlides, 'slide-1', 'presenter');
      expect(s1.revealedSlideIds).toEqual(['slide-1']);

      // Presenter skips slide 2 and visits slide 3 directly
      const s3 = navigatePresenterSlide(s1, sampleSlides, 'slide-3', 'presenter');
      expect(s3.revealedSlideIds).toEqual(['slide-1', 'slide-3']);
      expect(s3.revealedSlideIds.includes('slide-2')).toBe(false);

      // Presenter backtracks to slide 1
      const sBack = navigatePresenterSlide(s3, sampleSlides, 'slide-1', 'presenter');
      expect(sBack.currentSlideId).toBe('slide-1');
      // slide-3 must remain in revealedSlideIds!
      expect(sBack.revealedSlideIds).toEqual(['slide-1', 'slide-3']);
    });

    it('navigates Solo mode exclusively through revealed slides sorted by order (SPEC-005)', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');
      // Reveal slide-3 then slide-1
      let s = navigatePresenterSlide(session, sampleSlides, 'slide-3', 'presenter');
      s = navigatePresenterSlide(s, sampleSlides, 'slide-1', 'presenter');

      const soloSlides = getSoloNavigableSlides(s, sampleSlides);
      // Even though slide-3 was visited first, order sorting puts slide-1 (order 0) before slide-3 (order 2)
      expect(soloSlides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-3']);

      // Navigation: forward from slide-1
      const next1 = navigateSoloMode(s, sampleSlides, 'slide-1', 'next');
      expect(next1?.id).toBe('slide-3');

      // Forward from slide-3 clamps to slide-3 (skipped slide-2 is unreachable)
      const next2 = navigateSoloMode(s, sampleSlides, 'slide-3', 'next');
      expect(next2?.id).toBe('slide-3');

      // Backward from slide-3 returns slide-1
      const prev1 = navigateSoloMode(s, sampleSlides, 'slide-3', 'prev');
      expect(prev1?.id).toBe('slide-1');

      // Backward from slide-1 clamps to slide-1
      const prev2 = navigateSoloMode(s, sampleSlides, 'slide-1', 'prev');
      expect(prev2?.id).toBe('slide-1');
    });

    it('validates slide revelation and enforces access controls on revealed slides (SPEC-005)', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');
      const s = navigatePresenterSlide(session, sampleSlides, 'slide-1', 'presenter');

      expect(isSlideRevealed(s, 'slide-1')).toBe(true);
      expect(isSlideRevealed(s, 'slide-2')).toBe(false);

      expect(() => validateSlideAccess(s, 'slide-1')).not.toThrow();
      expect(() => validateSlideAccess(s, 'slide-2')).toThrow(
        "Slide 'slide-2' has not been revealed yet in this session",
      );
    });
  });

  describe('SPEC-016 & SPEC-022: Ending slide PDF unlock without completing session', () => {
    it('permanently unlocks PDF upon reaching ending slide, without completing session', () => {
      const session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      const sEnding = navigatePresenterSlide(
        session,
        sampleSlides,
        'slide-ending',
        'presenter',
        samplePresentation.endingSlideId,
      );

      expect(sEnding.pdfDownloadUnlocked).toBe(true);
      expect(sEnding.status).toBe('live'); // Never automatically marks session completed!

      // Navigating backward does not revoke unlock
      const sBack = navigatePresenterSlide(
        sEnding,
        sampleSlides,
        'slide-1',
        'presenter',
        samplePresentation.endingSlideId,
      );
      expect(sBack.pdfDownloadUnlocked).toBe(true);
      expect(sBack.status).toBe('live');
    });
  });

  describe('SPEC-014, SPEC-016 & SPEC-024: Gated Asset Downloads (PNG and PDF)', () => {
    const assetManifest: AssetManifest = {
      presentationId: 'pres-1',
      revision: 'rev-1',
      slidePngs: {
        'slide-1': {
          assetId: 'a1',
          presentationId: 'pres-1',
          revision: 'rev-1',
          kind: 'slide-png',
          slideId: 'slide-1',
          r2Key: 'png/slide-1.png',
          contentType: 'image/png',
          byteSize: 100,
          createdAt: '2026-10-18T10:00:00.000Z',
        },
        'slide-2': {
          assetId: 'a2',
          presentationId: 'pres-1',
          revision: 'rev-1',
          kind: 'slide-png',
          slideId: 'slide-2',
          r2Key: 'png/slide-2.png',
          contentType: 'image/png',
          byteSize: 100,
          createdAt: '2026-10-18T10:00:00.000Z',
        },
      },
      deckPdf: {
        assetId: 'apdf',
        presentationId: 'pres-1',
        revision: 'rev-1',
        kind: 'deck-pdf',
        r2Key: 'pdf/deck.pdf',
        contentType: 'application/pdf',
        byteSize: 1000,
        createdAt: '2026-10-18T10:00:00.000Z',
      },
    };

    it('enforces single slide PNG download gated conditions (SPEC-014, SPEC-024)', () => {
      let session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      // Not revealed yet
      expect(canDownloadSlidePng(session, 'slide-1', assetManifest)).toBe(false);

      // Revealed slide-1
      session = navigatePresenterSlide(session, sampleSlides, 'slide-1', 'presenter');
      expect(canDownloadSlidePng(session, 'slide-1', assetManifest)).toBe(true);

      // Slide 2 has PNG generated, but is unrevealed -> FALSE
      expect(canDownloadSlidePng(session, 'slide-2', assetManifest)).toBe(false);

      // Slide 3 is revealed, but PNG is not generated -> FALSE
      session = navigatePresenterSlide(session, sampleSlides, 'slide-3', 'presenter');
      expect(canDownloadSlidePng(session, 'slide-3', assetManifest)).toBe(false);

      // Mismatched revision -> FALSE
      const staleManifest = { ...assetManifest, revision: 'rev-99' };
      expect(canDownloadSlidePng(session, 'slide-1', staleManifest)).toBe(false);
    });

    it('enforces full PDF download gated conditions (SPEC-016, SPEC-022, SPEC-024)', () => {
      let session = createLiveSession(samplePresentation, 'sess-100', 'https://agora.live');

      // Ending slide not visited -> FALSE
      expect(canDownloadFullPdf(session, assetManifest)).toBe(false);

      // Presenter visits ending slide -> TRUE
      session = navigatePresenterSlide(
        session,
        sampleSlides,
        'slide-ending',
        'presenter',
        samplePresentation.endingSlideId,
      );
      expect(canDownloadFullPdf(session, assetManifest)).toBe(true);

      // If PDF missing in manifest -> FALSE
      const noPdfManifest = { ...assetManifest, deckPdf: undefined };
      expect(canDownloadFullPdf(session, noPdfManifest)).toBe(false);

      // If revision is stale -> FALSE
      const staleManifest = { ...assetManifest, revision: 'rev-old' };
      expect(canDownloadFullPdf(session, staleManifest)).toBe(false);
    });
  });

  describe('SPEC-006 & SPEC-018: Sanitizing questions & Rate limiting', () => {
    it('strips HTML tags and enforces character length bounds', () => {
      const sanitized = sanitizeAndValidateQuestion(
        '<script>alert("hack")</script> How does DO hibernate? <b>bold</b>',
        '<i>Alice</i>',
      );

      expect(sanitized.content).toBe('How does DO hibernate? bold');
      expect(sanitized.participantName).toBe('Alice');
    });

    it('rejects empty questions and overly long questions', () => {
      expect(() => sanitizeAndValidateQuestion('   ')).toThrow('Question content cannot be empty');
      expect(() => sanitizeAndValidateQuestion('<p></p>')).toThrow(
        'Question content cannot be empty',
      );

      const hugeText = 'a'.repeat(501);
      expect(() => sanitizeAndValidateQuestion(hugeText)).toThrow('exceeds maximum length of 500');
    });

    it('RateLimiter enforces sliding window limits per participant', () => {
      const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
      const now = 10000;

      expect(limiter.check('user-1', now)).toBe(true);
      expect(limiter.consume('user-1', now)).toBe(true);
      expect(limiter.getRemaining('user-1', now)).toBe(1);

      expect(limiter.consume('user-1', now + 100)).toBe(true);
      expect(limiter.getRemaining('user-1', now + 100)).toBe(0);

      // 3rd request in same window fails
      expect(limiter.consume('user-1', now + 200)).toBe(false);
      expect(limiter.check('user-1', now + 200)).toBe(false);

      // user-2 has independent rate limit
      expect(limiter.consume('user-2', now + 200)).toBe(true);

      // After window expires (>1000ms), user-1 can consume again
      expect(limiter.consume('user-1', now + 1100)).toBe(true);
    });
  });

  describe('SPEC-007 & SPEC-008: Question upvoting and sorting', () => {
    const question: AudienceQuestion = {
      id: 'q-1',
      sessionId: 'sess-1',
      slideId: 'slide-1',
      participantId: 'part-1',
      content: 'Can DOs scale across regions?',
      status: 'pending',
      upvotes: 0,
      upvotedByParticipantIds: [],
      createdAt: '2026-10-18T10:00:00.000Z',
    };

    it('toggles upvote idempotently per participant and allows retracting', () => {
      const upvoted = toggleQuestionUpvote(question, 'part-2');
      expect(upvoted.upvotes).toBe(1);
      expect(upvoted.upvotedByParticipantIds).toEqual(['part-2']);

      // Retract
      const retracted = toggleQuestionUpvote(upvoted, 'part-2');
      expect(retracted.upvotes).toBe(0);
      expect(retracted.upvotedByParticipantIds).toEqual([]);
    });

    it('sorts questions by votes or time', () => {
      const qList: AudienceQuestion[] = [
        { ...question, id: 'q-1', upvotes: 2, createdAt: '2026-10-18T10:01:00.000Z' },
        { ...question, id: 'q-2', upvotes: 10, createdAt: '2026-10-18T10:00:00.000Z' },
        { ...question, id: 'q-3', upvotes: 2, createdAt: '2026-10-18T10:05:00.000Z' },
      ];

      const byVotes = sortQuestions(qList, 'votes');
      expect(byVotes.map((q) => q.id)).toEqual(['q-2', 'q-3', 'q-1']); // q-3 tie breaks over q-1 due to later createdAt

      const byTime = sortQuestions(qList, 'time');
      expect(byTime.map((q) => q.id)).toEqual(['q-3', 'q-1', 'q-2']);
    });
  });

  describe('SPEC-010 & SPEC-018: Contextual polls and voting invariants', () => {
    const poll: PollDefinition = {
      id: 'poll-1',
      sessionId: 'sess-1',
      slideId: 'slide-2',
      question: 'Which architecture do you prefer?',
      type: 'single',
      options: [
        { id: 'opt-a', label: 'Option A' },
        { id: 'opt-b', label: 'Option B' },
      ],
      status: 'open',
      resultsRevealed: false,
    };

    it('records valid vote for open single-choice poll', () => {
      const existing: Record<string, string[]> = {};
      const vote = recordPollVote(poll, existing, 'part-1', ['opt-a']);

      expect(vote.participantId).toBe('part-1');
      expect(vote.optionIds).toEqual(['opt-a']);
    });

    it('rejects double voting by the same participant', () => {
      const existing: Record<string, string[]> = { 'part-1': ['opt-a'] };
      expect(() => recordPollVote(poll, existing, 'part-1', ['opt-b'])).toThrow(
        'Participant has already voted in this poll',
      );
    });

    it('enforces single-choice constraint on single and binary polls', () => {
      const existing: Record<string, string[]> = {};
      expect(() => recordPollVote(poll, existing, 'part-1', ['opt-a', 'opt-b'])).toThrow(
        "Poll type 'single' requires exactly one selection",
      );
    });

    it('rejects voting when poll is closed or draft', () => {
      const closedPoll: PollDefinition = { ...poll, status: 'closed' };
      expect(() => recordPollVote(closedPoll, {}, 'part-1', ['opt-a'])).toThrow(
        'Poll is closed, voting is only allowed when open',
      );
    });
  });

  describe('SPEC-011: Adaptive navigation rule evaluation', () => {
    const rules: NavigationRule[] = [
      {
        id: 'rule-deep-dive',
        presentationId: 'pres-1',
        sourceSlideId: 'slide-2',
        pollId: 'poll-1',
        optionId: 'opt-a',
        minVoteThreshold: 10,
        minPercentageThreshold: 50,
        targetSlideId: 'slide-3',
        targetHorizontalIndex: 2,
        targetVerticalIndex: 0,
      },
    ];

    it('suggests target destination when vote and percentage thresholds are met', () => {
      const pollResults: PollResultsSummary = {
        pollId: 'poll-1',
        slideId: 'slide-2',
        status: 'closed',
        resultsRevealed: true,
        totalResponses: 20,
        countsByOptionId: {
          'opt-a': 14, // 70% >= 50% and 14 >= 10
          'opt-b': 6,
        },
      };

      const suggestions = evaluateAdaptiveNavigationRules(rules, pollResults);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.targetSlideId).toBe('slide-3');
      expect(suggestions[0]?.reason).toContain('Threshold met: 14 votes (70%)');
    });

    it('does not suggest if threshold not met', () => {
      const pollResults: PollResultsSummary = {
        pollId: 'poll-1',
        slideId: 'slide-2',
        status: 'closed',
        resultsRevealed: true,
        totalResponses: 20,
        countsByOptionId: {
          'opt-a': 8, // < 10
          'opt-b': 12,
        },
      };

      const suggestions = evaluateAdaptiveNavigationRules(rules, pollResults);
      expect(suggestions).toHaveLength(0);
    });
  });

  describe('SPEC-021: Word cloud submission normalization and aggregation', () => {
    const prompt: WordCloudPrompt = {
      id: 'wc-1',
      sessionId: 'sess-1',
      slideId: 'slide-2',
      prompt: 'One word to describe edge compute',
      status: 'open',
    };

    it('normalizes terms by lowercasing and stripping punctuation', () => {
      expect(normalizeWordCloudTerm('  FAST!  ')).toBe('fast');
      expect(normalizeWordCloudTerm('Server-less?')).toBe('server-less');
      expect(normalizeWordCloudTerm('Distributed...')).toBe('distributed');
    });

    it('aggregates submissions and sorts by frequency desc', () => {
      const submissions = [
        'Fast',
        'fast!',
        'FAST ',
        'Scalable',
        'scalable',
        'Resilient',
        '  ',
        '!!!',
      ];

      const agg = aggregateWordCloudSubmissions(prompt, submissions);

      expect(agg.totalSubmissions).toBe(6);
      expect(agg.terms).toEqual([
        { term: 'fast', count: 3 },
        { term: 'scalable', count: 2 },
        { term: 'resilient', count: 1 },
      ]);
    });
  });
});
