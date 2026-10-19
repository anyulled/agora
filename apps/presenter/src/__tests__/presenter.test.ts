import type {
  AssetManifest,
  AudienceQuestion,
  NavigationSuggestion,
  Presentation,
  PresentationSession,
} from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PresenterAppController,
  renderPresenterViewHtml,
  renderProjectorViewHtml,
} from '../index.js';

describe('PresenterAppController (SPEC-008, SPEC-011, SPEC-012, SPEC-023)', () => {
  let presenter: PresenterAppController;

  const mockPresentation: Presentation = {
    id: 'pres_1',
    title: 'Distributed Systems',
    revision: 'rev_1',
    status: 'published',
    endingSlideId: 'slide_ending',
    branding: { colors: { primary: '#2563eb' } },
    slides: [
      {
        id: 'slide_0',
        presentationId: 'pres_1',
        title: 'Welcome',
        horizontalIndex: 0,
        verticalIndex: 0,
        order: 0,
      },
      {
        id: 'slide_1',
        presentationId: 'pres_1',
        title: 'Architecture Overview',
        horizontalIndex: 1,
        verticalIndex: 0,
        order: 1,
      },
      {
        id: 'slide_1_detail',
        presentationId: 'pres_1',
        title: 'Deep Dive',
        horizontalIndex: 1,
        verticalIndex: 1,
        order: 2,
      },
      {
        id: 'slide_qa',
        presentationId: 'pres_1',
        title: 'Q&A Session',
        horizontalIndex: 2,
        verticalIndex: 0,
        order: 3,
        isQaSlide: true,
      },
      {
        id: 'slide_ending',
        presentationId: 'pres_1',
        title: 'Wrap-Up',
        horizontalIndex: 3,
        verticalIndex: 0,
        order: 4,
      },
    ],
  };

  const mockSession: PresentationSession = {
    id: 'sess_1',
    presentationId: 'pres_1',
    presentationRevision: 'rev_1',
    status: 'live',
    currentSlideId: 'slide_0',
    revealedSlideIds: ['slide_0'],
    pdfDownloadUnlocked: false,
    audienceUrl: 'https://agora.live/sessions/sess_1',
    qrCodeDataUrl: 'data:image/svg+xml;utf8,<svg>QR_sess_1</svg>',
    connectedParticipants: 12,
  };

  const mockManifest: AssetManifest = {
    presentationId: 'pres_1',
    revision: 'rev_1',
    slidePngs: {
      slide_1: {
        assetId: 'png_1',
        presentationId: 'pres_1',
        revision: 'rev_1',
        kind: 'slide-png',
        slideId: 'slide_1',
        r2Key: 'presentations/pres_1/rev_1/slides/slide_1.png',
        contentType: 'image/png',
        byteSize: 50000,
        createdAt: new Date().toISOString(),
      },
    },
  };

  beforeEach(() => {
    presenter = new PresenterAppController(mockSession, mockPresentation, mockManifest);
  });

  describe('Directional Navigation & Keyboard Handling (SPEC-012, SPEC-023)', () => {
    it('initializes at starting slide coordinates and tracks navigation availability', () => {
      const state = presenter.getViewState();
      expect(state.currentSlide?.id).toBe('slide_0');
      expect(state.horizontalIndex).toBe(0);
      expect(state.verticalIndex).toBe(0);
      expect(state.canNavigateLeft).toBe(false);
      expect(state.canNavigateRight).toBe(true);
      expect(state.canNavigateDown).toBe(false);
      expect(state.canNavigateUp).toBe(false);
    });

    it('navigates right, down, up, and left matching Reveal.js 2D grid', () => {
      // Right to slide_1
      expect(presenter.navigateRight()).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1');
      expect(presenter.canNavigateDown()).toBe(true);

      // Down to vertical slide_1_detail
      expect(presenter.navigateDown()).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1_detail');
      expect(presenter.canNavigateUp()).toBe(true);

      // Up back to slide_1
      expect(presenter.navigateUp()).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1');

      // Left back to slide_0
      expect(presenter.navigateLeft()).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_0');
    });

    it('handles keyboard arrow keys identically to clickable controls', () => {
      expect(presenter.handleKeyDown('ArrowRight')).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1');

      expect(presenter.handleKeyDown({ key: 'ArrowDown' })).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1_detail');

      expect(presenter.handleKeyDown('ArrowUp')).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1');

      expect(presenter.handleKeyDown('ArrowLeft')).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_0');

      // Unhandled key returns false
      expect(presenter.handleKeyDown('Space')).toBe(false);
    });

    it('accumulates revealed slides in authoritative session state', () => {
      presenter.navigateRight(); // reveals slide_1
      presenter.navigateRight(); // reveals slide_qa
      const session = presenter.getSession();
      expect(session.revealedSlideIds).toEqual(['slide_0', 'slide_1', 'slide_qa']);
    });
  });

  describe('Real-Time Metrics HUD (SPEC-009, SPEC-012)', () => {
    it('aggregates reactions for current slide and tracks attendee count', () => {
      presenter.updateParticipantCount(42);
      expect(presenter.getViewState().connectedParticipants).toBe(42);

      presenter.receiveReaction('slide_0', '👍');
      presenter.receiveReaction('slide_0', '👍');
      presenter.receiveReaction('slide_0', '❤️');

      const reactions = presenter.getReactionsForCurrentSlide();
      expect(reactions['👍']).toBe(2);
      expect(reactions['❤️']).toBe(1);
      expect(reactions['😴']).toBe(0);
    });
  });

  describe('Adaptive Navigation Suggestion Banner (SPEC-011)', () => {
    const mockSuggestion: NavigationSuggestion = {
      ruleId: 'rule_1',
      sourceSlideId: 'slide_0',
      pollId: 'poll_1',
      optionId: 'opt_tech',
      targetSlideId: 'slide_1_detail',
      targetHorizontalIndex: 1,
      targetVerticalIndex: 1,
      reason: '70% attendees requested technical deep dive',
    };

    it('shows suggestion banner without automatically navigating deck', () => {
      presenter.setNavigationSuggestion(mockSuggestion);
      expect(presenter.getActiveSuggestion()?.reason).toContain('technical deep dive');
      // Slide must NOT change automatically
      expect(presenter.getCurrentSlide()?.id).toBe('slide_0');

      const state = presenter.getViewState();
      expect(state.activeSuggestion).not.toBeNull();
    });

    it('requires explicit confirmation before jumping to target slide', () => {
      presenter.setNavigationSuggestion(mockSuggestion);
      const jumped = presenter.acceptNavigationSuggestion();

      expect(jumped).toBe(true);
      expect(presenter.getCurrentSlide()?.id).toBe('slide_1_detail');
      expect(presenter.getActiveSuggestion()).toBeNull();
    });

    it('allows dismissing suggestion without moving the deck', () => {
      presenter.setNavigationSuggestion(mockSuggestion);
      presenter.dismissNavigationSuggestion();

      expect(presenter.getActiveSuggestion()).toBeNull();
      expect(presenter.getCurrentSlide()?.id).toBe('slide_0');
    });
  });

  describe('Embedded Q&A Slide Controller (SPEC-008)', () => {
    const mockQuestions: AudienceQuestion[] = [
      {
        id: 'q1',
        sessionId: 'sess_1',
        slideId: 'slide_1',
        participantId: 'p_alice',
        participantName: 'Alice',
        content: 'How does gossip protocol scale?',
        status: 'pending',
        upvotes: 8,
        createdAt: '2026-10-18T20:00:00Z',
      },
      {
        id: 'q2',
        sessionId: 'sess_1',
        slideId: 'slide_0', // references slide_0 which has no PNG in mockManifest
        participantId: 'p_bob',
        participantName: 'Bob',
        content: 'Is this open source?',
        status: 'pending',
        upvotes: 3,
        createdAt: '2026-10-18T20:05:00Z',
      },
    ];

    beforeEach(() => {
      presenter.syncQuestions(mockQuestions);
      // Navigate to Q&A slide (horizontalIndex: 2, verticalIndex: 0)
      presenter.jumpToSlide('slide_qa');
    });

    it('activates Q&A controller on data-component="audience-qa" slide', () => {
      const qaState = presenter.getQaState();
      expect(qaState.isQaSlideActive).toBe(true);
      expect(qaState.viewMode).toBe('list');
      expect(presenter.getQuestions()).toHaveLength(2);
      expect(presenter.getQuestions()[0]?.upvotes).toBe(8);
    });

    it('transitions to internal detail view without navigating Reveal.js deck away (SPEC-008)', () => {
      const selected = presenter.selectQuestion('q1');
      expect(selected).toBe(true);

      const qaState = presenter.getQaState();
      expect(qaState.viewMode).toBe('detail');
      expect(qaState.selectedQuestion?.content).toBe('How does gossip protocol scale?');
      expect(qaState.hasReferencedSlidePng).toBe(true);
      expect(qaState.referencedSlidePngUrl).toContain('slide_1.png');

      // CRITICAL SPEC-008 INVARIANT: Active slide MUST remain slide_qa!
      expect(presenter.getCurrentSlide()?.id).toBe('slide_qa');
      expect(presenter.getSession().currentSlideId).toBe('slide_qa');
    });

    it('displays fallback when referenced slide static image is missing', () => {
      presenter.selectQuestion('q2');
      const qaState = presenter.getQaState();
      expect(qaState.hasReferencedSlidePng).toBe(false);
      expect(qaState.referencedSlidePngUrl).toBeNull();
    });

    it('returns to list view via backToList or Escape key', () => {
      presenter.selectQuestion('q1');
      expect(presenter.getQaState().viewMode).toBe('detail');

      // Escape key returns to list
      const handled = presenter.handleKeyDown('Escape');
      expect(handled).toBe(true);
      expect(presenter.getQaState().viewMode).toBe('list');
      expect(presenter.getQaState().selectedQuestionId).toBeNull();
    });

    it('marks question status as answered or dismissed (SPEC-006)', async () => {
      presenter.markQuestionStatus('q1', 'answered');
      expect(presenter.getQuestions().find((q) => q.id === 'q1')?.status).toBe('answered');

      const mockFetch = async (url: string, init?: RequestInit) => {
        expect(url).toContain('/api/v1/sessions/sess_1/questions/q1');
        expect(init?.method).toBe('PATCH');
        expect(init?.headers).toEqual({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-presenter-tok',
        });
        const body = JSON.parse(init?.body as string);
        expect(body.status).toBe('dismissed');

        return new Response(
          JSON.stringify({
            id: 'q1',
            sessionId: 'sess_1',
            slideId: 'slide_1',
            participantId: 'p_alice',
            participantName: 'Alice',
            content: 'How does gossip protocol scale?',
            status: 'dismissed',
            upvotes: 8,
            createdAt: '2026-10-18T20:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const updated = await presenter.updateQuestionStatusViaApi(
        'https://api.agora.test',
        'q1',
        'dismissed',
        'test-presenter-tok',
        mockFetch as unknown as typeof fetch,
      );
      expect(updated.status).toBe('dismissed');
      expect(presenter.getQuestions().find((q) => q.id === 'q1')?.status).toBe('dismissed');
    });

    it('processes question.upvoted real-time WebSocket events and updates tallies (SPEC-007)', () => {
      expect(presenter.getQuestions().find((q) => q.id === 'q1')?.upvotes).toBe(8);

      presenter.handleRealtimeEvent({
        id: 'evt-q1-upvote',
        type: 'question.upvoted',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          questionId: 'q1',
          voteCount: 15,
          upvotes: 15,
          participantId: 'p_bob',
          hasUpvoted: true,
        },
      });

      const q1 = presenter.getQuestions().find((q) => q.id === 'q1');
      expect(q1?.upvotes).toBe(15);
      expect(q1?.upvotedByParticipantIds).toContain('p_bob');
    });

    it('supports dynamic sorting by vote count and creation timestamp (SPEC-007)', () => {
      const byVotes = presenter.getQuestions('votes');
      expect(byVotes[0]?.id).toBe('q1'); // q1 has 8 votes vs q2 with 3 votes

      const byTime = presenter.getQuestions('time');
      expect(byTime[0]?.id).toBe('q2'); // q2 created at 20:05 vs q1 created at 20:00
    });
  });

  describe('Ending Slide & Explicit Session Completion (SPEC-016, SPEC-022)', () => {
    it('visiting ending slide unlocks PDF download without completing session', () => {
      expect(presenter.getSession().pdfDownloadUnlocked).toBe(false);

      presenter.jumpToSlide('slide_ending');

      const session = presenter.getSession();
      expect(session.pdfDownloadUnlocked).toBe(true);
      // SPEC-022: Must remain live, visiting ending slide alone does not complete it
      expect(session.status).toBe('live');
    });

    it('requires explicit presenter action to complete session', () => {
      presenter.jumpToSlide('slide_ending');
      expect(presenter.getSession().status).toBe('live');

      const completed = presenter.completeSession();
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeDefined();
    });
  });

  describe('Separation of Admin and Presenter Controls (SPEC-012)', () => {
    it('has zero admin or asset-generation buttons in view state and rendered HTML', () => {
      const state = presenter.getViewState();
      expect(state.hasAdminControls).toBe(false);

      const html = renderPresenterViewHtml(state);
      expect(html).toContain('https://agora.live/sessions/sess_1');
      expect(html).toContain('presenter-qr-code');
      expect(html).not.toContain('Generate All Slide Images');
      expect(html).not.toContain('Generate Images');
      expect(html).not.toContain('New Presentation');
      expect(html).not.toContain('Delete Presentation');
      expect(html).not.toContain('Duplicate');
    });

    it('public projection does not expose presenter-only controls or suggestion banner', () => {
      presenter.setNavigationSuggestion({
        ruleId: 'r1',
        sourceSlideId: 's0',
        pollId: 'p1',
        optionId: 'opt1',
        targetSlideId: 's1',
        targetHorizontalIndex: 1,
        targetVerticalIndex: 0,
        reason: 'Poll result',
      });

      const projectorState = presenter.getProjectorViewState();
      expect(projectorState.isSuggestionVisibleOnProjection).toBe(false);
      expect(projectorState.hasPresenterOnlyControls).toBe(false);

      const html = renderProjectorViewHtml(projectorState);
      expect(html).not.toContain('suggestion-banner');
      expect(html).not.toContain('dpad-container');
      expect(html).not.toContain('metrics-hud');
    });
  });

  describe('SPEC-009: Real-time reaction HUD and live event sync', () => {
    it('updates reactions for the current slide upon receiving direct reactions', () => {
      expect(presenter.getReactionsForCurrentSlide()).toEqual({
        '👍': 0,
        '🤔': 0,
        '❤️': 0,
        '😴': 0,
      });

      presenter.receiveReaction('slide_0', '👍');
      presenter.receiveReaction('slide_0', '❤️');
      presenter.receiveReaction('slide_0', '👍');

      const reactions = presenter.getReactionsForCurrentSlide();
      expect(reactions['👍']).toBe(2);
      expect(reactions['❤️']).toBe(1);
      expect(reactions['🤔']).toBe(0);
      expect(reactions['😴']).toBe(0);

      const html = renderPresenterViewHtml(presenter.getViewState());
      expect(html).toContain('<span>👍 2</span>');
      expect(html).toContain('<span>❤️ 1</span>');
      expect(html).toContain('<span>🤔 0</span>');
      expect(html).toContain('<span>😴 0</span>');
    });

    it('processes reaction.summary real-time WebSocket events for the active slide', () => {
      presenter.handleRealtimeEvent({
        id: 'evt-r-summary',
        type: 'reaction.summary',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          slideId: 'slide_0',
          counts: {
            '👍': 12,
            '🤔': 4,
            '❤️': 8,
            '😴': 1,
          },
        },
      });

      const current = presenter.getReactionsForCurrentSlide();
      expect(current).toEqual({
        '👍': 12,
        '🤔': 4,
        '❤️': 8,
        '😴': 1,
      });
    });

    it('notifies subscribers reactively when reaction events arrive', () => {
      let notifiedCount = 0;
      let lastReactions = presenter.getReactionsForCurrentSlide();

      const unsubscribe = presenter.subscribe((state) => {
        notifiedCount++;
        lastReactions = state.reactions;
      });

      presenter.handleRealtimeEvent({
        id: 'evt-r-1',
        type: 'reaction.added',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          slideId: 'slide_0',
          reaction: '🤔',
        },
      });

      expect(notifiedCount).toBe(1);
      expect(lastReactions['🤔']).toBe(1);

      unsubscribe();
      presenter.receiveReaction('slide_0', '👍');
      expect(notifiedCount).toBe(1); // No further notifications after unsubscribe
    });
  });

  describe('SPEC-010: Contextual polls and presenter/projector synchronization', () => {
    it('loads authoritative poll summaries before revealing results', async () => {
      const summary = {
        pollId: 'poll-arch',
        slideId: 'slide_0',
        status: 'closed' as const,
        resultsRevealed: false,
        totalResponses: 2,
        countsByOptionId: { 'opt-yes': 1, 'opt-no': 1 },
        question: 'Which option?',
        type: 'binary' as const,
        options: [
          { id: 'opt-yes', label: 'Yes' },
          { id: 'opt-no', label: 'No' },
        ],
      };
      const fetchFn: typeof fetch = async () =>
        new Response(JSON.stringify({ activePolls: [summary] }), { status: 200 });

      expect(await presenter.loadPolls('https://api.agora.test/', 'presenter-token', fetchFn)).toBe(
        true,
      );
      expect(presenter.getPollResults('poll-arch')?.countsByOptionId['opt-yes']).toBe(1);
      expect(presenter.getPollsForSlide('slide_0')[0]?.id).toBe('poll-arch');
      expect(presenter.revealPollResults('poll-arch')).toBe(true);
      expect(presenter.getProjectorViewState().projectedPollResults?.totalResponses).toBe(2);
    });

    it('creates an empty authoritative summary when revealing before results load', () => {
      const poll = {
        id: 'poll-no-votes-yet',
        sessionId: 'sess_1',
        slideId: 'slide_0',
        question: 'Which option?',
        type: 'single' as const,
        options: [{ id: 'option-a', label: 'Option A' }],
        status: 'open' as const,
        resultsRevealed: false,
      };

      presenter.setPolls([poll]);
      expect(presenter.getPollResults(poll.id)).toBeNull();
      expect(presenter.revealPollResults(poll.id)).toBe(true);
      expect(presenter.getPollResults(poll.id)).toMatchObject({
        totalResponses: 0,
        countsByOptionId: { 'option-a': 0 },
        resultsRevealed: true,
      });
    });

    it('manages poll lifecycle (open, close, reveal) and synchronizes with projector', () => {
      const poll = {
        id: 'poll-arch',
        sessionId: 'sess_1',
        slideId: 'slide_0',
        question: 'Should we dive into Advanced Clean Architecture?',
        type: 'binary' as const,
        options: [
          { id: 'opt-yes', label: 'Yes, dive deep' },
          { id: 'opt-no', label: 'No, stay high-level' },
        ],
        status: 'draft' as const,
        resultsRevealed: false,
      };

      presenter.addPoll(poll);
      expect(presenter.getPollsForSlide('slide_0').length).toBe(1);
      expect(presenter.getActivePollForSlide('slide_0')?.status).toBe('draft');

      // 1. Initially unrevealed on projector
      const initialProjector = presenter.getProjectorViewState();
      expect(initialProjector.projectedPoll).toBeNull();
      expect(initialProjector.projectedPollResults).toBeNull();
      const initialProjHtml = renderProjectorViewHtml(initialProjector);
      expect(initialProjHtml).not.toContain('projector-poll-slide');

      // 2. Open poll on demand
      expect(presenter.openPoll('poll-arch')).toBe(true);
      expect(presenter.getActivePollForSlide('slide_0')?.status).toBe('open');
      const presenterStateOpen = presenter.getViewState();
      expect(presenterStateOpen.activePoll?.status).toBe('open');
      const presenterHtml = renderPresenterViewHtml(presenterStateOpen);
      expect(presenterHtml).toContain('Poll: Should we dive into Advanced Clean Architecture?');
      expect(presenterHtml).toContain('data-action="close-poll"');
      expect(presenterHtml).toContain('data-action="reveal-poll"');

      // 3. Receive vote in real-time
      presenter.handleRealtimeEvent({
        id: 'evt-poll-vote',
        type: 'poll.voted',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          pollId: 'poll-arch',
          totalResponses: 1,
        },
      });

      const resultsBeforeReveal = presenter.getPollResults('poll-arch');
      expect(resultsBeforeReveal?.totalResponses).toBe(1);
      expect(resultsBeforeReveal?.countsByOptionId['opt-yes']).toBe(0);

      // Still unrevealed on projector until presenter explicitly reveals
      expect(presenter.getProjectorViewState().projectedPollResults).toBeNull();

      // 4. Close poll
      expect(presenter.closePoll('poll-arch')).toBe(true);
      expect(presenter.getActivePollForSlide('slide_0')?.status).toBe('closed');

      // 5. Reveal poll results to projector
      presenter.setPolls(
        [poll],
        [
          {
            pollId: 'poll-arch',
            slideId: 'slide_0',
            status: 'closed',
            resultsRevealed: false,
            totalResponses: 1,
            countsByOptionId: { 'opt-yes': 1, 'opt-no': 0 },
            question: poll.question,
            type: poll.type,
            options: poll.options,
          },
        ],
      );
      expect(presenter.revealPollResults('poll-arch')).toBe(true);
      const revealedProjector = presenter.getProjectorViewState();
      expect(revealedProjector.projectedPoll?.id).toBe('poll-arch');
      expect(revealedProjector.projectedPollResults?.totalResponses).toBe(1);

      const revealedProjHtml = renderProjectorViewHtml(revealedProjector);
      expect(revealedProjHtml).toContain('projector-poll-slide');
      expect(revealedProjHtml).toContain('Should we dive into Advanced Clean Architecture?');
      expect(revealedProjHtml).toContain('Yes, dive deep');
      expect(revealedProjHtml).toContain('1 votes (100%)');
    });

    it('processes external realtime poll events (poll.opened, poll.closed, poll.results)', () => {
      let subscriberCallCount = 0;
      const unsubscribe = presenter.subscribe(() => {
        subscriberCallCount++;
      });

      // External open event
      presenter.handleRealtimeEvent({
        id: 'evt-po-1',
        type: 'poll.opened',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          id: 'poll-ext',
          slideId: 'slide_0',
          question: 'Do you prefer TypeScript or JavaScript?',
          type: 'single',
          options: [
            { id: 'opt-ts', label: 'TypeScript' },
            { id: 'opt-js', label: 'JavaScript' },
          ],
          status: 'open',
          resultsRevealed: false,
        },
      });

      expect(subscriberCallCount).toBe(1);
      const activePoll = presenter.getActivePollForSlide('slide_0');
      expect(activePoll?.id).toBe('poll-ext');
      expect(activePoll?.question).toBe('Do you prefer TypeScript or JavaScript?');

      // External results broadcast
      presenter.handleRealtimeEvent({
        id: 'evt-pr-1',
        type: 'poll.results',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          pollId: 'poll-ext',
          results: { 'opt-ts': 42, 'opt-js': 3 },
          totalVotes: 45,
          resultsRevealed: true,
        },
      });

      expect(subscriberCallCount).toBe(2);
      const projectorState = presenter.getProjectorViewState();
      expect(projectorState.projectedPollResults?.countsByOptionId['opt-ts']).toBe(42);

      // External close event
      presenter.handleRealtimeEvent({
        id: 'evt-pc-1',
        type: 'poll.closed',
        sessionId: 'sess_1',
        timestamp: new Date().toISOString(),
        payload: {
          pollId: 'poll-ext',
          status: 'closed',
        },
      });

      expect(subscriberCallCount).toBe(3);
      expect(presenter.getPollsForSlide('slide_0').find((p) => p.id === 'poll-ext')?.status).toBe(
        'closed',
      );

      unsubscribe();
    });
  });
});
