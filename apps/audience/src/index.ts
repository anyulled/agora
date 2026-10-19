import {
  ALLOWED_REACTIONS,
  type AudienceMode,
  type AudienceQuestion,
  type AudienceSafeSessionView,
  type ParticipantIdentity,
  type PollOption,
  type PollResultsSummary,
  type PollStatus,
  type PollType,
  type Reaction,
  type ReactionCounts,
  type RealtimeEvent,
  type SlideMetadata,
  type WebSocketLike,
  type WordCloudAggregate,
} from '@agora/contracts';

export interface AudienceConfig {
  sessionId: string;
  endpoint: string;
  participantToken?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface AudienceViewModel {
  sessionId: string;
  participant: ParticipantIdentity;
  mode: AudienceMode;
  connected: boolean;
  activeSlide: SlideMetadata | null;
  activeSlideIndex: number;
  positionIndicator: string; // SPEC-004: e.g. "Slide 12 of 45"
  totalRevealedSlides: number;
  totalPresentationSlides: number;
  canNavigateSoloPrev: boolean;
  canNavigateSoloNext: boolean;
  containsSlideBodyContent: false; // SPEC-004: Invariant
  canDownloadCurrentSlidePng: boolean;
  canDownloadDeckPdf: boolean;
  currentSlidePngUrl: string | null;
  deckPdfUrl: string | null;
  reactions: ReactionCounts;
  questions: AudienceQuestion[];
  activePoll: PollResultsSummary | null;
  activeWordCloud: WordCloudAggregate | null;
}

export function computeBackoffDelayMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  if (attempt <= 0) return baseMs;
  const exponent = Math.min(attempt, 10);
  const delay = baseMs * 2 ** exponent;
  return Math.min(delay, maxMs);
}

export function buildAudienceWebSocketUrl(
  endpoint: string,
  sessionId: string,
  participantToken?: string,
): string {
  let trimmed = endpoint;
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  const wsBase = trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  const baseUrl = `${wsBase}/api/v1/sessions/${encodeURIComponent(sessionId)}/ws`;
  if (participantToken) {
    return `${baseUrl}?token=${encodeURIComponent(participantToken)}`;
  }
  return baseUrl;
}

export class AudienceAppController {
  private sessionId: string;
  private participant: ParticipantIdentity;
  private mode: AudienceMode = 'follow';
  private connected = true;

  // Session safe view data
  private slides: SlideMetadata[] = [];
  private revealedSlideIds = new Set<string>();
  private availablePngSlideIds = new Set<string>();
  private pdfAvailable = false;
  private pdfDownloadUnlocked = false;
  private speakerCurrentSlideId: string | null = null;
  private soloCurrentSlideId: string | null = null;

  // Interactions data
  private questions: AudienceQuestion[] = [];
  private polls: PollResultsSummary[] = [];
  private wordClouds: WordCloudAggregate[] = [];
  private reactionsBySlide = new Map<string, ReactionCounts>();
  private participantVotesByPollId = new Map<string, string[]>();
  private participantWordSubmissions = new Map<string, Set<string>>();

  // Reactive listeners & WebSocket state
  private listeners = new Set<(vm: AudienceViewModel) => void>();
  private ws: WebSocketLike | null = null;
  private wsConfig: AudienceConfig | null = null;
  private wsRetryAttempt = 0;
  private wsRetryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(sessionId: string, initialIdentity?: ParticipantIdentity) {
    this.sessionId = sessionId;
    const now = new Date().toISOString();
    const randomSuffix =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Date.now().toString(36);
    this.participant = initialIdentity ?? {
      id: `p_${randomSuffix}`,
      sessionId,
      token: `tok_${randomSuffix}`,
      joinedAt: now,
    };
  }

  // Reactive subscription for UI listeners
  subscribe(listener: (vm: AudienceViewModel) => void): () => void {
    this.listeners.add(listener);
    listener(this.getViewModel());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    if (this.destroyed) return;
    const vm = this.getViewModel();
    for (const listener of this.listeners) {
      listener(vm);
    }
  }

  getParticipant(): ParticipantIdentity {
    return { ...this.participant };
  }

