import {
  ALLOWED_REACTIONS,
  type AssetManifest,
  type AudienceQuestion,
  type NavigationSuggestion,
  type PollDefinition,
  type PollOption,
  type PollResultsSummary,
  type Presentation,
  type PresentationSession,
  type QuestionStatus,
  type Reaction,
  type ReactionCounts,
  type RealtimeEvent,
  type SlideMetadata,
} from '@agora/contracts';

export type QaViewMode = 'list' | 'detail';

export interface QaSlideControllerState {
  isQaSlideActive: boolean;
  viewMode: QaViewMode;
  selectedQuestionId: string | null;
  selectedQuestion: AudienceQuestion | null;
  referencedSlidePngUrl: string | null;
  hasReferencedSlidePng: boolean;
  sortBy: 'votes' | 'time';
}

export interface PresenterViewState {
  sessionId: string;
  presentationId: string;
  presentationTitle: string;
  sessionStatus: PresentationSession['status'];
  audienceUrl?: string;
  qrCodeDataUrl?: string;
  currentSlide: SlideMetadata | null;
  horizontalIndex: number;
  verticalIndex: number;
  canNavigateLeft: boolean;
  canNavigateRight: boolean;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
  reactions: ReactionCounts;
  questionCount: number;
  connectedParticipants: number;
  pdfDownloadUnlocked: boolean;
  activeSuggestion: NavigationSuggestion | null;
  qaState: QaSlideControllerState;
  activePoll: PollDefinition | null;
  activePollResults: PollResultsSummary | null;
  pollsForCurrentSlide: PollDefinition[];
  hasAdminControls: false;
}

export interface ProjectorViewState {
  sessionId: string;
  presentationTitle: string;
  currentSlide: SlideMetadata | null;
  isQaSlide: boolean;
  qaQuestions: AudienceQuestion[];
  projectedPoll: PollDefinition | null;
  projectedPollResults: PollResultsSummary | null;
  isSuggestionVisibleOnProjection: false;
  hasPresenterOnlyControls: false;
}

export class PresenterAppController {
  private session: PresentationSession;
  private presentation: Presentation;
  private manifest: AssetManifest | null = null;

  private currentHorizontalIndex = 0;
  private currentVerticalIndex = 0;

  // Real-time HUD data
  private reactionsBySlide = new Map<string, ReactionCounts>();
  private questions: AudienceQuestion[] = [];
  private activeSuggestion: NavigationSuggestion | null = null;

  // Embedded Q&A state (SPEC-008)
  private qaViewMode: QaViewMode = 'list';
  private selectedQuestionId: string | null = null;
  private qaSortBy: 'votes' | 'time' = 'votes';

  // Contextual polls (SPEC-010)
  private polls: PollDefinition[] = [];
  private pollResults = new Map<string, PollResultsSummary>();

  private listeners = new Set<(state: PresenterViewState) => void>();

  constructor(
    session: PresentationSession,
    presentation: Presentation,
    manifest?: AssetManifest | null,
  ) {
    this.session = { ...session, revealedSlideIds: [...session.revealedSlideIds] };
    this.presentation = { ...presentation };
    this.manifest = manifest ? { ...manifest } : null;

    // Locate initial slide coordinates from session.currentSlideId
    if (this.session.currentSlideId) {
      const initialSlide = this.presentation.slides?.find(
        (s) => s.id === this.session.currentSlideId,
      );
      if (initialSlide) {
        this.currentHorizontalIndex = initialSlide.horizontalIndex;
        this.currentVerticalIndex = initialSlide.verticalIndex;
      }
    } else if (this.presentation.slides && this.presentation.slides.length > 0) {
      const firstSlide = this.presentation.slides[0];
      if (firstSlide) {
        this.currentHorizontalIndex = firstSlide.horizontalIndex;
        this.currentVerticalIndex = firstSlide.verticalIndex;
        this.session.currentSlideId = firstSlide.id;
        if (!this.session.revealedSlideIds.includes(firstSlide.id)) {
          this.session.revealedSlideIds.push(firstSlide.id);
        }
      }
    }
  }

  getSession(): PresentationSession {
    return { ...this.session, revealedSlideIds: [...this.session.revealedSlideIds] };
  }

