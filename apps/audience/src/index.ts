import {
  ALLOWED_REACTIONS,
  type AudienceMode,
  type AudienceQuestion,
  type AudienceSafeSessionView,
  type ParticipantIdentity,
  type PollResultsSummary,
  type Reaction,
  type ReactionCounts,
  type SlideMetadata,
  type WordCloudAggregate,
} from '@agora/contracts';

export interface AudienceViewModel {
  sessionId: string;
  participant: ParticipantIdentity;
  mode: AudienceMode;
  connected: boolean;
  activeSlide: SlideMetadata | null;
  activeSlideIndex: number;
  totalRevealedSlides: number;
  totalPresentationSlides: number;
  canNavigateSoloPrev: boolean;
  canNavigateSoloNext: boolean;
  containsSlideBodyContent: false;
  canDownloadCurrentSlidePng: boolean;
  canDownloadDeckPdf: boolean;
  currentSlidePngUrl: string | null;
  deckPdfUrl: string | null;
  reactions: ReactionCounts;
  questions: AudienceQuestion[];
  activePoll: PollResultsSummary | null;
  activeWordCloud: WordCloudAggregate | null;
}

export class AudienceAppController {
  private sessionId: string;
  private participant: ParticipantIdentity;
  private mode: AudienceMode = 'follow';
  private connected = true;

  // Session safe view data
  private slides: SlideMetadata[] = [];
  private revealedSlideIds: Set<string> = new Set();
  private availablePngSlideIds: Set<string> = new Set();
  private pdfAvailable = false;
  private pdfDownloadUnlocked = false;
  private speakerCurrentSlideId: string | null = null;
  private soloCurrentSlideId: string | null = null;

  // Interactions data
  private questions: AudienceQuestion[] = [];
  private polls: PollResultsSummary[] = [];
  private wordClouds: WordCloudAggregate[] = [];
  private reactionsBySlide: Map<string, ReactionCounts> = new Map();
  private participantVotesByPollId: Map<string, string[]> = new Map();
  private participantWordSubmissions: Map<string, Set<string>> = new Map();

  constructor(sessionId: string, initialIdentity?: ParticipantIdentity) {
    this.sessionId = sessionId;
    const now = new Date().toISOString();
    const randomSuffix = Math.random().toString(36).substring(2, 9);
    this.participant = initialIdentity ?? {
      id: `p_${randomSuffix}`,
      sessionId,
      token: `tok_${randomSuffix}`,
      joinedAt: now,
    };
  }

  getParticipant(): ParticipantIdentity {
    return { ...this.participant };
  }

  setParticipantDisplayName(name: string): void {
    this.participant.displayName = name.trim();
  }

  getMode(): AudienceMode {
    return this.mode;
  }

  setMode(newMode: AudienceMode): void {
    if (this.mode === newMode) return;
    this.mode = newMode;
    if (newMode === 'follow') {
      // SPEC-005: Switching back to Follow immediately snaps to the speaker's current slide
      this.soloCurrentSlideId = null;
    } else {
      // Switching to Solo mode starts at current speaker slide if revealed, or first revealed slide
      const revealed = this.getRevealedSlidesInOrder();
      if (this.speakerCurrentSlideId && this.revealedSlideIds.has(this.speakerCurrentSlideId)) {
        this.soloCurrentSlideId = this.speakerCurrentSlideId;
      } else if (revealed.length > 0) {
        this.soloCurrentSlideId = revealed[0]?.id ?? null;
      }
    }
  }

  // SPEC-002, SPEC-019: Reconnect and synchronize session state
  syncSessionView(view: AudienceSafeSessionView): void {
    this.connected = true;
    this.slides = [...view.slides].sort((a, b) => a.order - b.order);
    this.revealedSlideIds = new Set(view.session.revealedSlideIds);
    this.availablePngSlideIds = new Set(view.availablePngSlideIds);
    this.pdfAvailable = view.pdfAvailable;
    this.pdfDownloadUnlocked = view.session.pdfDownloadUnlocked;
    this.speakerCurrentSlideId = view.session.currentSlideId;
    this.questions = [...view.questions];
    this.polls = [...view.activePolls];
    this.wordClouds = [...view.activeWordClouds];

    for (const [slideId, counts] of Object.entries(view.reactionSummary)) {
      this.reactionsBySlide.set(slideId, { ...counts });
    }

    // If solo mode selected slide was not yet set or invalid, sync it
    if (this.mode === 'solo' && !this.soloCurrentSlideId) {
      const revealed = this.getRevealedSlidesInOrder();
      this.soloCurrentSlideId = revealed[0]?.id ?? null;
    }
  }

