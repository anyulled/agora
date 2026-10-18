import type { AssetManifestEntry, NavigationRule, SlideMetadata } from '@agora/contracts';
import { describe, expect, it } from 'vitest';
import { AgoraPlatformService } from '../index.js';

describe('AgoraPlatformService — End-to-End Workflows', () => {
  const slides: SlideMetadata[] = [
    {
      id: 'slide-intro',
      presentationId: 'pres-app-1',
      title: 'Introduction',
      horizontalIndex: 0,
      verticalIndex: 0,
      order: 0,
    },
    {
      id: 'slide-arch',
      presentationId: 'pres-app-1',
      title: 'Architecture & DOs',
      horizontalIndex: 1,
      verticalIndex: 0,
      order: 1,
    },
    {
      id: 'slide-adaptive',
      presentationId: 'pres-app-1',
      title: 'Deep Dive on Durable Objects',
      horizontalIndex: 2,
      verticalIndex: 0,
      order: 2,
    },
    {
      id: 'slide-conclusion',
      presentationId: 'pres-app-1',
      title: 'Conclusion & Ending',
      horizontalIndex: 3,
      verticalIndex: 0,
      order: 3,
      isQaSlide: true,
    },
  ];

  function createTestService(): AgoraPlatformService {
    return new AgoraPlatformService({
      rateLimiterOptions: {
        questions: { windowMs: 1000, maxRequests: 2 },
        reactions: { windowMs: 1000, maxRequests: 5 },
        wordClouds: { windowMs: 1000, maxRequests: 2 },
      },
    });
  }

  describe('Admin Presentation CRUD & Duplication', () => {
    it('creates, retrieves, updates, publishes, and deletes presentation', () => {
      const service = createTestService();

      const created = service.createPresentation({
        id: 'pres-app-1',
        title: 'Edge Architectures',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      expect(created.id).toBe('pres-app-1');
      expect(created.status).toBe('draft');
      expect(created.revision).toBe('rev-1');

      const retrieved = service.getPresentation('pres-app-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.slides).toHaveLength(4);
      expect(retrieved?.assetManifest?.revision).toBe('rev-1');

      const updated = service.updatePresentation({
        ...created,
        title: 'Updated Edge Architectures',
      });
      expect(updated.title).toBe('Updated Edge Architectures');

      const published = service.publishPresentation('pres-app-1');
      expect(published.status).toBe('published');

      const deleted = service.deletePresentation('pres-app-1');
      expect(deleted).toBe(true);
      expect(service.getPresentation('pres-app-1')).toBeNull();
    });

    it('duplicates presentation into an independent presentation with fresh revision and empty sessions (SPEC-001, SPEC-017)', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      const duplicated = service.duplicatePresentation(
        'pres-app-1',
        'pres-app-2',
        'Duplicated Custom Deck',
      );

      expect(duplicated.presentation.id).toBe('pres-app-2');
      expect(duplicated.presentation.title).toBe('Duplicated Custom Deck');
      expect(duplicated.presentation.revision).toBe('rev-1');
      expect(duplicated.presentation.status).toBe('draft');
      expect(duplicated.slides[0]?.presentationId).toBe('pres-app-2');

      const retrieved = service.getPresentation('pres-app-2');
      expect(retrieved?.presentation.id).toBe('pres-app-2');
      expect(retrieved?.assetManifest?.slidePngs).toEqual({});
    });

    it('editing slide bumps presentation revision and invalidates stale assets (SPEC-001, SPEC-013, SPEC-015)', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      // Register an asset for rev-1
      const pngEntry: AssetManifestEntry = {
        assetId: 'asset-slide-1',
        presentationId: 'pres-app-1',
        revision: 'rev-1',
        kind: 'slide-png',
        slideId: 'slide-intro',
        r2Key: 'r2/pngs/slide-intro.png',
        contentType: 'image/png',
        byteSize: 2048,
        createdAt: '2026-10-18T10:00:00.000Z',
      };
      service.registerAsset('pres-app-1', pngEntry);

      const beforeEdit = service.getPresentation('pres-app-1');
      expect(beforeEdit?.assetManifest?.slidePngs['slide-intro']).toBeDefined();

      // Edit slide
      const editResult = service.editSlide('pres-app-1', {
        ...slides[0]!,
        title: 'New Introduction Title',
      });

      expect(editResult.presentation.revision).toBe('rev-2');
      expect(editResult.assetManifest.revision).toBe('rev-2');
      // Previous PNG is invalidated!
      expect(editResult.assetManifest.slidePngs['slide-intro']).toBeUndefined();
    });
  });

  describe('Asset Registration & Native PDF Validation (SPEC-013, SPEC-015, SPEC-024)', () => {
    it('rejects registering asset if revision does not match presentation revision', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      const staleEntry: AssetManifestEntry = {
        assetId: 'asset-stale',
        presentationId: 'pres-app-1',
        revision: 'rev-99',
        kind: 'slide-png',
        slideId: 'slide-intro',
        r2Key: 'r2/stale.png',
        contentType: 'image/png',
        byteSize: 100,
        createdAt: '2026-10-18T10:00:00.000Z',
      };

      expect(() => service.registerAsset('pres-app-1', staleEntry)).toThrow(
        "Asset revision 'rev-99' does not match current presentation revision 'rev-1'",
      );
    });

    it('rejects registering PDF export if pdfSeparateFragments is true (SPEC-015)', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      const pdfEntry: AssetManifestEntry = {
        assetId: 'asset-pdf-1',
        presentationId: 'pres-app-1',
        revision: 'rev-1',
        kind: 'deck-pdf',
        r2Key: 'r2/deck.pdf',
        contentType: 'application/pdf',
        byteSize: 50000,
        createdAt: '2026-10-18T10:00:00.000Z',
      };

      // When exported with separate fragments -> REJECT
      expect(() =>
        service.registerAsset('pres-app-1', pdfEntry, { pdfSeparateFragments: true }),
      ).toThrow('PDF export must be produced with pdfSeparateFragments: false (SPEC-015)');

      // When exported without separate fragments -> ACCEPT
      const manifest = service.registerAsset('pres-app-1', pdfEntry, {
        pdfSeparateFragments: false,
      });
      expect(manifest.deckPdf?.assetId).toBe('asset-pdf-1');
    });
  });

  describe('Session Lifecycle, Authoritative Navigation, and Event Emission', () => {
    it('creates live session, tracks presenter navigation, and unlocks PDF on ending slide (SPEC-002, SPEC-016, SPEC-022)', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      // Attendee cannot create session
      expect(() =>
        service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'attendee'),
      ).toThrow('Unauthorized');

      const session = service.createSession(
        'pres-app-1',
        'sess-1',
        'https://agora.live',
        'presenter',
      );
      expect(session.status).toBe('live');
      expect(session.pdfDownloadUnlocked).toBe(false);

      // Attendee cannot navigate presenter slide
      expect(() => service.navigateSlide('sess-1', 'slide-intro', 'attendee')).toThrow(
        'Unauthorized: attendee cannot navigate presenter slide',
      );

      // Presenter navigates to slide-intro
      const s1 = service.navigateSlide('sess-1', 'slide-intro', 'presenter');
      expect(s1.currentSlideId).toBe('slide-intro');
      expect(s1.revealedSlideIds).toEqual(['slide-intro']);
      expect(s1.pdfDownloadUnlocked).toBe(false);

      // Presenter reaches ending slide -> permanently unlocks PDF without completing session
      const sEnding = service.navigateSlide('sess-1', 'slide-conclusion', 'presenter');
      expect(sEnding.currentSlideId).toBe('slide-conclusion');
      expect(sEnding.pdfDownloadUnlocked).toBe(true);
      expect(sEnding.status).toBe('live'); // still live!

      // Explicitly complete session
      expect(() => service.completeSession('sess-1', 'attendee')).toThrow('Unauthorized');
      const completed = service.completeSession('sess-1', 'presenter');
      expect(completed.status).toBe('completed');

      // Cannot navigate once completed
      expect(() => service.navigateSlide('sess-1', 'slide-intro', 'presenter')).toThrow(
        'Cannot navigate completed session',
      );
    });

    it('emits real-time events for session state and slide transitions', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      const events: string[] = [];
      const unsubscribe = service.subscribe((evt) => {
        events.push(evt.type);
      });

      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');
      service.navigateSlide('sess-1', 'slide-intro', 'presenter');
      service.navigateSlide('sess-1', 'slide-conclusion', 'presenter');

      expect(events).toContain('session.state');
      expect(events).toContain('slide.changed');
      expect(events).toContain('presentation.download.unlocked');

      unsubscribe();
      // Emitting after unsubscribe does not call listener
      service.completeSession('sess-1', 'presenter');
      expect(events).not.toContain('session.completed'); // Not pushed to events array
    });
  });

  describe('Anonymous Join, Follow/Solo Validation & Safe View (SPEC-002, SPEC-004, SPEC-005, SPEC-018)', () => {
    it('joins session anonymously with opaque token and increments participant count', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      const participant = service.joinSession('sess-1', '<b>Bob</b>');
      expect(participant.id).toMatch(/^part_/);
      expect(participant.token).toMatch(/^tok_/);
      expect(participant.displayName).toBe('Bob');

      const session = service.getSession('sess-1');
      expect(session?.connectedParticipants).toBe(1);
    });

    it('validates slide access strictly in Follow and Solo modes', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      service.navigateSlide('sess-1', 'slide-intro', 'presenter');

      // In Follow mode, only currentSlideId is accessible
      expect(service.validateSlideAccess('sess-1', 'slide-intro', 'follow')).toBe(true);
      expect(service.validateSlideAccess('sess-1', 'slide-arch', 'follow')).toBe(false);

      // Presenter moves to slide-arch
      service.navigateSlide('sess-1', 'slide-arch', 'presenter');

      // In Solo mode, all previously revealed slides are accessible
      expect(service.validateSlideAccess('sess-1', 'slide-intro', 'solo')).toBe(true);
      expect(service.validateSlideAccess('sess-1', 'slide-arch', 'solo')).toBe(true);
      // Unrevealed slide is inaccessible
      expect(service.validateSlideAccess('sess-1', 'slide-conclusion', 'solo')).toBe(false);
    });

    it('generates audience safe session view', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      const safeView = service.getAudienceSafeView('sess-1');
      expect(safeView.session.id).toBe('sess-1');
      expect(safeView.slides).toHaveLength(4);
      expect(safeView.pdfAvailable).toBe(false);
      expect(safeView.availablePngSlideIds).toEqual([]);
    });
  });

  describe('Q&A Workflow, Moderation, Upvoting and Rate Limiting (SPEC-006, SPEC-007, SPEC-008, SPEC-018)', () => {
    it('submits, upvotes, moderates, and sorts questions', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');
      service.navigateSlide('sess-1', 'slide-intro', 'presenter');

      // Cannot submit on unrevealed slide
      expect(() =>
        service.submitQuestion('sess-1', 'part-1', 'slide-arch', 'Can we scale?'),
      ).toThrow('Cannot submit questions on unrevealed slide');

      // Submit on revealed slide
      const q1 = service.submitQuestion(
        'sess-1',
        'part-1',
        'slide-intro',
        '<script>bad()</script>How does SQLite in DO work?',
        '<i>Alice</i>',
      );
      expect(q1.content).toBe('How does SQLite in DO work?');
      expect(q1.participantName).toBe('Alice');
      expect(q1.status).toBe('pending');
      expect(q1.upvotes).toBe(0);

      // Upvote by participant 2
      const upvoted = service.upvoteQuestion('sess-1', q1.id, 'part-2');
      expect(upvoted.upvotes).toBe(1);

      // Upvote again by participant 2 retracts
      const retracted = service.upvoteQuestion('sess-1', q1.id, 'part-2');
      expect(retracted.upvotes).toBe(0);

      // Attendee cannot moderate
      expect(() => service.moderateQuestion('sess-1', q1.id, 'answered', 'attendee')).toThrow(
        'Unauthorized: only presenter or admin may moderate questions',
      );

      // Presenter marks answered
      const moderated = service.moderateQuestion('sess-1', q1.id, 'answered', 'presenter');
      expect(moderated.status).toBe('answered');

      // Rate limit test: max 2 requests per second
      service.submitQuestion('sess-1', 'part-1', 'slide-intro', 'Second question');
      expect(() =>
        service.submitQuestion('sess-1', 'part-1', 'slide-intro', 'Third question should fail'),
      ).toThrow('Rate limit exceeded for submitting questions');
    });
  });

  describe('Emoji Reactions & Summary (SPEC-009, SPEC-018)', () => {
    it('records reactions and updates summary per slide', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      const s1 = service.recordReaction('sess-1', 'part-1', 'slide-intro', '👍');
      expect(s1['👍']).toBe(1);

      const s2 = service.recordReaction('sess-1', 'part-2', 'slide-intro', '👍');
      expect(s2['👍']).toBe(2);

      const summary = service.getReactionSummary('sess-1', 'slide-intro');
      expect(summary['👍']).toBe(2);
      expect(summary['❤️']).toBe(0);
    });
  });

  describe('Contextual Polls & Adaptive Navigation (SPEC-010, SPEC-011, SPEC-018)', () => {
    it('runs poll lifecycle, evaluates adaptive navigation rules, and navigates upon presenter confirmation', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');
      service.navigateSlide('sess-1', 'slide-arch', 'presenter');

      // Create poll
      const poll = service.createPoll(
        'sess-1',
        {
          id: 'poll-branching',
          sessionId: 'sess-1',
          slideId: 'slide-arch',
          question: 'Should we do a deep dive on Durable Objects or Skip to Conclusion?',
          type: 'single',
          options: [
            { id: 'opt-deep-dive', label: 'Yes, Deep Dive!' },
            { id: 'opt-skip', label: 'Skip to Conclusion' },
          ],
        },
        'presenter',
      );
      expect(poll.status).toBe('draft');

      // Add navigation rule: if >= 2 votes and >= 50% for opt-deep-dive, suggest slide-adaptive
      const rule: NavigationRule = {
        id: 'rule-deep-dive',
        presentationId: 'pres-app-1',
        sourceSlideId: 'slide-arch',
        pollId: 'poll-branching',
        optionId: 'opt-deep-dive',
        minVoteThreshold: 2,
        minPercentageThreshold: 50,
        targetSlideId: 'slide-adaptive',
        targetHorizontalIndex: 2,
        targetVerticalIndex: 0,
      };
      service.addNavigationRule(rule, 'presenter');

      // Open poll
      service.openPoll('sess-1', 'poll-branching', 'presenter');

      // Listen for navigation suggestion event
      let suggestedTarget: string | null = null;
      service.subscribe((evt) => {
        if (evt.type === 'navigation.suggested') {
          suggestedTarget = (evt.payload as { targetSlideId: string }).targetSlideId;
        }
      });

      // Participant 1 votes
      service.votePoll('sess-1', 'poll-branching', 'part-1', ['opt-deep-dive']);
      expect(suggestedTarget).toBeNull(); // Only 1 vote (< 2)

      // Participant 2 votes -> meets threshold!
      service.votePoll('sess-1', 'poll-branching', 'part-2', ['opt-deep-dive']);
      expect(suggestedTarget).toBe('slide-adaptive');

      const suggestions = service.checkAdaptiveNavigation('sess-1', 'poll-branching');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.targetSlideId).toBe('slide-adaptive');

      // Notice: deck has NOT automatically navigated yet!
      expect(service.getSession('sess-1')?.currentSlideId).toBe('slide-arch');

      // Presenter confirms adaptive navigation!
      const afterConfirmation = service.confirmAdaptiveNavigation(
        'sess-1',
        suggestions[0]!,
        'presenter',
      );
      expect(afterConfirmation.currentSlideId).toBe('slide-adaptive');
      expect(afterConfirmation.revealedSlideIds).toContain('slide-adaptive');
    });
  });

  describe('Word Clouds (SPEC-021)', () => {
    it('manages word cloud prompt and aggregates submissions', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });
      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      // Create prompt
      const prompt = service.createWordCloud(
        'sess-1',
        {
          id: 'wc-1',
          sessionId: 'sess-1',
          slideId: 'slide-arch',
          prompt: 'What comes to mind when you hear Durable Objects?',
        },
        'presenter',
      );
      expect(prompt.status).toBe('draft');

      // Cannot submit when draft
      expect(() => service.submitWordCloudTerm('sess-1', 'wc-1', 'part-1', 'Coordination')).toThrow(
        'Word cloud prompt is draft, submissions only allowed when open',
      );

      // Open prompt
      service.openWordCloud('sess-1', 'wc-1', 'presenter');

      // Submit terms
      service.submitWordCloudTerm('sess-1', 'wc-1', 'part-1', '  Persistence! ');
      service.submitWordCloudTerm('sess-1', 'wc-1', 'part-2', 'persistence');
      const agg = service.submitWordCloudTerm('sess-1', 'wc-1', 'part-3', 'Distributed');

      expect(agg.totalSubmissions).toBe(3);
      expect(agg.terms).toEqual([
        { term: 'persistence', count: 2 },
        { term: 'distributed', count: 1 },
      ]);
    });
  });

  describe('Gated PNG and Full PDF Downloads (SPEC-014, SPEC-016, SPEC-024)', () => {
    it('restricts PNG download until slide is revealed and asset generated', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      // Register PNG for slide-intro
      service.registerAsset('pres-app-1', {
        assetId: 'asset-intro-png',
        presentationId: 'pres-app-1',
        revision: 'rev-1',
        kind: 'slide-png',
        slideId: 'slide-intro',
        r2Key: 'r2/slide-intro.png',
        contentType: 'image/png',
        byteSize: 2000,
        createdAt: '2026-10-18T10:00:00.000Z',
      });

      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      // Unrevealed -> throws
      expect(() => service.downloadSlidePng('sess-1', 'slide-intro')).toThrow(
        'Slide PNG download not permitted or asset not available',
      );

      // Presenter reveals slide-intro
      service.navigateSlide('sess-1', 'slide-intro', 'presenter');

      // Now revealed -> succeeds
      const download = service.downloadSlidePng('sess-1', 'slide-intro');
      expect(download.r2Key).toBe('r2/slide-intro.png');
      expect(download.contentType).toBe('image/png');

      // Slide-arch has no PNG -> throws
      service.navigateSlide('sess-1', 'slide-arch', 'presenter');
      expect(() => service.downloadSlidePng('sess-1', 'slide-arch')).toThrow(
        'Slide PNG download not permitted or asset not available',
      );
    });

    it('restricts full PDF download until ending slide reached and PDF registered (SPEC-016, SPEC-022, SPEC-024)', () => {
      const service = createTestService();
      service.createPresentation({
        id: 'pres-app-1',
        title: 'Original Deck',
        endingSlideId: 'slide-conclusion',
        branding: { colors: { primary: '#f6821f' } },
        slides,
      });

      // Register PDF
      service.registerAsset(
        'pres-app-1',
        {
          assetId: 'asset-deck-pdf',
          presentationId: 'pres-app-1',
          revision: 'rev-1',
          kind: 'deck-pdf',
          r2Key: 'r2/deck.pdf',
          contentType: 'application/pdf',
          byteSize: 80000,
          createdAt: '2026-10-18T10:00:00.000Z',
        },
        { pdfSeparateFragments: false },
      );

      service.createSession('pres-app-1', 'sess-1', 'https://agora.live', 'presenter');

      // Ending slide not reached yet -> throws
      expect(() => service.downloadFullPdf('sess-1')).toThrow(
        'Full presentation PDF download not permitted or asset not available',
      );

      // Presenter visits ending slide
      service.navigateSlide('sess-1', 'slide-conclusion', 'presenter');

      // Now download succeeds!
      const pdf = service.downloadFullPdf('sess-1');
      expect(pdf.r2Key).toBe('r2/deck.pdf');
      expect(pdf.contentType).toBe('application/pdf');

      // Backtracking does not lock it again
      service.navigateSlide('sess-1', 'slide-intro', 'presenter');
      const pdfBack = service.downloadFullPdf('sess-1');
      expect(pdfBack.r2Key).toBe('r2/deck.pdf');
    });
  });
});