  setAssetManifest(manifest: AssetManifest): void {
    this.manifest = { ...manifest };
  }

  getCurrentSlide(): SlideMetadata | null {
    if (!this.presentation.slides) return null;
    return (
      this.presentation.slides.find(
        (s) =>
          s.horizontalIndex === this.currentHorizontalIndex &&
          s.verticalIndex === this.currentVerticalIndex,
      ) ?? null
    );
  }

  // Directional checks (SPEC-012, SPEC-023)
  canNavigateLeft(): boolean {
    if (!this.presentation.slides) return false;
    return this.presentation.slides.some(
      (s) => s.horizontalIndex === this.currentHorizontalIndex - 1 && s.verticalIndex === 0,
    );
  }

  canNavigateRight(): boolean {
    if (!this.presentation.slides) return false;
    return this.presentation.slides.some(
      (s) => s.horizontalIndex === this.currentHorizontalIndex + 1 && s.verticalIndex === 0,
    );
  }

  canNavigateUp(): boolean {
    if (!this.presentation.slides) return false;
    return this.presentation.slides.some(
      (s) =>
        s.horizontalIndex === this.currentHorizontalIndex &&
        s.verticalIndex === this.currentVerticalIndex - 1,
    );
  }

  canNavigateDown(): boolean {
    if (!this.presentation.slides) return false;
    return this.presentation.slides.some(
      (s) =>
        s.horizontalIndex === this.currentHorizontalIndex &&
        s.verticalIndex === this.currentVerticalIndex + 1,
    );
  }

  private applySlideTransition(targetH: number, targetV: number): boolean {
    if (!this.presentation.slides) return false;
    const target = this.presentation.slides.find(
      (s) => s.horizontalIndex === targetH && s.verticalIndex === targetV,
    );
    if (!target) return false;

    this.currentHorizontalIndex = targetH;
    this.currentVerticalIndex = targetV;
    this.session.currentSlideId = target.id;

    // Reveal slide if newly visited
    if (!this.session.revealedSlideIds.includes(target.id)) {
      this.session.revealedSlideIds.push(target.id);
    }

    // SPEC-016 & SPEC-022: Visiting ending slide unlocks PDF permanently without completing session
    if (target.id === this.presentation.endingSlideId) {
      this.session.pdfDownloadUnlocked = true;
    }

    // Reset Q&A detail view when navigating away
    if (!target.isQaSlide) {
      this.qaViewMode = 'list';
      this.selectedQuestionId = null;
    }

    return true;
  }

  navigateRight(): boolean {
    if (!this.canNavigateRight()) return false;
    return this.applySlideTransition(this.currentHorizontalIndex + 1, 0);
  }

  navigateLeft(): boolean {
    if (!this.canNavigateLeft()) return false;
    return this.applySlideTransition(this.currentHorizontalIndex - 1, 0);
  }

  navigateDown(): boolean {
    if (!this.canNavigateDown()) return false;
    return this.applySlideTransition(this.currentHorizontalIndex, this.currentVerticalIndex + 1);
  }

  navigateUp(): boolean {
    if (!this.canNavigateUp()) return false;
    return this.applySlideTransition(this.currentHorizontalIndex, this.currentVerticalIndex - 1);
  }

  jumpToSlide(slideId: string): boolean {
    const target = this.presentation.slides?.find((s) => s.id === slideId);
    if (!target) return false;
    return this.applySlideTransition(target.horizontalIndex, target.verticalIndex);
  }

  // Keyboard navigation handler (SPEC-012, SPEC-023)
  handleKeyDown(keyOrEvent: string | { key: string }): boolean {
    const key = typeof keyOrEvent === 'string' ? keyOrEvent : keyOrEvent.key;

    // SPEC-008: Escape key returns from Q&A detail view to list view
    if (key === 'Escape' && this.qaViewMode === 'detail') {
      this.backToList();
      return true;
    }

    switch (key) {
      case 'ArrowRight':
        return this.navigateRight();
      case 'ArrowLeft':
        return this.navigateLeft();
      case 'ArrowDown':
        return this.navigateDown();
      case 'ArrowUp':
        return this.navigateUp();
      default:
        return false;
    }
  }

