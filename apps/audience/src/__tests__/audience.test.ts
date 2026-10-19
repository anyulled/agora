import type {
  AudienceSafeSessionView,
  RealtimeEvent,
  SlideMetadata,
  WebSocketLike,
} from '@agora/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudienceAppController,
  buildAudienceWebSocketUrl,
  computeBackoffDelayMs,
  renderAudienceHtml,
} from '../index.js';

describe('AudienceAppController (SPEC-004, SPEC-005, SPEC-006, SPEC-007, SPEC-009, SPEC-010, SPEC-014, SPEC-016, SPEC-021)', () => {
  let audience: AudienceAppController;

  const mockSlides: SlideMetadata[] = [
    {
      id: 's1',
      presentationId: 'p1',
      title: 'Intro Slide',
      horizontalIndex: 0,
      verticalIndex: 0,
      order: 0,
    },
    {
      id: 's2',
      presentationId: 'p1',
      title: 'Architecture',
      horizontalIndex: 1,
      verticalIndex: 0,
      order: 1,
    },
    {
      id: 's3_skipped',
      presentationId: 'p1',
      title: 'Skipped Branch',
      horizontalIndex: 2,
      verticalIndex: 0,
      order: 2,
    },
    {
      id: 's4',
      presentationId: 'p1',
      title: 'Conclusion',
      horizontalIndex: 3,
      verticalIndex: 0,
      order: 3,
    },
  ];

  const createInitialView = (): AudienceSafeSessionView => ({
    session: {
      id: 'sess_123',
      presentationId: 'p1',
      presentationRevision: 'rev_1',
      status: 'live',
      currentSlideId: 's1',
      revealedSlideIds: ['s1'],
      pdfDownloadUnlocked: false,
    },
    slides: mockSlides,
    availablePngSlideIds: ['s1'],
    pdfAvailable: true,
    questions: [],
    activePolls: [],
    activeWordClouds: [],
    reactionSummary: {
      s1: { '👍': 5, '🤔': 1, '❤️': 3, '😴': 0 },
    },
  });

  beforeEach(() => {
    audience = new AudienceAppController('sess_123');
    audience.syncSessionView(createInitialView());
  });

  describe('Anonymous Session Join & Reconnect State Sync (SPEC-002, SPEC-019)', () => {
    it('initializes anonymous participant identity and syncs session state', () => {
      const participant = audience.getParticipant();
      expect(participant.id).toMatch(/^p_/);
      expect(participant.sessionId).toBe('sess_123');
      expect(participant.token).toMatch(/^tok_/);

      const vm = audience.getViewModel();
      expect(vm.connected).toBe(true);
      expect(vm.activeSlide?.id).toBe('s1');
      expect(vm.totalRevealedSlides).toBe(1);
      expect(vm.totalPresentationSlides).toBe(4);
    });

    it('resynchronizes state when reconnecting without resetting participant token', () => {
      const origParticipant = audience.getParticipant();
      audience.setConnectionStatus(false);
      expect(audience.getViewModel().connected).toBe(false);

      // Reconnect with new session view where speaker navigated to s2
      const updatedView = createInitialView();
      updatedView.session.currentSlideId = 's2';
      updatedView.session.revealedSlideIds = ['s1', 's2'];
      updatedView.availablePngSlideIds = ['s1', 's2'];

      audience.syncSessionView(updatedView);

      expect(audience.getParticipant().token).toBe(origParticipant.token);
      expect(audience.getViewModel().connected).toBe(true);
      expect(audience.getViewModel().activeSlide?.id).toBe('s2');
      expect(audience.getViewModel().totalRevealedSlides).toBe(2);
    });
  });

  describe('Follow Mode & No Slide Content Leakage (SPEC-004)', () => {
    it('defaults to Follow mode, tracking speaker slide in real time', () => {
      expect(audience.getMode()).toBe('follow');
      expect(audience.isFollowing()).toBe(true);
      expect(audience.getActiveSlide()?.title).toBe('Intro Slide');

      // Speaker moves to s2
      const nextView = createInitialView();
      nextView.session.currentSlideId = 's2';
      nextView.session.revealedSlideIds = ['s1', 's2'];
      audience.syncSessionView(nextView);

      expect(audience.getActiveSlide()?.id).toBe('s2');
      expect(audience.getActiveSlide()?.title).toBe('Architecture');
    });

    it('updates view in real time upon receiving slide.changed real-time WebSocket event', () => {
      const event: RealtimeEvent = {
        id: 'evt-slide-change-1',
        type: 'slide.changed',
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
        payload: {
          slideId: 's2',
          horizontalIndex: 1,
          verticalIndex: 0,
          timestamp: new Date().toISOString(),
          revealedSlideIds: ['s1', 's2'],
        },
      };

      audience.handleRealtimeEvent(event);

      expect(audience.getActiveSlideId()).toBe('s2');
      expect(audience.getActiveSlide()?.title).toBe('Architecture');
      const vm = audience.getViewModel();
      expect(vm.activeSlide?.id).toBe('s2');
      expect(vm.totalRevealedSlides).toBe(2);
      expect(vm.positionIndicator).toBe('Slide 2 of 4');
    });

    it('dispatches reactive subscriber updates immediately on slide.changed and session.state events', () => {
      const recordedSlideIds: (string | undefined)[] = [];
      const unsubscribe = audience.subscribe((vm) => {
        recordedSlideIds.push(vm.activeSlide?.id);
      });

      // Initial subscription notification
      expect(recordedSlideIds).toEqual(['s1']);

      // Raw WebSocket frame arrival
      audience.handleMessage(
        JSON.stringify({
          id: 'evt-2',
          type: 'slide.changed',
          sessionId: 'sess_123',
          payload: {
            slideId: 's2',
            horizontalIndex: 1,
            verticalIndex: 0,
            revealedSlideIds: ['s1', 's2'],
          },
        }),
      );

      expect(recordedSlideIds).toEqual(['s1', 's2']);

      // session.state snapshot event
      audience.handleRealtimeEvent({
        id: 'evt-3',
        type: 'session.state',
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
        payload: {
          currentSlideId: 's4',
          revealedSlideIds: ['s1', 's2', 's4'],
          pdfDownloadUnlocked: true,
        },
      });

      expect(recordedSlideIds).toEqual(['s1', 's2', 's4']);

      // Unsubscribe stops future notifications
      unsubscribe();
      audience.handleMessage(
        JSON.stringify({
          id: 'evt-4',
          type: 'slide.changed',
          sessionId: 'sess_123',
          payload: { slideId: 's1', horizontalIndex: 0, verticalIndex: 0 },
        }),
      );

      expect(recordedSlideIds).toEqual(['s1', 's2', 's4']);
    });

    it('formats and displays slide title and slide position indicator (e.g. Slide 12 of 45)', () => {
      // 1. Position indicator on current 4-slide deck
      const vm1 = audience.getViewModel();
      expect(vm1.positionIndicator).toBe('Slide 1 of 4');

      // 2. Large 45-slide presentation test case matching acceptance criteria explicitly
      const largeSlides: SlideMetadata[] = Array.from({ length: 45 }, (_, idx) => ({
        id: `slide_${idx + 1}`,
        presentationId: 'p_large',
        title: `Topic Chapter ${idx + 1}`,
        horizontalIndex: idx,
        verticalIndex: 0,
        order: idx,
      }));

      const largeAudience = new AudienceAppController('sess_large');
      largeAudience.syncSessionView({
        session: {
          id: 'sess_large',
          presentationId: 'p_large',
          presentationRevision: 'rev_1',
          status: 'live',
          currentSlideId: 'slide_12',
          revealedSlideIds: Array.from({ length: 12 }, (_, i) => `slide_${i + 1}`),
          pdfDownloadUnlocked: false,
        },
        slides: largeSlides,
        availablePngSlideIds: ['slide_12'],
        pdfAvailable: true,
        questions: [],
        activePolls: [],
        activeWordClouds: [],
        reactionSummary: {},
      });

      const largeVm = largeAudience.getViewModel();
      expect(largeVm.positionIndicator).toBe('Slide 12 of 45');
      expect(largeVm.activeSlide?.title).toBe('Topic Chapter 12');

      const html = renderAudienceHtml(largeVm);
      expect(html).toContain('Slide 12 of 45');
      expect(html).toContain('Topic Chapter 12');
      expect(html).toContain(
        '<p class="slide-position-indicator" aria-label="Slide position">Slide 12 of 45</p>',
      );
      expect(html).toContain('Following Speaker');
    });

    it('strictly guarantees that view model and HTML never contain slide deck body content (SPEC-004)', () => {
      const vm = audience.getViewModel();
      expect(vm.containsSlideBodyContent).toBe(false);

      const html = renderAudienceHtml(vm);
      expect(html).toContain('Intro Slide');
      expect(html).not.toContain('<div class="slides">');
      expect(html).not.toContain('<section class="slide-content">');
      expect(html).not.toContain('deck-body');
      expect(html).not.toContain('<canvas');
      expect(html).not.toContain('data-fragment');
      expect(html).not.toContain('<markdown>');
    });

    it('renders contextual interaction controls: Ask Question form, Emoji Reactions, and Download controls', () => {
      const vm = audience.getViewModel();
      const html = renderAudienceHtml(vm);

      // Question Form
      expect(html).toContain('Ask a Question');
      expect(html).toContain('data-action="submit-question"');
      expect(html).toContain('aria-label="Question text"');

      // Emoji Reactions Bar
      expect(html).toContain('aria-label="Emoji Reactions"');
      expect(html).toContain('data-reaction="👍"');
      expect(html).toContain('data-reaction="🤔"');
      expect(html).toContain('data-reaction="❤️"');
      expect(html).toContain('data-reaction="😴"');

      // Downloads Bar
      expect(html).toContain('Slide & Deck Downloads');
      expect(html).toContain('Download Slide PNG');
      expect(html).toContain('Deck PDF Locked');
    });

    it('manages WebSocket connection and auto-reconnect backoff (SPEC-004, SPEC-019)', async () => {
      expect(buildAudienceWebSocketUrl('https://api.agora.test', 'sess_1', 'tok_abc')).toBe(
        'wss://api.agora.test/api/v1/sessions/sess_1/ws?token=tok_abc',
      );
      expect(buildAudienceWebSocketUrl('http://localhost:8787', 'sess_2')).toBe(
        'ws://localhost:8787/api/v1/sessions/sess_2/ws',
      );

      expect(computeBackoffDelayMs(0, 1000, 30000)).toBe(1000);
      expect(computeBackoffDelayMs(1, 1000, 30000)).toBe(2000);
      expect(computeBackoffDelayMs(2, 1000, 30000)).toBe(4000);
      expect(computeBackoffDelayMs(15, 1000, 30000)).toBe(30000);

      // WebSocket mock connection
      let socketInstance: WebSocketLike | null = null;
      const mockFactory = (_url: string): WebSocketLike => {
        const sock: WebSocketLike = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        };
        socketInstance = sock;
        return sock;
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...createInitialView(),
          session: {
            ...createInitialView().session,
            currentSlideId: 's2',
            revealedSlideIds: ['s1', 's2'],
          },
        }),
      });

      audience.connectWebSocket({
        sessionId: 'sess_123',
        endpoint: 'https://api.agora.test',
        webSocketFactory: mockFactory,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(socketInstance).not.toBeNull();
      const currentSocket = socketInstance as unknown as WebSocketLike;

      // Trigger socket onopen -> refreshes session state immediately
      await currentSocket.onopen?.({});
      expect(mockFetch).toHaveBeenCalledWith('https://api.agora.test/api/v1/sessions/sess_123');
      expect(audience.getActiveSlideId()).toBe('s2');
      expect(audience.getViewModel().connected).toBe(true);

      // Simulate disconnect
      currentSocket.onclose?.({});
      expect(audience.getViewModel().connected).toBe(false);

      audience.disconnect();
      expect(audience.getViewModel().connected).toBe(false);
    });
  });

  describe('Solo Mode Navigation (SPEC-005)', () => {
    beforeEach(() => {
      // Simulate speaker revealing s1, s2, and s4 (skipping s3_skipped)
      const view = createInitialView();
      view.session.currentSlideId = 's4';
      view.session.revealedSlideIds = ['s1', 's2', 's4'];
      view.availablePngSlideIds = ['s1', 's2', 's4'];
      audience.syncSessionView(view);
    });

    it('browses ONLY revealed slides in presentation order, keeping skipped slides locked', () => {
      audience.setMode('solo');
      expect(audience.getMode()).toBe('solo');

      // Starts at s4 (or revealed slide)
      expect(audience.getActiveSlideId()).toBe('s4');

      // Prev navigates to s2 (skipping s3_skipped)
      expect(audience.canNavigateSoloPrev()).toBe(true);
      expect(audience.soloPrevious()).toBe(true);
      expect(audience.getActiveSlideId()).toBe('s2');

      // Prev navigates to s1
      expect(audience.soloPrevious()).toBe(true);
      expect(audience.getActiveSlideId()).toBe('s1');

      // Cannot go prev past first revealed slide
      expect(audience.canNavigateSoloPrev()).toBe(false);
      expect(audience.soloPrevious()).toBe(false);

      // Next navigates to s2 and then s4 directly (s3 is NEVER visited)
      expect(audience.soloNext()).toBe(true);
      expect(audience.getActiveSlideId()).toBe('s2');
      expect(audience.soloNext()).toBe(true);
      expect(audience.getActiveSlideId()).toBe('s4');
      expect(audience.canNavigateSoloNext()).toBe(false);
    });

    it('returns revealed slides strictly in presentation order via getSoloNavigableSlides()', () => {
      const soloSlides = audience.getSoloNavigableSlides();
      expect(soloSlides.map((s) => s.id)).toEqual(['s1', 's2', 's4']);
      expect(soloSlides.some((s) => s.id === 's3_skipped')).toBe(false);
    });

    it('allows jumping directly to a revealed slide via soloGoToSlide() while rejecting unrevealed slides', () => {
      expect(audience.getMode()).toBe('follow');

      // Jumping to revealed s2 switches to solo mode and sets active slide
      const jumpSuccess = audience.soloGoToSlide('s2');
      expect(jumpSuccess).toBe(true);
      expect(audience.getMode()).toBe('solo');
      expect(audience.getActiveSlideId()).toBe('s2');

      // Attempting to jump to unrevealed slide fails and keeps current solo slide
      const unrevealedJump = audience.soloGoToSlide('s3_skipped');
      expect(unrevealedJump).toBe(false);
      expect(audience.getActiveSlideId()).toBe('s2');

      // Non-existent slide fails
      expect(audience.soloGoToSlide('non_existent')).toBe(false);
    });

    it('switching to Solo mode does not affect speaker, and returning to Follow immediately snaps to current speaker slide', () => {
      audience.setMode('solo');
      audience.soloPrevious(); // on s2

      expect(audience.getActiveSlideId()).toBe('s2');

      // Switching back to follow snaps to speaker's position s4
      audience.setMode('follow');
      expect(audience.getActiveSlideId()).toBe('s4');
    });

    it('revealed slides remain accessible forever in Solo mode even if speaker backtracks', () => {
      audience.setMode('solo');
      expect(audience.getActiveSlideId()).toBe('s4');

      // Speaker backtracks to s1
      const backtrackedView = createInitialView();
      backtrackedView.session.currentSlideId = 's1';
      backtrackedView.session.revealedSlideIds = ['s1', 's2', 's4']; // revealed set stays
      audience.syncSessionView(backtrackedView);

      // In Solo mode, participant is still able to view s4
      expect(audience.getActiveSlideId()).toBe('s4');
      expect(audience.canNavigateSoloPrev()).toBe(true);
    });

    it('does not hijack the solo attendee slide when speaker advances while attendee is in solo mode', () => {
      audience.setMode('solo');
      audience.soloGoToSlide('s1');
      expect(audience.getActiveSlideId()).toBe('s1');

      // Speaker advances to a new slide in real time via WebSocket event
      audience.handleRealtimeEvent({
        id: 'evt-speaker-advance',
        type: 'slide.changed',
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
        payload: {
          slideId: 's4',
          horizontalIndex: 3,
          verticalIndex: 0,
          revealedSlideIds: ['s1', 's2', 's4'],
        },
      });

      // Attendee remains on s1 undisturbed
      expect(audience.getActiveSlideId()).toBe('s1');
      expect(audience.getMode()).toBe('solo');

      // Returning to follow mode snaps to the speaker's active slide s4
      audience.setMode('follow');
      expect(audience.getActiveSlideId()).toBe('s4');
    });

    it('anchors questions, emoji reactions, and PNG downloads to the solo-viewed slide (SPEC-005, SPEC-006, SPEC-009, SPEC-014)', () => {
      audience.setMode('solo');
      audience.soloGoToSlide('s1');

      // Question submitted in solo mode references s1
      const q = audience.submitQuestion('Question specifically about slide 1');
      expect(q.slideId).toBe('s1');

      // Emoji reaction in solo mode targets s1
      audience.sendReaction('👍');
      const reactions = audience.getReactionsForActiveSlide();
      expect(reactions['👍']).toBe(6); // 5 initial + 1 new

      // PNG download url targets s1
      expect(audience.canDownloadCurrentSlidePng()).toBe(true);
      expect(audience.getSlidePngDownloadUrl()).toBe(
        '/api/sessions/sess_123/slides/s1/download-png',
      );
    });

    it('renders accessible HTML controls and indicators for Solo mode', () => {
      audience.setMode('solo');
      audience.soloGoToSlide('s2');

      const vm = audience.getViewModel();
      expect(vm.mode).toBe('solo');
      expect(vm.canNavigateSoloPrev).toBe(true);
      expect(vm.canNavigateSoloNext).toBe(true);
      expect(vm.totalRevealedSlides).toBe(3);

      const html = renderAudienceHtml(vm);
      expect(html).toContain('class="audience-app mode-solo"');
      expect(html).toContain('aria-label="Solo slide navigation"');
      expect(html).toContain('data-action="solo-prev"');
      expect(html).toContain('data-action="solo-next"');
      expect(html).toContain('Solo Browsing (Slide 2 of 3)');
    });
  });

  describe('Questions and Upvoting (SPEC-006, SPEC-007)', () => {
    it('submits a slide-scoped question and lists it sorted by votes', () => {
      audience.submitQuestion('How is state synchronized?', 'Alice');
      audience.submitQuestion('What about offline support?', 'Bob');

      const questions = audience.getQuestionsForActiveSlide();
      expect(questions).toHaveLength(2);
      expect(questions[0]?.content).toBe('How is state synchronized?');
      expect(questions[0]?.participantName).toBe('Alice');
      expect(questions[0]?.upvotes).toBe(0);
    });

    it('enforces one upvote per participant and allows retracting (SPEC-007)', () => {
      const q = audience.submitQuestion('Can we use WebSockets?', 'Carol');

      // First upvote
      audience.toggleUpvoteQuestion(q.id);
      expect(q.upvotes).toBe(1);
      expect(q.upvotedByParticipantIds).toContain(audience.getParticipant().id);

      // Second call retracts upvote
      audience.toggleUpvoteQuestion(q.id);
      expect(q.upvotes).toBe(0);
      expect(q.upvotedByParticipantIds).not.toContain(audience.getParticipant().id);

      // Third call upvotes again
      audience.toggleUpvoteQuestion(q.id);
      expect(q.upvotes).toBe(1);
    });

    it('rejects empty question content', () => {
      expect(() => audience.submitQuestion('')).toThrow('Question content cannot be empty');
      expect(() => audience.submitQuestion('   ')).toThrow('Question content cannot be empty');
    });

    it('submits question to API via submitQuestionToApi and updates reactive listeners (SPEC-006)', async () => {
      const mockFetch = async (url: string, init?: RequestInit) => {
        expect(url).toContain('/api/v1/sessions/sess_123/questions');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.slideId).toBe('s1');
        expect(body.content).toBe('How is hydration handled?');
        expect(body.participantName).toBe('David');

        return new Response(
          JSON.stringify({
            id: 'q-api-1',
            sessionId: 'sess_123',
            slideId: 's1',
            participantId: audience.getParticipant().id,
            participantName: 'David',
            content: 'How is hydration handled?',
            status: 'pending',
            upvotes: 0,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      };

      audience.connectWebSocket({
        sessionId: 'sess_123',
        endpoint: 'https://api.agora.test',
        fetchFn: mockFetch as unknown as typeof fetch,
        webSocketFactory: () => ({ send: () => {}, close: () => {} }),
      });

      const q = await audience.submitQuestionToApi('How is hydration handled?', 'David');
      expect(q.id).toBe('q-api-1');
      expect(q.content).toBe('How is hydration handled?');

      const vm = audience.getViewModel();
      expect(vm.questions.some((item) => item.id === 'q-api-1')).toBe(true);
    });

    it('handles real-time question.submitted and question.updated events (SPEC-006)', () => {
      let notifiedCount = 0;
      audience.subscribe(() => {
        notifiedCount += 1;
      });

      const initialCount = notifiedCount;

      // Broadcast question.submitted on active slide s1
      audience.handleRealtimeEvent({
        id: 'evt-q-sub',
        type: 'question.submitted',
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
        payload: {
          id: 'q-live-1',
          sessionId: 'sess_123',
          slideId: 's1',
          participantId: 'p-remote',
          participantName: 'Remote User',
          content: 'Is SQLite embedded?',
          status: 'pending',
          upvotes: 0,
          createdAt: new Date().toISOString(),
        },
      });

      expect(notifiedCount).toBeGreaterThan(initialCount);
      let found = audience.getViewModel().questions.find((q) => q.id === 'q-live-1');
      expect(found).toBeDefined();
      expect(found?.status).toBe('pending');

      // Broadcast question.updated (marked answered by presenter)
      audience.handleRealtimeEvent({
        id: 'evt-q-upd',
        type: 'question.updated',
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
        payload: {
          ...found!,
          status: 'answered',
        },
      });

      found = audience.getViewModel().questions.find((q) => q.id === 'q-live-1');
      expect(found?.status).toBe('answered');
    });
  });

  describe('Emoji Reactions (SPEC-009)', () => {
    it('increments allowed reactions for the active slide and rejects invalid reactions', () => {
      audience.sendReaction('👍');
      audience.sendReaction('👍');
      audience.sendReaction('❤️');

      const reactions = audience.getReactionsForActiveSlide();
      expect(reactions['👍']).toBe(7); // 5 initial + 2 new
      expect(reactions['❤️']).toBe(4); // 3 initial + 1 new

      // @ts-expect-error test invalid emoji
      expect(() => audience.sendReaction('🔥')).toThrow(/Invalid reaction/);
    });
  });

  describe('Polls and Word Clouds (SPEC-010, SPEC-021)', () => {
    it('allows voting in open contextual polls', () => {
      const view = createInitialView();
      view.activePolls = [
        {
          pollId: 'poll_1',
          slideId: 's1',
          status: 'open',
          resultsRevealed: false,
          totalResponses: 10,
          countsByOptionId: { opt_a: 6, opt_b: 4 },
        },
      ];
      audience.syncSessionView(view);

      audience.submitPollVote('poll_1', ['opt_a']);
      const activePoll = audience.getActivePollForCurrentSlide();
      expect(activePoll?.countsByOptionId.opt_a).toBe(7);
      expect(activePoll?.totalResponses).toBe(11);
    });

    it('submits normalized word cloud terms for active prompts', () => {
      const view = createInitialView();
      view.activeWordClouds = [
        {
          promptId: 'wc_1',
          slideId: 's1',
          status: 'open',
          totalSubmissions: 3,
          terms: [{ term: 'latency', count: 3 }],
        },
      ];
      audience.syncSessionView(view);

      audience.submitWordCloudTerm('wc_1', '  LATENCY  ');
      const activeWc = audience.getActiveWordCloudForCurrentSlide();
      expect(activeWc?.totalSubmissions).toBe(4);
      expect(activeWc?.terms[0]?.count).toBe(4);
    });
  });

  describe('Asset Downloads Access Control (SPEC-014, SPEC-016)', () => {
    it('allows slide PNG download only if revealed and asset is available', () => {
      // On s1: revealed and available
      expect(audience.canDownloadCurrentSlidePng()).toBe(true);
      expect(audience.getSlidePngDownloadUrl()).toContain('download-png');

      // Switch to unrevealed slide s3_skipped in solo mode (simulate state)
      const view = createInitialView();
      view.session.revealedSlideIds = ['s1'];
      view.availablePngSlideIds = ['s1'];
      audience.syncSessionView(view);

      expect(audience.getSlidePngDownloadUrl('s3_skipped')).toBeNull();
    });

    it('locks full PDF download until session unlock and PDF availability are satisfied (SPEC-016)', () => {
      // Initially locked
      expect(audience.canDownloadDeckPdf()).toBe(false);
      expect(audience.getDeckPdfDownloadUrl()).toBeNull();

      // Speaker visits ending slide, unlocking PDF download
      const unlockedView = createInitialView();
      unlockedView.session.pdfDownloadUnlocked = true;
      unlockedView.pdfAvailable = true;
      audience.syncSessionView(unlockedView);

      expect(audience.canDownloadDeckPdf()).toBe(true);
      expect(audience.getDeckPdfDownloadUrl()).toContain('/download-pdf');
    });
  });

  describe('Accessible HTML View-Model Renderer', () => {
    it('renders accessible controls and buttons with aria tags', () => {
      const html = renderAudienceHtml(audience.getViewModel());
      expect(html).toContain('role="group" aria-label="Mode switcher"');
      expect(html).toContain('aria-label="Emoji Reactions"');
      expect(html).toContain('aria-label="Audience Q&A"');
      expect(html).toContain('Follow Speaker');
    });
  });
});
