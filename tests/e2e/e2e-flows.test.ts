import type {
  AudienceQuestion,
  AudienceSafeSessionView,
  NavigationSuggestion,
  PollResultsSummary,
  PresentationSession,
  SlideMetadata,
  WordCloudAggregate,
} from '@agora/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminAppController } from '../../apps/admin/src/index.js';
import { AudienceAppController, renderAudienceHtml } from '../../apps/audience/src/index.js';
import {
  PresenterAppController,
  renderPresenterViewHtml,
  renderProjectorViewHtml,
} from '../../apps/presenter/src/index.js';

describe('Agora End-to-End Vertical Slice (SPEC-020, Section 10 Definition of Done)', () => {
  let admin: AdminAppController;

  beforeEach(() => {
    admin = new AdminAppController();
  });

  it('executes full end-to-end multi-actor presentation journey', async () => {
    // =========================================================================
    // 1. ADMIN SETUP & ASSET GENERATION PIPELINE (SPEC-001, SPEC-013, SPEC-015, SPEC-017, SPEC-024)
    // =========================================================================

    const slidesConfig: Array<Omit<SlideMetadata, 'presentationId'> & { presentationId?: string }> =
      [
        {
          id: 'slide_0_intro',
          title: 'Agora Welcome',
          horizontalIndex: 0,
          verticalIndex: 0,
          order: 0,
        },
        {
          id: 'slide_1_poll',
          title: 'Architecture & Poll',
          horizontalIndex: 1,
          verticalIndex: 0,
          order: 1,
        },
        {
          id: 'slide_2_branch',
          title: 'Skipped Deep Dive Branch',
          horizontalIndex: 2,
          verticalIndex: 0,
          order: 2,
        },
        {
          id: 'slide_3_qa',
          title: 'Audience Q&A',
          horizontalIndex: 3,
          verticalIndex: 0,
          order: 3,
          isQaSlide: true,
        },
        {
          id: 'slide_4_ending',
          title: 'Conclusion & Next Steps',
          horizontalIndex: 4,
          verticalIndex: 0,
          order: 4,
        },
      ];

    const presentation = admin.createPresentation({
      title: 'Agora Platform Launch 2026',
      description: 'Interactive presentation platform presentation',
      eventName: 'DeepMind Tech Summit',
      endingSlideId: 'slide_4_ending',
      slides: slidesConfig,
      branding: {
        colors: { primary: '#3b82f6', background: '#0b0f19' },
      },
    });

    expect(presentation.id).toBeDefined();
    expect(presentation.status).toBe('draft');
    expect(presentation.revision).toBe('rev_1');
    expect(presentation.slides).toHaveLength(5);

    // SPEC-017: Presentation Duplication creates independent copy without sessions/votes
    const duplicatedPres = admin.duplicatePresentation(
      presentation.id,
      'Agora Platform Launch (Backup)',
    );
    expect(duplicatedPres.id).not.toBe(presentation.id);
    expect(duplicatedPres.status).toBe('draft');
    expect(duplicatedPres.slides).toHaveLength(5);
    expect(admin.getActiveSession(duplicatedPres.id)).toBeNull();

    // Admin publishes original presentation
    admin.publishPresentation(presentation.id);
    expect(admin.getPresentation(presentation.id)?.status).toBe('published');

    // SPEC-013: Browser-side DOM capture slide PNG generation workflow
    const imageWorkflow = await admin.generateAllSlideImages(presentation.id);
    expect(imageWorkflow.totalSlides).toBe(5);
    expect(imageWorkflow.completedSlides).toBe(5);
    expect(imageWorkflow.failedSlides).toHaveLength(0);

    // SPEC-015: Reveal.js Native PDF print export & upload
    const printUrl = admin.getRevealPdfPrintUrl(presentation.id);
    expect(printUrl).toContain('?print-pdf');
    const printConfig = admin.getRevealPrintConfig();
    expect(printConfig.printPdf).toBe(true);
    expect(printConfig.pdfSeparateFragments).toBe(false);

    // Upload native print PDF (includes all slides including skipped ones)
    const pdfAsset = admin.uploadDeckPdf(presentation.id, {
      byteSize: 2048000,
      fileName: 'agora_full_deck.pdf',
    });
    expect(pdfAsset.kind).toBe('deck-pdf');
    expect(pdfAsset.revision).toBe('rev_1');

    // SPEC-024: Asset preview verification before live delivery
    const preview = admin.getAssetPreview(presentation.id);
    expect(preview.isReadyForLiveDelivery).toBe(true);
    expect(preview.isPdfStale).toBe(false);
    expect(preview.slides.every((s) => s.hasPng)).toBe(true);

    // Start live session (SPEC-002)
    const session = admin.startLiveSession(presentation.id);
    expect(session.status).toBe('live');
    expect(session.currentSlideId).toBe('slide_0_intro');
    expect(session.revealedSlideIds).toEqual(['slide_0_intro']);
    expect(session.pdfDownloadUnlocked).toBe(false);
    expect(session.audienceUrl).toContain(session.id);

    // =========================================================================
    // 2. MULTI-ACTOR SETUP: PRESENTER, PROJECTOR, AND AUDIENCE PARTICIPANTS
    // =========================================================================

    const manifest = admin.getAssetManifest(presentation.id)!;
    const presenter = new PresenterAppController(session, presentation, manifest);

    // Two anonymous attendees join
    const attendeeAlice = new AudienceAppController(session.id);
    attendeeAlice.setParticipantDisplayName('Alice');
    const attendeeBob = new AudienceAppController(session.id);
    attendeeBob.setParticipantDisplayName('Bob');

    // State sync helper across actors
    const syncAllAttendees = (
      activePolls: PollResultsSummary[] = [],
      activeWordClouds: WordCloudAggregate[] = [],
      allQuestions: AudienceQuestion[] = [],
    ) => {
      const currentSession: PresentationSession = presenter.getSession();
      const safeView: AudienceSafeSessionView = {
        session: currentSession,
        slides: presentation.slides!,
        availablePngSlideIds: Object.keys(manifest.slidePngs),
        pdfAvailable: !admin.isPdfStale(presentation.id),
        questions: allQuestions,
        activePolls,
        activeWordClouds,
        reactionSummary: {
          [currentSession.currentSlideId ?? '']: presenter.getReactionsForCurrentSlide(),
        },
      };

      attendeeAlice.syncSessionView(safeView);
      attendeeBob.syncSessionView(safeView);
      presenter.syncQuestions(allQuestions);
    };

    // Initial sync
    presenter.updateParticipantCount(2);
    syncAllAttendees();

    // Verify initial audience state in Follow Mode (SPEC-004)
    expect(attendeeAlice.getMode()).toBe('follow');
    expect(attendeeAlice.getActiveSlide()?.id).toBe('slide_0_intro');
    expect(attendeeAlice.getViewModel().containsSlideBodyContent).toBe(false);

    const aliceHtml = renderAudienceHtml(attendeeAlice.getViewModel());
    expect(aliceHtml).toContain('Agora Welcome');
    expect(aliceHtml).not.toContain('deck-body');

    // =========================================================================
    // 3. PRESENTER NAVIGATION & SOLO MODE ACCESS CONTROL (SPEC-004, SPEC-005, SPEC-012)
    // =========================================================================

    // Presenter navigates right to Slide 1
    const movedToSlide1 = presenter.handleKeyDown('ArrowRight');
    expect(movedToSlide1).toBe(true);
    expect(presenter.getCurrentSlide()?.id).toBe('slide_1_poll');
    expect(presenter.getSession().revealedSlideIds).toEqual(['slide_0_intro', 'slide_1_poll']);

    // Real-time propagation: attendees follow speaker
    syncAllAttendees();
    expect(attendeeAlice.getActiveSlide()?.id).toBe('slide_1_poll');
    expect(attendeeBob.getActiveSlide()?.id).toBe('slide_1_poll');

    // Presenter skips Slide 2 (branch) and jumps to Slide 3 (Q&A)
    presenter.jumpToSlide('slide_3_qa');
    expect(presenter.getCurrentSlide()?.id).toBe('slide_3_qa');
    expect(presenter.getSession().revealedSlideIds).toEqual([
      'slide_0_intro',
      'slide_1_poll',
      'slide_3_qa',
    ]);
    expect(presenter.getSession().revealedSlideIds).not.toContain('slide_2_branch');

    syncAllAttendees();

    // Attendee Alice switches to Solo Mode (SPEC-005)
    attendeeAlice.setMode('solo');
    expect(attendeeAlice.getMode()).toBe('solo');

    // Alice browses revealed slides in presentation order
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_3_qa');
    expect(attendeeAlice.canNavigateSoloPrev()).toBe(true);
    attendeeAlice.soloPrevious();
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_1_poll');
    attendeeAlice.soloPrevious();
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_0_intro');

    // In Solo mode, Alice CANNOT access skipped slide_2_branch
    expect(attendeeAlice.canNavigateSoloNext()).toBe(true);
    attendeeAlice.soloNext();
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_1_poll');
    attendeeAlice.soloNext();
    // Skips directly to slide_3_qa; slide_2_branch is excluded!
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_3_qa');

    // Presenter backtracks to Slide 1
    presenter.jumpToSlide('slide_1_poll');
    syncAllAttendees();

    // Alice in Solo mode still has access to slide_3_qa (revealed slides remain accessible forever)
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_3_qa');

    // Alice switches back to Follow mode -> immediately snaps to presenter's position (Slide 1)
    attendeeAlice.setMode('follow');
    expect(attendeeAlice.getActiveSlideId()).toBe('slide_1_poll');

    // =========================================================================
    // 4. REAL-TIME INTERACTIONS: QUESTIONS, UPVOTING, REACTIONS, POLLS, WORD CLOUDS, ADAPTIVE NAV
    // =========================================================================

    // Questions (SPEC-006)
    const q1 = attendeeAlice.submitQuestion(
      'How does replication handle network partitions?',
      'Alice',
    );
    const q2 = attendeeBob.submitQuestion('What is the maximum throughput per second?', 'Bob');

    // Sync questions across attendees and presenter
    syncAllAttendees([], [], [q1, q2]);

    // Upvoting and retracting (SPEC-007)
    const upvotedQ2 = attendeeAlice.toggleUpvoteQuestion(q2.id); // Alice upvotes Bob's question
    expect(upvotedQ2.upvotes).toBe(1);
    const retractedQ2 = attendeeAlice.toggleUpvoteQuestion(q2.id); // Alice retracts upvote
    expect(retractedQ2.upvotes).toBe(0);
    const reUpvotedQ2 = attendeeAlice.toggleUpvoteQuestion(q2.id); // Alice upvotes again
    expect(reUpvotedQ2.upvotes).toBe(1);
    syncAllAttendees([], [], [q1, reUpvotedQ2]);

    // Emoji reactions (SPEC-009)
    attendeeAlice.sendReaction('👍');
    attendeeAlice.sendReaction('❤️');
    attendeeBob.sendReaction('👍');
    attendeeBob.sendReaction('🤔');

    presenter.receiveReaction('slide_1_poll', '👍');
    presenter.receiveReaction('slide_1_poll', '❤️');
    presenter.receiveReaction('slide_1_poll', '👍');
    presenter.receiveReaction('slide_1_poll', '🤔');

    const liveReactions = presenter.getReactionsForCurrentSlide();
    expect(liveReactions['👍']).toBe(2);
    expect(liveReactions['❤️']).toBe(1);
    expect(liveReactions['🤔']).toBe(1);
    expect(liveReactions['😴']).toBe(0);

    // Contextual Poll & Adaptive Navigation (SPEC-010, SPEC-011)
    const poll: PollResultsSummary = {
      pollId: 'poll_arch',
      slideId: 'slide_1_poll',
      status: 'open',
      resultsRevealed: false,
      totalResponses: 0,
      countsByOptionId: { opt_branch: 0, opt_standard: 0 },
    };

    const wordCloud: WordCloudAggregate = {
      promptId: 'wc_keywords',
      slideId: 'slide_1_poll',
      status: 'open',
      totalSubmissions: 0,
      terms: [],
    };

    syncAllAttendees([poll], [wordCloud], [q1, q2]);

    // Attendees vote in poll
    attendeeAlice.submitPollVote('poll_arch', ['opt_branch']);
    attendeeBob.submitPollVote('poll_arch', ['opt_branch']);
    expect(poll.totalResponses).toBe(2);
    expect(poll.countsByOptionId.opt_branch).toBe(2);

    // Word Cloud submissions (SPEC-021)
    attendeeAlice.submitWordCloudTerm('wc_keywords', 'scalability');
    attendeeBob.submitWordCloudTerm('wc_keywords', 'SCALABILITY');
    expect(wordCloud.totalSubmissions).toBe(2);
    expect(wordCloud.terms[0]?.term).toBe('scalability');
    expect(wordCloud.terms[0]?.count).toBe(2);

    // Adaptive navigation rule triggers suggestion banner (SPEC-011)
    const suggestion: NavigationSuggestion = {
      ruleId: 'rule_branch',
      sourceSlideId: 'slide_1_poll',
      pollId: 'poll_arch',
      optionId: 'opt_branch',
      targetSlideId: 'slide_2_branch',
      targetHorizontalIndex: 2,
      targetVerticalIndex: 0,
      reason: '100% of participants voted to explore the deep dive branch',
    };

    presenter.setNavigationSuggestion(suggestion);
    expect(presenter.getActiveSuggestion()).not.toBeNull();
    // Deck must NOT automatically jump!
    expect(presenter.getCurrentSlide()?.id).toBe('slide_1_poll');

    // Presenter view shows suggestion banner; Projector view NEVER exposes it (SPEC-012)
    const presenterHtmlWithSuggestion = renderPresenterViewHtml(presenter.getViewState());
    expect(presenterHtmlWithSuggestion).toContain('Suggested Navigation:');
    expect(presenterHtmlWithSuggestion).toContain('Accept & Jump');

    const projectorHtml = renderProjectorViewHtml(presenter.getProjectorViewState());
    expect(projectorHtml).not.toContain('Suggested Navigation');
    expect(projectorHtml).not.toContain('dpad-container');

    // Presenter explicitly confirms suggestion
    const accepted = presenter.acceptNavigationSuggestion();
    expect(accepted).toBe(true);
    expect(presenter.getCurrentSlide()?.id).toBe('slide_2_branch');
    // Now slide_2_branch is finally visited and revealed!
    expect(presenter.getSession().revealedSlideIds).toContain('slide_2_branch');

    syncAllAttendees([poll], [wordCloud], [q1, q2]);

    // =========================================================================
    // 5. EMBEDDED Q&A SLIDE & QUESTION DETAIL VIEW (SPEC-008)
    // =========================================================================

    // Presenter navigates to Slide 3 (Q&A slide)
    presenter.jumpToSlide('slide_3_qa');
    expect(presenter.getCurrentSlide()?.id).toBe('slide_3_qa');

    const qaState = presenter.getQaState();
    expect(qaState.isQaSlideActive).toBe(true);
    expect(qaState.viewMode).toBe('list');

    // Presenter clicks Bob's top-voted question (q2 was asked on slide_1_poll)
    const selectedQ = presenter.selectQuestion(q2.id);
    expect(selectedQ).toBe(true);

    const detailState = presenter.getQaState();
    expect(detailState.viewMode).toBe('detail');
    expect(detailState.selectedQuestion?.id).toBe(q2.id);
    expect(detailState.hasReferencedSlidePng).toBe(true);
    expect(detailState.referencedSlidePngUrl).toContain('slide_1_poll.png');

    // CRITICAL SPEC-008 INVARIANT: Active slide remains slide_3_qa! Deck does NOT jump away
    expect(presenter.getCurrentSlide()?.id).toBe('slide_3_qa');
    expect(presenter.getSession().currentSlideId).toBe('slide_3_qa');

    // Presenter marks question answered
    presenter.markQuestionStatus(q2.id, 'answered');
    expect(presenter.getQuestions().find((q) => q.id === q2.id)?.status).toBe('answered');

    // Presenter presses Escape to return to Q&A list
    presenter.handleKeyDown('Escape');
    expect(presenter.getQaState().viewMode).toBe('list');

    // =========================================================================
    // 6. ASSET DOWNLOAD ACCESS CONTROL & SESSION COMPLETION (SPEC-014, SPEC-016, SPEC-022)
    // =========================================================================

    // Single-slide PNG download: revealed slide PNG allowed, unrevealed denied (SPEC-014)
    expect(attendeeAlice.getSlidePngDownloadUrl('slide_0_intro')).toContain('download-png');
    expect(attendeeAlice.getSlidePngDownloadUrl('non_existent_slide')).toBeNull();

    // Full deck PDF download is locked initially (SPEC-016)
    expect(attendeeAlice.canDownloadDeckPdf()).toBe(false);
    expect(attendeeAlice.getDeckPdfDownloadUrl()).toBeNull();

    // Presenter navigates to ending slide (Slide 4)
    presenter.jumpToSlide('slide_4_ending');
    expect(presenter.getCurrentSlide()?.id).toBe('slide_4_ending');

    // SPEC-016 & SPEC-022: Visiting ending slide unlocks PDF permanently
    expect(presenter.getSession().pdfDownloadUnlocked).toBe(true);
    // Crucially: session status remains 'live', not completed!
    expect(presenter.getSession().status).toBe('live');

    syncAllAttendees([poll], [wordCloud], [q1, q2]);

    // Now attendees can download full PDF
    expect(attendeeAlice.canDownloadDeckPdf()).toBe(true);
    expect(attendeeAlice.getDeckPdfDownloadUrl()).toContain('download-pdf');
    expect(attendeeBob.canDownloadDeckPdf()).toBe(true);

    // Presenter backtracks to Q&A slide -> PDF download remains permanently unlocked
    presenter.jumpToSlide('slide_3_qa');
    expect(presenter.getSession().pdfDownloadUnlocked).toBe(true);

    // SPEC-002 & SPEC-022: Explicit session completion
    const completedSession = presenter.completeSession();
    expect(completedSession.status).toBe('completed');
    expect(completedSession.completedAt).toBeDefined();
  });
});