  // Real-time HUD updates (SPEC-009, SPEC-012)
  updateParticipantCount(count: number): void {
    this.session.connectedParticipants = Math.max(0, count);
    this.notifyListeners();
  }

  receiveReaction(slideId: string, reaction: Reaction): void {
    let counts = this.reactionsBySlide.get(slideId);
    if (!counts) {
      counts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
      this.reactionsBySlide.set(slideId, counts);
    }
    counts[reaction] += 1;
    this.notifyListeners();
  }

  getReactionsForCurrentSlide(): ReactionCounts {
    const current = this.getCurrentSlide();
    const defaults: ReactionCounts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
    if (!current) return defaults;
    const counts = this.reactionsBySlide.get(current.id);
    return counts ? { ...counts } : defaults;
  }

  subscribe(listener: (state: PresenterViewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const state = this.getViewState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  // Adaptive navigation (SPEC-011)
  setNavigationSuggestion(suggestion: NavigationSuggestion | null): void {
    this.activeSuggestion = suggestion ? { ...suggestion } : null;
  }

  getActiveSuggestion(): NavigationSuggestion | null {
    return this.activeSuggestion ? { ...this.activeSuggestion } : null;
  }

  acceptNavigationSuggestion(): boolean {
    if (!this.activeSuggestion) return false;
    const { targetHorizontalIndex, targetVerticalIndex } = this.activeSuggestion;
    const success = this.applySlideTransition(targetHorizontalIndex, targetVerticalIndex);
    this.activeSuggestion = null;
    return success;
  }

  dismissNavigationSuggestion(): void {
    this.activeSuggestion = null;
  }

  // Embedded Q&A Slide Controller (SPEC-008)
  syncQuestions(questions: AudienceQuestion[]): void {
    this.questions = [...questions];
  }

  // SPEC-006, SPEC-007: Real-time event handler for questions, upvotes, and status changes
  handleRealtimeEvent(event: RealtimeEvent): void {
    if (!event || event.sessionId !== this.session.id) return;

    if (event.type === 'question.submitted') {
      const q = event.payload as AudienceQuestion;
      if (q?.id) {
        this.questions = this.questions.filter((item) => item.id !== q.id).concat(q);
      }
    } else if (event.type === 'question.updated') {
      const q = event.payload as AudienceQuestion;
      const target = this.questions.find((item) => item.id === q?.id);
      if (target) Object.assign(target, q);
    } else if (event.type === 'question.upvoted') {
      const p = event.payload as {
        questionId?: string;
        voteCount?: number;
        upvotes?: number;
        participantId?: string;
        hasUpvoted?: boolean;
        userUpvoted?: boolean;
      };
      const q = this.questions.find((item) => item.id === p?.questionId);
      if (q) {
        q.upvotes = p.voteCount ?? p.upvotes ?? q.upvotes;
        const voted = p.hasUpvoted ?? p.userUpvoted;
        if (p.participantId && typeof voted === 'boolean') {
          const s = new Set(q.upvotedByParticipantIds ?? []);
          if (voted) {
            s.add(p.participantId);
          } else {
            s.delete(p.participantId);
          }
          q.upvotedByParticipantIds = Array.from(s);
        }
      }
      this.notifyListeners();
    } else if (event.type === 'reaction.summary') {
      const p = event.payload as
        | { slideId?: string; counts?: ReactionCounts; summary?: ReactionCounts }
        | Record<string, ReactionCounts>;
      if (p && typeof p === 'object') {
        const candidate = p as {
          slideId?: unknown;
          counts?: unknown;
          summary?: unknown;
        };
        const resolvedCounts = candidate.counts ?? candidate.summary;
        if (
          typeof candidate.slideId === 'string' &&
          resolvedCounts &&
          typeof resolvedCounts === 'object'
        ) {
          this.reactionsBySlide.set(candidate.slideId, {
            ...(resolvedCounts as ReactionCounts),
          });
        } else {
          for (const [sId, counts] of Object.entries(p)) {
            if (counts && typeof counts === 'object') {
              this.reactionsBySlide.set(sId, { ...(counts as ReactionCounts) });
            }
          }
        }
        this.notifyListeners();
      }
    } else if (event.type === 'reaction.added') {
      const p = event.payload as {
        slideId?: string;
        reaction?: Reaction;
        counts?: ReactionCounts;
      };
      if (p?.slideId) {
        if (p.counts && typeof p.counts === 'object') {
          this.reactionsBySlide.set(p.slideId, { ...p.counts });
          this.notifyListeners();
        } else if (p.reaction && ALLOWED_REACTIONS.includes(p.reaction)) {
          this.receiveReaction(p.slideId, p.reaction);
        }
      }
    } else if (event.type === 'poll.opened') {
      const p = event.payload as
        | (PollDefinition & { pollId?: string })
        | (PollResultsSummary & { options?: PollDefinition['options'] });
      const candidateId = 'id' in p ? p.id : undefined;
      const candidatePollId = 'pollId' in p ? p.pollId : undefined;
      const id = candidateId ?? candidatePollId;
      if (id) {
        const existing = this.polls.find((item) => item.id === id);
        if (existing) {
          existing.status = 'open';
          if ('options' in p && Array.isArray(p.options)) existing.options = p.options;
          if ('question' in p && typeof p.question === 'string') existing.question = p.question;
        } else if ('slideId' in p && 'question' in p && 'options' in p) {
          const pollOptions = Array.isArray(p.options) ? (p.options as PollOption[]) : [];
          this.polls.push({
            id,
            sessionId: this.session.id,
            slideId: String(p.slideId),
            question: String(p.question || ''),
            type: p.type || 'single',
            options: pollOptions,
            status: 'open',
            resultsRevealed: false,
          });
        }
        this.notifyListeners();
      }
    } else if (event.type === 'poll.closed') {
      const p = event.payload as { pollId?: string; id?: string };
      const id = p?.pollId ?? p?.id;
      if (id) {
        const existing = this.polls.find((item) => item.id === id);
        if (existing) {
          existing.status = 'closed';
          this.notifyListeners();
        }
      }
    } else if (event.type === 'poll.voted') {
      const p = event.payload as {
        pollId?: string;
        selectedOptionIds?: string[];
        totalResponses?: number;
      };
      if (p?.pollId) {
        let summary = this.pollResults.get(p.pollId);
        if (!summary) {
          const poll = this.polls.find((item) => item.id === p.pollId);
          summary = {
            pollId: p.pollId,
            slideId: poll?.slideId ?? '',
            status: poll?.status ?? 'open',
            resultsRevealed: poll?.resultsRevealed ?? false,
            totalResponses: p.totalResponses ?? 0,
            countsByOptionId: poll ? Object.fromEntries(poll.options.map((o) => [o.id, 0])) : {},
          };
          this.pollResults.set(p.pollId, summary);
        }
        if (p.totalResponses !== undefined) {
          summary.totalResponses = p.totalResponses;
        }
        if (p.selectedOptionIds) {
          for (const optId of p.selectedOptionIds) {
            summary.countsByOptionId[optId] = (summary.countsByOptionId[optId] ?? 0) + 1;
          }
        }
        this.notifyListeners();
      }
    } else if (event.type === 'poll.results') {
      const p = event.payload as {
        pollId?: string;
        results?: Record<string, number>;
        totalVotes?: number;
        resultsRevealed?: boolean;
        summary?: PollResultsSummary;
      };
      const summary =
        p.summary ??
        (p.pollId
          ? {
              pollId: p.pollId,
              slideId: this.polls.find((item) => item.id === p.pollId)?.slideId ?? '',
              status: this.polls.find((item) => item.id === p.pollId)?.status ?? 'closed',
              resultsRevealed: true,
              totalResponses: p.totalVotes ?? 0,
              countsByOptionId: p.results ?? {},
            }
          : null);
      if (summary) {
        this.pollResults.set(summary.pollId, summary);
        const target = this.polls.find((item) => item.id === summary.pollId);
        if (target) {
          target.resultsRevealed = true;
        }
        this.notifyListeners();
      }
    }
  }

  // SPEC-010: Contextual polls management
  setPolls(polls: PollDefinition[]): void {
    this.polls = polls.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o })) }));
    this.notifyListeners();
  }

  addPoll(poll: PollDefinition): void {
    const existingIndex = this.polls.findIndex((p) => p.id === poll.id);
    if (existingIndex >= 0) {
      this.polls[existingIndex] = { ...poll, options: poll.options.map((o) => ({ ...o })) };
    } else {
      this.polls.push({ ...poll, options: poll.options.map((o) => ({ ...o })) });
    }
    this.notifyListeners();
  }

  getPolls(): PollDefinition[] {
    return this.polls.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o })) }));
  }

  getPollsForSlide(slideId: string): PollDefinition[] {
    return this.polls.filter((p) => p.slideId === slideId);
  }

  getActivePollForSlide(slideId?: string): PollDefinition | null {
    const targetSlideId = slideId ?? this.getCurrentSlide()?.id;
    if (!targetSlideId) return null;
    return (
      this.polls.find((p) => p.slideId === targetSlideId && p.status === 'open') ??
      this.polls.find((p) => p.slideId === targetSlideId) ??
      null
    );
  }

  getPollResults(pollId: string): PollResultsSummary | null {
    return this.pollResults.get(pollId) ?? null;
  }

  openPoll(pollId: string): boolean {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll) return false;
    poll.status = 'open';
    this.notifyListeners();
    return true;
  }

  closePoll(pollId: string): boolean {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll) return false;
    poll.status = 'closed';
    this.notifyListeners();
    return true;
  }

  revealPollResults(pollId: string): boolean {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll) return false;
    poll.resultsRevealed = true;
    let summary = this.pollResults.get(pollId);
    if (!summary) {
      summary = {
        pollId,
        slideId: poll.slideId,
        status: poll.status,
        resultsRevealed: true,
        totalResponses: 0,
        countsByOptionId: Object.fromEntries(poll.options.map((o) => [o.id, 0])),
        question: poll.question,
        type: poll.type,
        options: poll.options,
      };
      this.pollResults.set(pollId, summary);
    } else {
      summary.resultsRevealed = true;
    }
    this.notifyListeners();
    return true;
  }

  selectQuestion(questionId: string): boolean {
    const question = this.questions.find((q) => q.id === questionId);
    if (!question) return false;

    // SPEC-008 Invariant: Transitions to internal detail view WITHOUT navigating Reveal.js
    this.qaViewMode = 'detail';
    this.selectedQuestionId = questionId;
    return true;
  }

  backToList(): void {
    this.qaViewMode = 'list';
    this.selectedQuestionId = null;
  }

  setQaSortBy(sortBy: 'votes' | 'time'): void {
    this.qaSortBy = sortBy;
  }

  markQuestionStatus(questionId: string, status: QuestionStatus): void {
    const question = this.questions.find((q) => q.id === questionId);
    if (question) {
      question.status = status;
    }
  }

  // SPEC-006: Presenter updates question status via backend API (answered / dismissed)
  async updateQuestionStatusViaApi(
    endpoint: string,
    questionId: string,
    status: QuestionStatus,
    presenterToken?: string,
    fetchFn?: typeof fetch,
  ): Promise<AudienceQuestion> {
    const fetcher = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetcher) {
      this.markQuestionStatus(questionId, status);
      const q = this.questions.find((item) => item.id === questionId);
      if (!q) throw new Error(`Question ${questionId} not found`);
      return q;
    }

    let cleanEndpoint = endpoint;
    while (cleanEndpoint.endsWith('/')) {
      cleanEndpoint = cleanEndpoint.slice(0, -1);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (presenterToken) {
      headers.Authorization = `Bearer ${presenterToken}`;
    }

    const res = await fetcher(
      `${cleanEndpoint}/api/v1/sessions/${encodeURIComponent(this.session.id)}/questions/${encodeURIComponent(questionId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status }),
      },
    );

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Failed to update question status: ${res.statusText}`);
    }

    const updated = (await res.json()) as AudienceQuestion;
    this.markQuestionStatus(questionId, updated.status);
    return updated;
  }

  getQaState(): QaSlideControllerState {
    const currentSlide = this.getCurrentSlide();
    const isQa = Boolean(currentSlide?.isQaSlide);
    const selected = this.selectedQuestionId
      ? (this.questions.find((q) => q.id === this.selectedQuestionId) ?? null)
      : null;

    let pngUrl: string | null = null;
    let hasPng = false;

    if (selected && this.manifest?.slidePngs[selected.slideId]) {
      const entry = this.manifest.slidePngs[selected.slideId];
      if (entry) {
        pngUrl = `/assets/${entry.r2Key}`;
        hasPng = true;
      }
    }

    return {
      isQaSlideActive: isQa,
      viewMode: this.qaViewMode,
      selectedQuestionId: this.selectedQuestionId,
      selectedQuestion: selected,
      referencedSlidePngUrl: pngUrl,
      hasReferencedSlidePng: hasPng,
      sortBy: this.qaSortBy,
    };
  }

  getQuestions(sortBy = this.qaSortBy): AudienceQuestion[] {
    const copy = [...this.questions];
    if (sortBy === 'votes') {
      return copy.sort((a, b) => {
        if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
        return b.createdAt.localeCompare(a.createdAt);
      });
    }
    return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // SPEC-002, SPEC-022: Explicit session completion
  completeSession(): PresentationSession {
    this.session.status = 'completed';
    this.session.completedAt = new Date().toISOString();
    return this.getSession();
  }

  getViewState(): PresenterViewState {
    const currentSlide = this.getCurrentSlide();
    const slideId = currentSlide?.id ?? '';
    const pollsForCurrentSlide = this.getPollsForSlide(slideId);
    const activePoll = this.getActivePollForSlide(slideId) ?? pollsForCurrentSlide[0] ?? null;
    const activePollResults = activePoll ? (this.pollResults.get(activePoll.id) ?? null) : null;

    return {
      sessionId: this.session.id,
      presentationId: this.presentation.id,
      presentationTitle: this.presentation.title,
      sessionStatus: this.session.status,
      audienceUrl: this.session.audienceUrl,
      qrCodeDataUrl: this.session.qrCodeDataUrl,
      currentSlide,
      horizontalIndex: this.currentHorizontalIndex,
      verticalIndex: this.currentVerticalIndex,
      canNavigateLeft: this.canNavigateLeft(),
      canNavigateRight: this.canNavigateRight(),
      canNavigateUp: this.canNavigateUp(),
      canNavigateDown: this.canNavigateDown(),
      reactions: this.getReactionsForCurrentSlide(),
      questionCount: this.questions.length,
      connectedParticipants: this.session.connectedParticipants ?? 0,
      pdfDownloadUnlocked: this.session.pdfDownloadUnlocked,
      activeSuggestion: this.getActiveSuggestion(),
      qaState: this.getQaState(),
      activePoll,
      activePollResults,
      pollsForCurrentSlide,
      hasAdminControls: false, // SPEC-012: Invariant
    };
  }

  getProjectorViewState(): ProjectorViewState {
    const currentSlide = this.getCurrentSlide();
    const slideId = currentSlide?.id ?? '';
    const pollsForCurrentSlide = this.getPollsForSlide(slideId);
    const revealedPoll = pollsForCurrentSlide.find((p) => p.resultsRevealed) ?? null;
    const projectedPollResults = revealedPoll
      ? (this.pollResults.get(revealedPoll.id) ?? null)
      : null;

    return {
      sessionId: this.session.id,
      presentationTitle: this.presentation.title,
      currentSlide,
      isQaSlide: Boolean(currentSlide?.isQaSlide),
      qaQuestions: this.getQuestions(),
      projectedPoll: revealedPoll,
      projectedPollResults,
      isSuggestionVisibleOnProjection: false, // SPEC-012: Invariant
      hasPresenterOnlyControls: false, // SPEC-012: Invariant
    };
  }
}