  setConnectionStatus(connected: boolean): void {
    this.connected = connected;
  }

  // Navigation helpers for Solo mode
  private getRevealedSlidesInOrder(): SlideMetadata[] {
    return this.slides.filter((s) => this.revealedSlideIds.has(s.id));
  }

  getActiveSlideId(): string | null {
    if (this.mode === 'follow') {
      return this.speakerCurrentSlideId;
    }
    return this.soloCurrentSlideId ?? this.speakerCurrentSlideId;
  }

  getActiveSlide(): SlideMetadata | null {
    const activeId = this.getActiveSlideId();
    if (!activeId) return null;
    return this.slides.find((s) => s.id === activeId) ?? null;
  }

  // SPEC-005: Solo mode navigation over revealed slides only
  canNavigateSoloPrev(): boolean {
    if (this.mode !== 'solo') return false;
    const revealed = this.getRevealedSlidesInOrder();
    const currentIndex = revealed.findIndex((s) => s.id === this.soloCurrentSlideId);
    return currentIndex > 0;
  }

  canNavigateSoloNext(): boolean {
    if (this.mode !== 'solo') return false;
    const revealed = this.getRevealedSlidesInOrder();
    const currentIndex = revealed.findIndex((s) => s.id === this.soloCurrentSlideId);
    return currentIndex >= 0 && currentIndex < revealed.length - 1;
  }

  soloPrevious(): boolean {
    if (!this.canNavigateSoloPrev()) return false;
    const revealed = this.getRevealedSlidesInOrder();
    const currentIndex = revealed.findIndex((s) => s.id === this.soloCurrentSlideId);
    const prevSlide = revealed[currentIndex - 1];
    if (prevSlide) {
      this.soloCurrentSlideId = prevSlide.id;
      return true;
    }
    return false;
  }

  soloNext(): boolean {
    if (!this.canNavigateSoloNext()) return false;
    const revealed = this.getRevealedSlidesInOrder();
    const currentIndex = revealed.findIndex((s) => s.id === this.soloCurrentSlideId);
    const nextSlide = revealed[currentIndex + 1];
    if (nextSlide) {
      this.soloCurrentSlideId = nextSlide.id;
      return true;
    }
    return false;
  }