  setParticipantDisplayName(name: string): void {
    this.participant.displayName = name.trim();
    this.notifyListeners();
  }

  getMode(): AudienceMode {
    return this.mode;
  }

  isFollowing(): boolean {
    return this.mode === 'follow';
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
    this.notifyListeners();
  }

  // SPEC-002, SPEC-004, SPEC-019: Reconnect and synchronize session state
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

    this.notifyListeners();
  }

  setConnectionStatus(connected: boolean): void {
    this.connected = connected;
    this.notifyListeners();
  }

  // Real-time WebSocket event handler (SPEC-004)
  handleRealtimeEvent(event: RealtimeEvent): void {
    if (!event || typeof event !== 'object') return;

    switch (event.type) {
      case 'slide.changed': {
        const payload = (event.payload ?? {}) as {
          slideId?: string;
          horizontalIndex?: number;
          verticalIndex?: number;
          timestamp?: string;
          revealedSlideIds?: string[];
        };
        if (payload.slideId) {
          this.speakerCurrentSlideId = payload.slideId;
          this.revealedSlideIds.add(payload.slideId);
          if (Array.isArray(payload.revealedSlideIds)) {
            for (const id of payload.revealedSlideIds) {
              this.revealedSlideIds.add(id);
            }
          }
          if (this.mode === 'solo' && !this.soloCurrentSlideId) {
            this.soloCurrentSlideId = payload.slideId;
          }
          this.notifyListeners();
        }
        break;
      }

      case 'session.state': {
        const payload = (event.payload ?? {}) as {
          currentSlideId?: string | null;
          revealedSlideIds?: string[];
          pdfDownloadUnlocked?: boolean;
          session?: {
            currentSlideId?: string | null;
            revealedSlideIds?: string[];
            pdfDownloadUnlocked?: boolean;
          };
          slides?: SlideMetadata[];
        };

        if (payload.session && payload.slides) {
          this.syncSessionView(payload as unknown as AudienceSafeSessionView);
          return;
        }

        if (payload.currentSlideId !== undefined) {
          this.speakerCurrentSlideId = payload.currentSlideId;
        }
        if (Array.isArray(payload.revealedSlideIds)) {
          for (const id of payload.revealedSlideIds) {
            this.revealedSlideIds.add(id);
          }
        }
        if (typeof payload.pdfDownloadUnlocked === 'boolean') {
          this.pdfDownloadUnlocked = payload.pdfDownloadUnlocked;
        }
        if (this.mode === 'solo' && !this.soloCurrentSlideId && this.speakerCurrentSlideId) {
          if (this.revealedSlideIds.has(this.speakerCurrentSlideId)) {
            this.soloCurrentSlideId = this.speakerCurrentSlideId;
          } else {
            const revealed = this.getRevealedSlidesInOrder();
            this.soloCurrentSlideId = revealed[0]?.id ?? null;
          }
        }
        this.notifyListeners();
        break;
      }

      case 'question.submitted':
      case 'question.updated': {
        const q = event.payload as AudienceQuestion;
        if (q?.id) {
          const idx = this.questions.findIndex((item) => item.id === q.id);
          if (idx >= 0) {
            this.questions[idx] = { ...q };
          } else {
            this.questions.push({ ...q });
          }
          this.notifyListeners();
        }
        break;
      }

      case 'question.upvoted': {
        const payload = event.payload as {
          questionId?: string;
          voteCount?: number;
          upvotes?: number;
          participantId?: string;
          hasUpvoted?: boolean;
          userUpvoted?: boolean;
        };
        if (payload?.questionId) {
          const voteCount =
            typeof payload.voteCount === 'number'
              ? payload.voteCount
              : typeof payload.upvotes === 'number'
                ? payload.upvotes
                : undefined;
          if (typeof voteCount === 'number') {
            const q = this.questions.find((item) => item.id === payload.questionId);
            if (q) {
              q.upvotes = voteCount;
              const hasVoted = payload.hasUpvoted ?? payload.userUpvoted;
              if (payload.participantId && typeof hasVoted === 'boolean') {
                const upvoters = new Set(q.upvotedByParticipantIds ?? []);
                if (hasVoted) {
                  upvoters.add(payload.participantId);
                } else {
                  upvoters.delete(payload.participantId);
                }
                q.upvotedByParticipantIds = Array.from(upvoters);
              }
              this.notifyListeners();
            }
          }
        }
        break;
      }

      case 'reaction.summary': {
        const payload = event.payload as
          | { slideId?: string; counts?: ReactionCounts; summary?: ReactionCounts }
          | Record<string, ReactionCounts>;
        if (payload && typeof payload === 'object') {
          const candidate = payload as {
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
            for (const [sId, counts] of Object.entries(payload)) {
              if (counts && typeof counts === 'object') {
                this.reactionsBySlide.set(sId, { ...(counts as ReactionCounts) });
              }
            }
          }
          this.notifyListeners();
        }
        break;
      }

      case 'reaction.added': {
        const payload = event.payload as {
          slideId?: string;
          reaction?: Reaction;
          counts?: ReactionCounts;
        };
        if (payload?.slideId) {
          if (payload.counts && typeof payload.counts === 'object') {
            this.reactionsBySlide.set(payload.slideId, { ...payload.counts });
          } else if (payload.reaction && ALLOWED_REACTIONS.includes(payload.reaction)) {
            let counts = this.reactionsBySlide.get(payload.slideId);
            if (!counts) {
              counts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
              this.reactionsBySlide.set(payload.slideId, counts);
            }
            counts[payload.reaction] += 1;
          }
          this.notifyListeners();
        }
        break;
      }

      case 'presentation.download.unlocked': {
        this.pdfDownloadUnlocked = true;
        this.notifyListeners();
        break;
      }

      case 'poll.opened': {
        const p = event.payload as {
          pollId?: string;
          id?: string;
          slideId?: string;
          question?: string;
          options?: Array<{ id: string; label?: string; text?: string }>;
          type?: string;
          countsByOptionId?: Record<string, number>;
        };
        const pollId = p?.pollId ?? p?.id;
        if (pollId) {
          const counts: Record<string, number> = {};
          if (p.options && Array.isArray(p.options)) {
            for (const opt of p.options) {
              counts[opt.id] = 0;
            }
          }
          const pollEntry: PollResultsSummary = {
            pollId,
            slideId: p.slideId ?? '',
            status: 'open',
            resultsRevealed: false,
            totalResponses: 0,
            countsByOptionId: p.countsByOptionId ?? counts,
            question: p.question,
            type: p.type as PollType,
            options: p.options as PollOption[],
          };
          const idx = this.polls.findIndex((item) => item.pollId === pollId);
          if (idx >= 0) {
            this.polls[idx] = { ...this.polls[idx], ...pollEntry };
          } else {
            this.polls.push(pollEntry);
          }
          this.notifyListeners();
        }
        break;
      }

      case 'poll.closed': {
        const p = event.payload as { pollId?: string; id?: string };
        const pollId = p?.pollId ?? p?.id;
        if (pollId) {
          const poll = this.polls.find((item) => item.pollId === pollId);
          if (poll) {
            poll.status = 'closed';
            this.notifyListeners();
          }
        }
        break;
      }

      case 'poll.voted': {
        const p = event.payload as {
          pollId?: string;
          selectedOptionIds?: string[];
          totalResponses?: number;
        };
        if (p?.pollId) {
          const poll = this.polls.find((item) => item.pollId === p.pollId);
          if (poll) {
            if (p.totalResponses !== undefined) {
              poll.totalResponses = p.totalResponses;
            }
            if (p.selectedOptionIds && Array.isArray(p.selectedOptionIds)) {
              for (const optId of p.selectedOptionIds) {
                poll.countsByOptionId[optId] = (poll.countsByOptionId[optId] ?? 0) + 1;
              }
            }
            this.notifyListeners();
          }
        }
        break;
      }

      case 'poll.results': {
        const p = event.payload as {
          pollId?: string;
          id?: string;
          results?: Record<string, number>;
          totalVotes?: number;
          totalResponses?: number;
          resultsRevealed?: boolean;
          summary?: PollResultsSummary;
          slideId?: string;
          status?: PollStatus;
          countsByOptionId?: Record<string, number>;
          question?: string;
          type?: PollType;
          options?: PollOption[];
        };
        const pollId = p?.pollId ?? p?.id ?? p?.summary?.pollId;
        if (pollId) {
          const s = p.summary;
          const idx = this.polls.findIndex((item) => item.pollId === pollId);
          const totalResponses = p.totalVotes ?? s?.totalResponses ?? p.totalResponses ?? 0;
          const countsByOptionId = p.results ?? s?.countsByOptionId ?? p.countsByOptionId ?? {};
          const status: PollStatus = s?.status ?? p.status ?? 'closed';
          const slideId =
            s?.slideId ?? p.slideId ?? (idx >= 0 ? (this.polls[idx]?.slideId ?? '') : '');
          const question =
            s?.question ?? p.question ?? (idx >= 0 ? this.polls[idx]?.question : undefined);
          const type = s?.type ?? p.type ?? (idx >= 0 ? this.polls[idx]?.type : undefined);
          const options =
            s?.options ?? p.options ?? (idx >= 0 ? this.polls[idx]?.options : undefined);

          const updated: PollResultsSummary = {
            pollId,
            slideId,
            status,
            resultsRevealed: true,
            totalResponses,
            countsByOptionId,
            question,
            type,
            options,
          };
          if (idx >= 0) {
            this.polls[idx] = { ...this.polls[idx], ...updated };
          } else {
            this.polls.push(updated);
          }
          this.notifyListeners();
        }
        break;
      }

      case 'wordcloud.updated': {
        const wc = event.payload as WordCloudAggregate;
        if (wc?.promptId) {
          const idx = this.wordClouds.findIndex((w) => w.promptId === wc.promptId);
          if (idx >= 0) {
            this.wordClouds[idx] = { ...wc };
          } else {
            this.wordClouds.push({ ...wc });
          }
          this.notifyListeners();
        }
        break;
      }

      default:
        break;
    }
  }

  handleMessage(rawMessage: string): void {
    try {
      const parsed = JSON.parse(rawMessage) as RealtimeEvent;
      if (parsed && typeof parsed.type === 'string') {
        this.handleRealtimeEvent(parsed);
      }
    } catch {
      // Ignore non-JSON WebSocket frame
    }
  }

  // HTTP Session State Re-fetch on connect/reconnect
  async refreshSessionState(endpoint: string, fetchFn?: typeof fetch): Promise<void> {
    const fetcher = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetcher) return;

    try {
      let cleanEndpoint = endpoint;
      while (cleanEndpoint.endsWith('/')) {
        cleanEndpoint = cleanEndpoint.slice(0, -1);
      }
      const res = await fetcher(
        `${cleanEndpoint}/api/v1/sessions/${encodeURIComponent(this.sessionId)}`,
      );
      if (res.ok) {
        const view = (await res.json()) as AudienceSafeSessionView;
        this.syncSessionView(view);
      }
    } catch {
      // Ignore fetch error on background sync
    }
  }

  // WebSocket Connection Lifecycle with Auto-Reconnect (SPEC-004, SPEC-019)
  connectWebSocket(config: AudienceConfig): void {
    this.wsConfig = config;
    this.destroyed = false;

    if (this.wsRetryTimeoutId) {
      clearTimeout(this.wsRetryTimeoutId);
      this.wsRetryTimeoutId = null;
    }

    if (this.ws) {
      try {
        this.ws.close?.();
      } catch {
        // Ignore close error on existing socket
      }
      this.ws = null;
    }

    const url = buildAudienceWebSocketUrl(
      config.endpoint,
      this.sessionId,
      config.participantToken ?? this.participant.token,
    );

    try {
      const factory =
        config.webSocketFactory ??
        ((targetUrl: string) => new WebSocket(targetUrl) as unknown as WebSocketLike);
      const socket = factory(url);
      this.ws = socket;

      socket.onopen = async () => {
        if (this.destroyed) return;
        this.connected = true;
        this.wsRetryAttempt = 0;
        if (config.endpoint) {
          try {
            await this.refreshSessionState(config.endpoint, config.fetchFn);
          } catch {
            // Error logged and handled in refreshSessionState
          }
        }
        this.notifyListeners();
      };

      socket.onmessage = (event: unknown) => {
        if (this.destroyed) return;
        const data = (event as { data?: unknown })?.data;
        if (typeof data === 'string') {
          this.handleMessage(data);
        }
      };

      socket.onclose = () => {
        if (this.destroyed) return;
        this.connected = false;
        this.notifyListeners();
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        if (this.destroyed) return;
        this.connected = false;
        this.notifyListeners();
      };
    } catch {
      this.connected = false;
      this.notifyListeners();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.wsConfig) return;
    if (this.wsRetryTimeoutId) {
      clearTimeout(this.wsRetryTimeoutId);
    }
    const delay = computeBackoffDelayMs(
      this.wsRetryAttempt++,
      this.wsConfig.reconnectBaseMs,
      this.wsConfig.reconnectMaxMs,
    );
    this.wsRetryTimeoutId = setTimeout(() => {
      if (!this.destroyed && this.wsConfig) {
        this.connectWebSocket(this.wsConfig);
      }
    }, delay);
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.wsRetryTimeoutId) {
      clearTimeout(this.wsRetryTimeoutId);
      this.wsRetryTimeoutId = null;
    }
    if (this.ws) {
      try {
        this.ws.close?.();
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
    this.connected = false;
    this.notifyListeners();
  }

  // Navigation helpers for Solo mode
  private getRevealedSlidesInOrder(): SlideMetadata[] {
    return this.slides
      .filter((s) => this.revealedSlideIds.has(s.id))
      .sort(
        (a, b) =>
          a.order - b.order ||
          a.horizontalIndex - b.horizontalIndex ||
          a.verticalIndex - b.verticalIndex,
      );
  }

  // Returns all revealed slides in authoritative presentation order (SPEC-005)
  getSoloNavigableSlides(): SlideMetadata[] {
    return this.getRevealedSlidesInOrder();
  }

  // Jump to a specific revealed slide in Solo mode (SPEC-005)
  soloGoToSlide(slideId: string): boolean {
    if (!this.revealedSlideIds.has(slideId)) {
      return false;
    }
    const target = this.slides.find((s) => s.id === slideId);
    if (!target) {
      return false;
    }
    this.mode = 'solo';
    this.soloCurrentSlideId = slideId;
    this.notifyListeners();
    return true;
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
      this.notifyListeners();
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
      this.notifyListeners();
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

    // Whole-slide scoping (SPEC-006): Questions reference slideId, never individual fragment steps
    const canonicalSlideId = activeSlide.id.split(/[#/:]/)[0]!.trim();

    const rand =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Date.now().toString(36);
    const question: AudienceQuestion = {
      id: `q_${Date.now()}_${rand}`,
      sessionId: this.sessionId,
      slideId: canonicalSlideId,
      participantId: this.participant.id,
      participantName: displayName?.trim() || this.participant.displayName || 'Anonymous',
      content: trimmed,
      status: 'pending',
      upvotes: 0,
      upvotedByParticipantIds: [],
      createdAt: new Date().toISOString(),
    };

    this.questions.push(question);
    this.notifyListeners();
    return question;
  }

  // SPEC-006: Asynchronous question submission via HTTP API to live backend
  async submitQuestionToApi(
    content: string,
    displayName?: string,
    fetchFn?: typeof fetch,
  ): Promise<AudienceQuestion> {
    const activeSlide = this.getActiveSlide();
    if (!activeSlide) {
      throw new Error('Cannot submit question without an active slide');
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Question content cannot be empty');
    }

    const endpoint = this.wsConfig?.endpoint;
    const fetcher =
      fetchFn ?? this.wsConfig?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

    if (!endpoint || !fetcher) {
      return this.submitQuestion(content, displayName);
    }

    let cleanEndpoint = endpoint;
    while (cleanEndpoint.endsWith('/')) {
      cleanEndpoint = cleanEndpoint.slice(0, -1);
    }
    const canonicalSlideId = activeSlide.id.split(/[#/:]/)[0]!.trim();
    const resolvedName = displayName?.trim() || this.participant.displayName;

    const res = await fetcher(
      `${cleanEndpoint}/api/v1/sessions/${encodeURIComponent(this.sessionId)}/questions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.participant.token}`,
        },
        body: JSON.stringify({
          slideId: canonicalSlideId,
          content: trimmed,
          participantName: resolvedName,
        }),
      },
    );

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Failed to submit question: ${res.statusText}`);
    }

    const created = (await res.json()) as AudienceQuestion;
    const idx = this.questions.findIndex((q) => q.id === created.id);
    if (idx >= 0) {
      this.questions[idx] = created;
    } else {
      this.questions.push(created);
    }
    this.notifyListeners();
    return created;
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
    this.notifyListeners();
    return question;
  }

  // SPEC-007: Asynchronous upvote toggle via HTTP API to backend
  async toggleUpvoteQuestionViaApi(
    questionId: string,
    fetchFn?: typeof fetch,
  ): Promise<AudienceQuestion & { userUpvoted: boolean; voteCount: number; hasUpvoted?: boolean }> {
    const question = this.questions.find((q) => q.id === questionId);
    if (!question) {
      throw new Error(`Question ${questionId} not found`);
    }

    const endpoint = this.wsConfig?.endpoint;
    const fetcher =
      fetchFn ?? this.wsConfig?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

    if (!endpoint || !fetcher) {
      const updated = this.toggleUpvoteQuestion(questionId);
      const isUpvoted = Boolean(updated.upvotedByParticipantIds?.includes(this.participant.id));
      return {
        ...updated,
        voteCount: updated.upvotes,
        hasUpvoted: isUpvoted,
        userUpvoted: isUpvoted,
      };
    }

    let cleanEndpoint = endpoint;
    while (cleanEndpoint.endsWith('/')) {
      cleanEndpoint = cleanEndpoint.slice(0, -1);
    }
    const res = await fetcher(
      `${cleanEndpoint}/api/v1/sessions/${encodeURIComponent(this.sessionId)}/questions/${encodeURIComponent(questionId)}/upvote`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.participant.token}`,
        },
      },
    );

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Failed to toggle question upvote: ${res.statusText}`);
    }

    const result = (await res.json()) as AudienceQuestion & {
      userUpvoted: boolean;
      voteCount: number;
    };
    const idx = this.questions.findIndex((q) => q.id === questionId);
    if (idx >= 0) {
      this.questions[idx] = {
        ...this.questions[idx],
        ...result,
      };
    }
    this.notifyListeners();
    return result;
  }

  getQuestions(sortBy: 'votes' | 'time' = 'votes'): AudienceQuestion[] {
    const list = [...this.questions];
    if (sortBy === 'votes') {
      return list.sort((a, b) => {
        if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
        return b.createdAt.localeCompare(a.createdAt);
      });
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getQuestionsForActiveSlide(sortBy: 'votes' | 'time' = 'votes'): AudienceQuestion[] {
    const activeId = this.getActiveSlideId();
    if (!activeId) return [];
    return this.getQuestions(sortBy).filter((q) => q.slideId === activeId);
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

    // Send reaction.added over WebSocket if connected
    if (this.ws && (this.ws.readyState === undefined || this.ws.readyState === 1)) {
      try {
        this.ws.send(
          JSON.stringify({
            type: 'reaction.added',
            token: this.participant.token,
            payload: {
              slideId: activeSlide.id,
              reaction,
            },
          }),
        );
      } catch {
        // Safe fallback if socket send fails
      }
    }

    this.notifyListeners();
  }

  // SPEC-009: Asynchronous reaction submission via HTTP API to backend
  async sendReactionToApi(reaction: Reaction, fetchFn?: typeof fetch): Promise<ReactionCounts> {
    if (!ALLOWED_REACTIONS.includes(reaction)) {
      throw new Error(`Invalid reaction: ${reaction}`);
    }

    const activeSlide = this.getActiveSlide();
    if (!activeSlide) {
      return this.getReactionsForActiveSlide();
    }

    const endpoint = this.wsConfig?.endpoint;
    const fetcher =
      fetchFn ?? this.wsConfig?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

    if (!endpoint || !fetcher) {
      this.sendReaction(reaction);
      return this.getReactionsForActiveSlide();
    }

    let cleanEndpoint = endpoint;
    while (cleanEndpoint.endsWith('/')) {
      cleanEndpoint = cleanEndpoint.slice(0, -1);
    }
    const res = await fetcher(
      `${cleanEndpoint}/api/v1/sessions/${encodeURIComponent(this.sessionId)}/reactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.participant.token}`,
        },
        body: JSON.stringify({
          slideId: activeSlide.id,
          reaction,
        }),
      },
    );

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Failed to submit reaction: ${res.statusText}`);
    }

    const result = (await res.json()) as { ok?: boolean; summary?: ReactionCounts };
    if (result.summary) {
      this.reactionsBySlide.set(activeSlide.id, { ...result.summary });
    } else {
      let counts = this.reactionsBySlide.get(activeSlide.id);
      if (!counts) {
        counts = { '👍': 0, '🤔': 0, '❤️': 0, '😴': 0 };
        this.reactionsBySlide.set(activeSlide.id, counts);
      }
      counts[reaction] += 1;
    }

    this.notifyListeners();
    return this.getReactionsForActiveSlide();
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
    this.notifyListeners();
  }

  getActivePollForCurrentSlide(): PollResultsSummary | null {
    const activeId = this.getActiveSlideId();
    if (!activeId) return null;
    return (
      this.polls.find(
        (p) => p.slideId === activeId && (p.status === 'open' || p.resultsRevealed),
      ) ?? null
    );
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
    this.notifyListeners();
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

    const totalPresentationSlides = this.slides.length;
    const slideNumber = activeSlide ? activeSlide.order + 1 : 0;
    const positionIndicator = activeSlide
      ? `Slide ${slideNumber} of ${totalPresentationSlides}`
      : 'No active slide';

    return {
      sessionId: this.sessionId,
      participant: this.getParticipant(),
      mode: this.mode,
      connected: this.connected,
      activeSlide,
      activeSlideIndex: activeIndex,
      positionIndicator,
      totalRevealedSlides: revealedSlides.length,
      totalPresentationSlides,
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
    const poll = vm.activePoll;
    const isRevealed = Boolean(poll.resultsRevealed);
    const totalVotes = Math.max(1, poll.totalResponses);

    const optionsHtml = Object.entries(poll.countsByOptionId)
      .map(([optId, count]) => {
        const opt = poll.options?.find((o) => o.id === optId);
        const labelText = opt?.label || opt?.text || `Option: ${optId}`;
        const pct = poll.totalResponses > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const resultBar = isRevealed
          ? `<div class="poll-bar-track"><div class="poll-bar-fill" style="width: ${pct}%"></div></div>`
          : '';

        return `
        <li class="poll-option-item">
          <button class="btn-poll-option" data-action="vote-poll" data-poll-id="${poll.pollId}" data-option-id="${optId}">
            <span>${labelText}</span>
            <span class="poll-vote-count">(${count} votes${isRevealed ? `, ${pct}%` : ''})</span>
          </button>
          ${resultBar}
        </li>`;
      })
      .join('');

    const heading = poll.question ? `Live Poll: ${poll.question}` : 'Live Poll';
    const footerText = isRevealed
      ? `Results revealed &bull; Total responses: ${poll.totalResponses}`
      : 'Select an option to cast your vote';

    pollWidget = `
      <section class="card poll-widget" aria-label="Active Poll">
        <h4>${heading}</h4>
        <ul class="poll-options-list">
          ${optionsHtml}
        </ul>
        <p class="poll-widget-footer">${footerText}</p>
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
          <div class="mode-status-indicator" role="status" aria-live="polite">
            ${
              isFollow
                ? '<span class="indicator-following">● Following Speaker</span>'
                : `<span class="indicator-solo">Solo Browsing (Slide ${vm.activeSlideIndex} of ${vm.totalRevealedSlides})</span>`
            }
          </div>
          <h3 class="slide-title">${slideTitle}</h3>
          <p class="slide-position-indicator" aria-label="Slide position">${vm.positionIndicator}</p>
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