// Clean view-model renderers
export function renderPresenterViewHtml(state: PresenterViewState): string {
  // Adaptive navigation suggestion banner (SPEC-011)
  let suggestionBanner = '';
  if (state.activeSuggestion) {
    suggestionBanner = `
      <aside class="suggestion-banner" role="alert" aria-live="assertive">
        <div class="suggestion-content">
          <strong>Suggested Navigation:</strong> ${state.activeSuggestion.reason}
          <span>(Target coordinates: ${state.activeSuggestion.targetHorizontalIndex}, ${state.activeSuggestion.targetVerticalIndex})</span>
        </div>
        <div class="suggestion-actions">
          <button class="btn-confirm" data-action="accept-suggestion">Accept & Jump</button>
          <button class="btn-dismiss" data-action="dismiss-suggestion">Dismiss</button>
        </div>
      </aside>`;
  }

  // Embedded Q&A detail or list overlay (SPEC-008)
  let qaViewHtml = '';
  if (state.qaState.isQaSlideActive) {
    if (state.qaState.viewMode === 'detail' && state.qaState.selectedQuestion) {
      const q = state.qaState.selectedQuestion;
      const slideImageBlock = state.qaState.hasReferencedSlidePng
        ? `<div class="referenced-slide-preview">
             <img src="${state.qaState.referencedSlidePngUrl}" alt="Referenced Slide ${q.slideId}" class="slide-static-img" />
           </div>`
        : `<div class="referenced-slide-fallback">
             <p>Static slide preview image unavailable for this slide.</p>
           </div>`;

      qaViewHtml = `
        <div class="qa-detail-view" role="region" aria-label="Question detail view">
          <div class="qa-detail-header">
            <button class="btn-back" data-action="qa-back">&larr; Back to List (Esc)</button>
            <div class="qa-status-controls">
              <button class="btn-status" data-action="qa-mark-answered" data-id="${q.id}">Mark Answered</button>
              <button class="btn-status" data-action="qa-mark-dismissed" data-id="${q.id}">Dismiss</button>
            </div>
          </div>
          <article class="question-featured">
            <h3>"${q.content}"</h3>
            <p class="question-meta">Submitted by ${q.participantName ?? 'Anonymous'} &bull; ${q.upvotes} upvotes</p>
          </article>
          ${slideImageBlock}
        </div>`;
    } else {
      qaViewHtml = `
        <div class="qa-list-view" role="region" aria-label="Question list view">
          <h3>Audience Questions</h3>
          <p class="qa-hint">Click a question to view referenced slide image</p>
        </div>`;
    }
  }

  // Contextual Polls widget (SPEC-010)
  let pollControlHtml = '';
  if (state.activePoll) {
    const p = state.activePoll;
    const summary = state.activePollResults;
    const totalVotes = summary?.totalResponses ?? 0;
    const optionsHtml = p.options
      .map((opt) => {
        const count = summary?.countsByOptionId[opt.id] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        return `
          <li class="presenter-poll-option">
            <span>${opt.label || opt.text || opt.id}</span>
            <span class="poll-opt-votes">${count} votes (${pct}%)</span>
          </li>`;
      })
      .join('');

    pollControlHtml = `
      <section class="card poll-control-panel" aria-label="Slide Poll Controls">
        <header class="poll-header">
          <h4>Poll: ${p.question}</h4>
          <span class="poll-badge status-${p.status}">${p.status.toUpperCase()}</span>
        </header>
        <ul class="presenter-poll-options">
          ${optionsHtml}
        </ul>
        <div class="poll-actions">
          ${p.status !== 'open' ? `<button class="btn-poll-open" data-action="open-poll" data-id="${p.id}">Open Poll</button>` : ''}
          ${p.status === 'open' ? `<button class="btn-poll-close" data-action="close-poll" data-id="${p.id}">Close Poll</button>` : ''}
          ${!p.resultsRevealed ? `<button class="btn-poll-reveal" data-action="reveal-poll" data-id="${p.id}">Reveal on Projector</button>` : '<span class="revealed-badge">Revealed on Projector</span>'}
        </div>
      </section>`;
  }

  const sessionJoinBanner =
    state.audienceUrl || state.qrCodeDataUrl
      ? `<div class="session-join-banner">
          ${state.audienceUrl ? `<p class="presenter-join-url">Join: <a href="${state.audienceUrl}">${state.audienceUrl}</a></p>` : ''}
          ${state.qrCodeDataUrl ? `<img src="${state.qrCodeDataUrl}" alt="Audience join QR code" class="presenter-qr-code" />` : ''}
        </div>`
      : '';

  return `
    <div class="presenter-console">
      ${suggestionBanner}
      <div class="console-body">
        <section class="slide-viewport" aria-label="Active Slide Viewport">
          <h2 class="slide-title-display">${state.currentSlide?.title ?? 'No slide'}</h2>
          <span class="coordinates-indicator">Coordinates: [${state.horizontalIndex}, ${state.verticalIndex}]</span>
          ${qaViewHtml}
          ${pollControlHtml}
        </section>
        <aside class="presenter-sidebar">
          ${sessionJoinBanner}
          <div class="metrics-hud">
            <div class="metric-item">
              <span class="metric-label">Attendees</span>
              <strong class="metric-value">${state.connectedParticipants}</strong>
            </div>
            <div class="metric-item">
              <span class="metric-label">Questions</span>
              <strong class="metric-value">${state.questionCount}</strong>
            </div>
            <div class="reactions-hud">
              <span>👍 ${state.reactions['👍']}</span>
              <span>🤔 ${state.reactions['🤔']}</span>
              <span>❤️ ${state.reactions['❤️']}</span>
              <span>😴 ${state.reactions['😴']}</span>
            </div>
          </div>
          <nav class="dpad-container" aria-label="Slide directional navigation">
            <div></div>
            <button class="dpad-btn" data-action="nav-up" ${!state.canNavigateUp ? 'disabled' : ''} aria-label="Up">&uarr;</button>
            <div></div>
            <button class="dpad-btn" data-action="nav-left" ${!state.canNavigateLeft ? 'disabled' : ''} aria-label="Left">&larr;</button>
            <div></div>
            <button class="dpad-btn" data-action="nav-right" ${!state.canNavigateRight ? 'disabled' : ''} aria-label="Right">&rarr;</button>
            <div></div>
            <button class="dpad-btn" data-action="nav-down" ${!state.canNavigateDown ? 'disabled' : ''} aria-label="Down">&darr;</button>
            <div></div>
          </nav>
          <div class="session-management">
            <span class="pdf-status">PDF Unlock: ${state.pdfDownloadUnlocked ? 'Unlocked' : 'Locked'}</span>
            <button class="btn-complete-session" data-action="complete-session">Complete Session</button>
          </div>
        </aside>
      </div>
    </div>`;
}