  // SPEC-006: Slide-scoped question submission
  submitQuestion(content: string, displayName?: string): AudienceQuestion {
    const activeSlide = this.getActiveSlide();
    if (!activeSlide) {
      throw new Error('Cannot submit question without an active slide');
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Question content cannot be empty');
    }

    const question: AudienceQuestion = {
      id: `q_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sessionId: this.sessionId,
      slideId: activeSlide.id,
      participantId: this.participant.id,
      participantName: displayName?.trim() || this.participant.displayName || 'Anonymous',
      content: trimmed,
      status: 'pending',
      upvotes: 0,
      upvotedByParticipantIds: [],
      createdAt: new Date().toISOString(),
    };

    this.questions.push(question);
    return question;
  }

  // SPEC-007: Question upvoting and retracting (one upvote per participant)
  toggleUpvoteQuestion(questionId: string): AudienceQuestion {
    const question = this.questions.find((q) => q.id === questionId);
    if (!question) {
      throw new Error(`Question ${questionId} not found`);
    }

    const voterIds = new Set(question.upvotedByParticipantIds ?? []);
    if (voterIds.has(this.participant.id)) {
      // Retract upvote
      voterIds.delete(this.participant.id);
      question.upvotes = Math.max(0, question.upvotes - 1);
    } else {
      // Add upvote
      voterIds.add(this.participant.id);
      question.upvotes += 1;
    }

    question.upvotedByParticipantIds = Array.from(voterIds);
    return question;
  }

  getQuestionsForActiveSlide(sortBy: 'votes' | 'time' = 'votes'): AudienceQuestion[] {
    const activeId = this.getActiveSlideId();
    if (!activeId) return [];

    const filtered = this.questions.filter((q) => q.slideId === activeId);
    if (sortBy === 'votes') {
      return filtered.sort((a, b) => b.upvotes - a.upvotes);
    }
    return filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // SPEC-009: Emoji reactions (👍 🤔 ❤️ 😴)
  sendReaction(reaction: Reaction): void {
    if (!ALLOWED_REACTIONS.includes(reaction)) {
      throw new Error(`Invalid reaction: ${reaction}`);
    }

    const activeSlide = this.getActiveSlide();
    if (!activeSlide) return;

    let counts = this.reactionsBySlide.get(activeSlide.id);
    if (!counts) {
      counts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
      this.reactionsBySlide.set(activeSlide.id, counts);
    }

    counts[reaction] += 1;
  }

  getReactionsForActiveSlide(): ReactionCounts {
    const activeId = this.getActiveSlideId();
    const defaults: ReactionCounts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
    if (!activeId) return defaults;
    const current = this.reactionsBySlide.get(activeId);
    return current ? { ...current } : defaults;
  }

  // SPEC-010: Contextual polls
  submitPollVote(pollId: string, optionIds: string[]): void {
    const poll = this.polls.find((p) => p.pollId === pollId);
    if (!poll || poll.status !== 'open') {
      throw new Error(`Poll ${pollId} is not open for voting`);
    }

    this.participantVotesByPollId.set(pollId, [...optionIds]);
    for (const optId of optionIds) {
      poll.countsByOptionId[optId] = (poll.countsByOptionId[optId] ?? 0) + 1;
    }
    poll.totalResponses += 1;
  }

  getActivePollForCurrentSlide(): PollResultsSummary | null {
    const activeId = this.getActiveSlideId();
    if (!activeId) return null;
    return this.polls.find((p) => p.slideId === activeId && p.status === 'open') ?? null;
  }

  // SPEC-021: Word cloud submissions
  submitWordCloudTerm(promptId: string, rawTerm: string): void {
    const wordCloud = this.wordClouds.find((wc) => wc.promptId === promptId);
    if (!wordCloud || wordCloud.status !== 'open') {
      throw new Error(`Word cloud ${promptId} is not open for submission`);
    }

    const normalized = rawTerm.trim().toLowerCase();
    if (!normalized || normalized.length > 50) return;

    let userSubmissions = this.participantWordSubmissions.get(promptId);
    if (!userSubmissions) {
      userSubmissions = new Set();
      this.participantWordSubmissions.set(promptId, userSubmissions);
    }
    userSubmissions.add(normalized);

    const existingTerm = wordCloud.terms.find((t) => t.term === normalized);
    if (existingTerm) {
      existingTerm.count += 1;
    } else {
      wordCloud.terms.push({ term: normalized, count: 1 });
    }
    wordCloud.totalSubmissions += 1;
  }

  getActiveWordCloudForCurrentSlide(): WordCloudAggregate | null {
    const activeId = this.getActiveSlideId();
    if (!activeId) return null;
    return this.wordClouds.find((wc) => wc.slideId === activeId && wc.status === 'open') ?? null;
  }

  // SPEC-014: Single-slide downloads
  canDownloadCurrentSlidePng(): boolean {
    const activeId = this.getActiveSlideId();
    if (!activeId) return false;
    return this.revealedSlideIds.has(activeId) && this.availablePngSlideIds.has(activeId);
  }

  getSlidePngDownloadUrl(slideId?: string): string | null {
    const targetId = slideId ?? this.getActiveSlideId();
    if (!targetId) return null;
    if (this.revealedSlideIds.has(targetId) && this.availablePngSlideIds.has(targetId)) {
      return `/api/sessions/${this.sessionId}/slides/${targetId}/download-png`;
    }
    return null;
  }

  // SPEC-016: Full presentation download
  canDownloadDeckPdf(): boolean {
    return this.pdfDownloadUnlocked && this.pdfAvailable;
  }

  getDeckPdfDownloadUrl(): string | null {
    if (this.canDownloadDeckPdf()) {
      return `/api/sessions/${this.sessionId}/download-pdf`;
    }
    return null;
  }

  getViewModel(): AudienceViewModel {
    const activeSlide = this.getActiveSlide();
    const revealedSlides = this.getRevealedSlidesInOrder();
    const activeIndex = activeSlide
      ? revealedSlides.findIndex((s) => s.id === activeSlide.id) + 1
      : 0;

    return {
      sessionId: this.sessionId,
      participant: this.getParticipant(),
      mode: this.mode,
      connected: this.connected,
      activeSlide,
      activeSlideIndex: activeIndex,
      totalRevealedSlides: revealedSlides.length,
      totalPresentationSlides: this.slides.length,
      canNavigateSoloPrev: this.canNavigateSoloPrev(),
      canNavigateSoloNext: this.canNavigateSoloNext(),
      containsSlideBodyContent: false, // SPEC-004: Invariant
      canDownloadCurrentSlidePng: this.canDownloadCurrentSlidePng(),
      canDownloadDeckPdf: this.canDownloadDeckPdf(),
      currentSlidePngUrl: this.getSlidePngDownloadUrl(),
      deckPdfUrl: this.getDeckPdfDownloadUrl(),
      reactions: this.getReactionsForActiveSlide(),
      questions: this.getQuestionsForActiveSlide(),
      activePoll: this.getActivePollForCurrentSlide(),
      activeWordCloud: this.getActiveWordCloudForCurrentSlide(),
    };
  }
}

// Accessible HTML UI view-model renderer (SPEC-004, SPEC-005)
export function renderAudienceHtml(vm: AudienceViewModel): string {
  const isFollow = vm.mode === 'follow';
  const slideTitle = vm.activeSlide ? vm.activeSlide.title : 'Waiting for presenter...';
  const slideCountLabel = vm.activeSlide
    ? `Slide ${vm.activeSlideIndex} of ${vm.totalRevealedSlides} revealed (${vm.totalPresentationSlides} total)`
    : 'No active slide';

  // Mode switcher & navigation controls
  const modeControls = `
    <nav class="mode-navigation-bar" aria-label="Audience viewing modes">
      <div class="button-group" role="group" aria-label="Mode switcher">
        <button class="btn-mode ${isFollow ? 'btn-primary' : 'btn-secondary'}" data-action="set-mode" data-mode="follow" aria-pressed="${isFollow}">
          Follow Speaker
        </button>
        <button class="btn-mode ${!isFollow ? 'btn-primary' : 'btn-secondary'}" data-action="set-mode" data-mode="solo" aria-pressed="${!isFollow}">
          Solo Browsing
        </button>
      </div>
      ${
        !isFollow
          ? `
        <div class="solo-controls" role="group" aria-label="Solo slide navigation">
          <button class="btn-secondary" data-action="solo-prev" ${!vm.canNavigateSoloPrev ? 'disabled' : ''} aria-label="Previous revealed slide">
            &larr; Prev
          </button>
          <button class="btn-secondary" data-action="solo-next" ${!vm.canNavigateSoloNext ? 'disabled' : ''} aria-label="Next revealed slide">
            Next &rarr;
          </button>
        </div>`
          : ''
      }
    </nav>`;

  // Emoji reactions
  const reactionButtons = ALLOWED_REACTIONS.map((emoji) => {
    const count = vm.reactions[emoji];
    return `
      <button class="reaction-btn" data-action="send-reaction" data-reaction="${emoji}" aria-label="React with ${emoji}, currently ${count}">
        <span>${emoji}</span>
        <span class="reaction-count" aria-hidden="true">${count}</span>
      </button>`;
  }).join('');

  // Downloads bar
  const pngBtn = vm.canDownloadCurrentSlidePng
    ? `<a href="${vm.currentSlidePngUrl}" class="btn-download" download aria-label="Download current slide PNG">Download Slide PNG</a>`
    : '<button class="btn-download" disabled title="Slide image not unlocked or unavailable">Slide PNG Locked</button>';

  const pdfBtn = vm.canDownloadDeckPdf
    ? `<a href="${vm.deckPdfUrl}" class="btn-download-pdf" download aria-label="Download full presentation PDF">Download Full Deck (PDF)</a>`
    : '<button class="btn-download-pdf" disabled title="Full deck download unlocks at presentation conclusion">Deck PDF Locked</button>';

  // Active Poll widget
  let pollWidget = '';
  if (vm.activePoll) {
    const optionsHtml = Object.entries(vm.activePoll.countsByOptionId)
      .map(
        ([optId, count]) => `
        <li class="poll-option-item">
          <button class="btn-poll-option" data-action="vote-poll" data-poll-id="${vm.activePoll?.pollId}" data-option-id="${optId}">
            <span>Option: ${optId}</span>
            <span class="poll-vote-count">(${count} votes)</span>
          </button>
        </li>`,
      )
      .join('');

    pollWidget = `
      <section class="card poll-widget" aria-label="Active Poll">
        <h4>Live Poll</h4>
        <ul class="poll-options-list">
          ${optionsHtml}
        </ul>
      </section>`;
  }

  // Active Word Cloud widget
  let wordCloudWidget = '';
  if (vm.activeWordCloud) {
    wordCloudWidget = `
      <section class="card wordcloud-widget" aria-label="Active Word Cloud">
        <h4>Word Cloud Submission</h4>
        <form class="wordcloud-form" data-action="submit-wordcloud" data-prompt-id="${vm.activeWordCloud.promptId}">
          <input type="text" name="term" maxlength="50" placeholder="Enter a single word or short term" required aria-label="Word cloud term" />
          <button type="submit" class="btn-primary">Submit</button>
        </form>
      </section>`;
  }

  // Questions List
  const questionItems = vm.questions
    .map(
      (q) => `
      <article class="question-item" data-question-id="${q.id}">
        <div class="question-content">
          <p class="question-text">${q.content}</p>
          <span class="question-author">— ${q.participantName ?? 'Anonymous'}</span>
        </div>
        <div class="question-actions">
          <button class="btn-upvote" data-action="toggle-upvote" data-question-id="${q.id}" aria-label="Upvote question, current upvotes ${q.upvotes}">
            ▲ ${q.upvotes}
          </button>
        </div>
      </article>`,
    )
    .join('');

  return `
    <div class="audience-app ${isFollow ? 'mode-follow' : 'mode-solo'}">
      <header>
        <h2>Agora Live</h2>
        <span class="connection-status ${vm.connected ? 'status-online' : 'status-offline'}">
          ${vm.connected ? 'Connected' : 'Reconnecting...'}
        </span>
      </header>
      <main>
        ${modeControls}
        <section class="card current-slide-info" aria-label="Slide Information">
          <h3 class="slide-title">${slideTitle}</h3>
          <p class="slide-number-indicator">${slideCountLabel}</p>
        </section>
        <section class="card reactions-container" aria-label="Emoji Reactions">
          <div class="reactions-bar">
            ${reactionButtons}
          </div>
        </section>
        ${pollWidget}
        ${wordCloudWidget}
        <section class="card qa-section" aria-label="Audience Q&A">
          <h4>Ask a Question</h4>
          <form class="qa-form" data-action="submit-question">
            <textarea name="question" placeholder="Ask about this slide..." required aria-label="Question text"></textarea>
            <button type="submit" class="btn-primary">Submit Question</button>
          </form>
          <div class="questions-list" role="feed" aria-label="Questions for this slide">
            ${questionItems || '<p class="empty-questions">No questions yet for this slide.</p>'}
          </div>
        </section>
        <section class="card downloads-section" aria-label="Presentation Downloads">
          <h4>Slide & Deck Downloads</h4>
          <div class="downloads-actions">
            ${pngBtn}
            ${pdfBtn}
          </div>
        </section>
      </main>
    </div>`;
}
