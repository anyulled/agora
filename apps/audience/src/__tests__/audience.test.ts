import type { AudienceSafeSessionView, SlideMetadata } from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudienceAppController, renderAudienceHtml } from '../index.js';

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
      expect(audience.getActiveSlide()?.title).toBe('Intro Slide');

      // Speaker moves to s2
      const nextView = createInitialView();
      nextView.session.currentSlideId = 's2';
      nextView.session.revealedSlideIds = ['s1', 's2'];
      audience.syncSessionView(nextView);

      expect(audience.getActiveSlide()?.id).toBe('s2');
      expect(audience.getActiveSlide()?.title).toBe('Architecture');
    });

    it('strictly guarantees that view model and HTML never contain slide deck body content (SPEC-004)', () => {
      const vm = audience.getViewModel();
      expect(vm.containsSlideBodyContent).toBe(false);

      const html = renderAudienceHtml(vm);
      expect(html).toContain('Intro Slide');
      expect(html).not.toContain('<div class="slides">');
      expect(html).not.toContain('<section class="slide-content">');
      expect(html).not.toContain('deck-body');
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