export function renderProjectorViewHtml(state: ProjectorViewState): string {
  // Public projection strictly contains no presenter controls or suggestion banners (SPEC-012)
  let content = '';
  if (state.isQaSlide) {
    const listHtml = state.qaQuestions
      .map(
        (q) => `
        <li class="projector-question-item">
          <span class="q-votes">▲ ${q.upvotes}</span>
          <span class="q-text">${q.content}</span>
        </li>`,
      )
      .join('');

    content = `
      <div class="projector-qa-slide" data-component="audience-qa">
        <h2>Live Audience Q&A</h2>
        <ul class="projector-questions-list">
          ${listHtml || '<li>No questions submitted yet.</li>'}
        </ul>
      </div>`;
  } else if (state.projectedPollResults) {
    const res = state.projectedPollResults;
    const total = Math.max(1, res.totalResponses);
    const optionsHtml = Object.entries(res.countsByOptionId)
      .map(([optId, count]) => {
        const pct = res.totalResponses > 0 ? Math.round((count / total) * 100) : 0;
        return `
        <li class="projector-poll-option">
          <div class="poll-opt-header">
            <span class="poll-opt-label">${optId}</span>
            <span class="poll-opt-stat">${count} votes (${pct}%)</span>
          </div>
          <div class="poll-progress-track">
            <div class="poll-progress-fill" style="width: ${pct}%"></div>
          </div>
        </li>`;
      })
      .join('');

    content = `
      <div class="projector-poll-slide" data-component="audience-poll">
        <h2>${state.projectedPoll?.question ?? 'Live Poll Results'}</h2>
        <ul class="projector-poll-options">
          ${optionsHtml}
        </ul>
        <footer class="projector-poll-footer">
          <span>Total Responses: ${res.totalResponses}</span>
        </footer>
      </div>`;
  } else {
    content = `
      <div class="projector-slide-content">
        <h1>${state.currentSlide?.title ?? state.presentationTitle}</h1>
      </div>`;
  }

  return `
    <div class="projector-display">
      ${content}
    </div>`;
}
