import {
  ALLOWED_REACTIONS,
  type ActorRole,
  type AssetManifest,
  type AssetManifestEntry,
  type AudienceMode,
  type AudienceQuestion,
  type AudienceSafeSessionView,
  type NavigationRule,
  type NavigationSuggestion,
  type ParticipantIdentity,
  type PollDefinition,
  type PollResultsSummary,
  type Presentation,
  type PresentationSession,
  type QuestionStatus,
  type Reaction,
  type ReactionCounts,
  type RealtimeEvent,
  type RealtimeEventType,
  type SlideMetadata,
  type WordCloudAggregate,
  type WordCloudPrompt,
} from '@agora/contracts';
import {
  type CreatePresentationInput,
  RateLimiter,
  type RateLimiterOptions,
  aggregateWordCloudSubmissions,
  canDownloadFullPdf,
  canDownloadSlidePng,
  completeSession as completeDomainSession,
  createLiveSession as createDomainLiveSession,
  createPresentation as createDomainPresentation,
  duplicatePresentation as duplicateDomainPresentation,
  editPresentationSlide as editDomainPresentationSlide,
  evaluateAdaptiveNavigationRules,
  navigatePresenterSlide,
  normalizeWordCloudTerm,
  recordPollVote as recordDomainPollVote,
  sanitizeAndValidateQuestion,
  sortQuestions,
  toggleQuestionUpvote,
} from '@agora/domain';

export interface IPresentationRepository {
  savePresentation(presentation: Presentation): void;
  getPresentation(id: string): Presentation | null;
  deletePresentation(id: string): boolean;
  saveSlides(presentationId: string, slides: SlideMetadata[]): void;
  getSlides(presentationId: string): SlideMetadata[];
  saveAssetManifest(manifest: AssetManifest): void;
  getAssetManifest(presentationId: string): AssetManifest | null;
}

export interface ISessionRepository {
  saveSession(session: PresentationSession): void;
  getSession(id: string): PresentationSession | null;
  saveParticipant(participant: ParticipantIdentity): void;
  getParticipant(sessionId: string, participantId: string): ParticipantIdentity | null;
  getParticipantsBySession(sessionId: string): ParticipantIdentity[];
}

export interface IInteractionRepository {
  saveQuestion(question: AudienceQuestion): void;
  getQuestion(id: string): AudienceQuestion | null;
  getQuestionsBySession(sessionId: string, slideId?: string): AudienceQuestion[];

  saveReaction(sessionId: string, slideId: string, reaction: Reaction): void;
  getReactionSummary(sessionId: string, slideId: string): ReactionCounts;
  getAllReactions(sessionId: string): Record<string, ReactionCounts>;

  savePoll(poll: PollDefinition): void;
  getPoll(pollId: string): PollDefinition | null;
  getPollsBySession(sessionId: string): PollDefinition[];
  savePollVote(pollId: string, participantId: string, optionIds: string[]): void;
  getPollVotes(pollId: string): Record<string, string[]>;

  saveNavigationRule(rule: NavigationRule): void;
  getNavigationRules(pollId: string): NavigationRule[];

  saveWordCloudPrompt(prompt: WordCloudPrompt): void;
  getWordCloudPrompt(promptId: string): WordCloudPrompt | null;
  getWordCloudPromptsBySession(sessionId: string): WordCloudPrompt[];
  saveWordCloudSubmission(promptId: string, participantId: string, rawTerm: string): void;
  getWordCloudSubmissions(promptId: string): string[];
}

export interface RegisterAssetOptions {
  pdfSeparateFragments?: boolean;
}

export interface AgoraPlatformServiceOptions {
  presentationRepo?: IPresentationRepository;
  sessionRepo?: ISessionRepository;
  interactionRepo?: IInteractionRepository;
  rateLimiterOptions?: {
    questions?: RateLimiterOptions;
    reactions?: RateLimiterOptions;
    wordClouds?: RateLimiterOptions;
  };
}

export type RealtimeEventListener = (event: RealtimeEvent<unknown>) => void;

function generateOpaqueId(prefix: string): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  const time = Date.now().toString(36);
  const perf =
    typeof performance !== 'undefined' ? performance.now().toString(36).replace('.', '') : '0';
  return `${prefix}_${time}_${perf}`;
}

function emptyReactionCounts(): ReactionCounts {
  return {
    '👍': 0,
    '🤔': 0,
    '❤️': 0,
    '😴': 0,
  };
}

export class InMemoryPresentationRepository implements IPresentationRepository {
  private presentations = new Map<string, Presentation>();
  private slidesByPresentation = new Map<string, SlideMetadata[]>();
  private manifestsByPresentation = new Map<string, AssetManifest>();

  savePresentation(presentation: Presentation): void {
    this.presentations.set(presentation.id, { ...presentation });
  }

  getPresentation(id: string): Presentation | null {
    const pres = this.presentations.get(id);
    return pres ? { ...pres } : null;
  }

  deletePresentation(id: string): boolean {
    this.slidesByPresentation.delete(id);
    this.manifestsByPresentation.delete(id);
    return this.presentations.delete(id);
  }

  saveSlides(presentationId: string, slides: SlideMetadata[]): void {
    this.slidesByPresentation.set(
      presentationId,
      slides.map((s) => ({ ...s })),
    );
  }

  getSlides(presentationId: string): SlideMetadata[] {
    const slides = this.slidesByPresentation.get(presentationId);
    return slides ? slides.map((s) => ({ ...s })) : [];
  }

  saveAssetManifest(manifest: AssetManifest): void {
    this.manifestsByPresentation.set(manifest.presentationId, {
      ...manifest,
      slidePngs: { ...manifest.slidePngs },
    });
  }

  getAssetManifest(presentationId: string): AssetManifest | null {
    const manifest = this.manifestsByPresentation.get(presentationId);
    if (!manifest) return null;
    return {
      ...manifest,
      slidePngs: { ...manifest.slidePngs },
    };
  }
}

export class InMemorySessionRepository implements ISessionRepository {
  private sessions = new Map<string, PresentationSession>();
  private participants = new Map<string, ParticipantIdentity>();

  saveSession(session: PresentationSession): void {
    this.sessions.set(session.id, {
      ...session,
      revealedSlideIds: [...session.revealedSlideIds],
    });
  }

  getSession(id: string): PresentationSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      ...session,
      revealedSlideIds: [...session.revealedSlideIds],
    };
  }

  saveParticipant(participant: ParticipantIdentity): void {
    this.participants.set(`${participant.sessionId}:${participant.id}`, { ...participant });
  }

  getParticipant(sessionId: string, participantId: string): ParticipantIdentity | null {
    const p = this.participants.get(`${sessionId}:${participantId}`);
    return p ? { ...p } : null;
  }

  getParticipantsBySession(sessionId: string): ParticipantIdentity[] {
    const results: ParticipantIdentity[] = [];
    for (const [key, p] of this.participants.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        results.push({ ...p });
      }
    }
    return results;
  }
}

export class InMemoryInteractionRepository implements IInteractionRepository {
  private questions = new Map<string, AudienceQuestion>();
  private reactionsBySlide = new Map<string, ReactionCounts>();
  private polls = new Map<string, PollDefinition>();
  private pollVotes = new Map<string, Record<string, string[]>>();
  private navigationRules = new Map<string, NavigationRule[]>();
  private wordCloudPrompts = new Map<string, WordCloudPrompt>();
  private wordCloudSubmissions = new Map<string, string[]>();

  saveQuestion(question: AudienceQuestion): void {
    this.questions.set(question.id, {
      ...question,
      upvotedByParticipantIds: question.upvotedByParticipantIds
        ? [...question.upvotedByParticipantIds]
        : [],
    });
  }

  getQuestion(id: string): AudienceQuestion | null {
    const q = this.questions.get(id);
    if (!q) return null;
    return {
      ...q,
      upvotedByParticipantIds: q.upvotedByParticipantIds ? [...q.upvotedByParticipantIds] : [],
    };
  }

  getQuestionsBySession(sessionId: string, slideId?: string): AudienceQuestion[] {
    const results: AudienceQuestion[] = [];
    for (const q of this.questions.values()) {
      if (q.sessionId === sessionId) {
        if (!slideId || q.slideId === slideId) {
          results.push({
            ...q,
            upvotedByParticipantIds: q.upvotedByParticipantIds
              ? [...q.upvotedByParticipantIds]
              : [],
          });
        }
      }
    }
    return results;
  }

  saveReaction(sessionId: string, slideId: string, reaction: Reaction): void {
    const key = `${sessionId}:${slideId}`;
    const counts = this.reactionsBySlide.get(key) ?? emptyReactionCounts();
    counts[reaction] = (counts[reaction] ?? 0) + 1;
    this.reactionsBySlide.set(key, { ...counts });
  }

  getReactionSummary(sessionId: string, slideId: string): ReactionCounts {
    const key = `${sessionId}:${slideId}`;
    const counts = this.reactionsBySlide.get(key);
    return counts ? { ...counts } : emptyReactionCounts();
  }

  getAllReactions(sessionId: string): Record<string, ReactionCounts> {
    const summary: Record<string, ReactionCounts> = {};
    for (const [key, counts] of this.reactionsBySlide.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        const slideId = key.split(':')[1];
        if (slideId) {
          summary[slideId] = { ...counts };
        }
      }
    }
    return summary;
  }

  savePoll(poll: PollDefinition): void {
    this.polls.set(poll.id, {
      ...poll,
      options: poll.options.map((o) => ({ ...o })),
    });
  }

  getPoll(pollId: string): PollDefinition | null {
    const poll = this.polls.get(pollId);
    if (!poll) return null;
    return {
      ...poll,
      options: poll.options.map((o) => ({ ...o })),
    };
  }

  getPollsBySession(sessionId: string): PollDefinition[] {
    const results: PollDefinition[] = [];
    for (const p of this.polls.values()) {
      if (p.sessionId === sessionId) {
        results.push({
          ...p,
          options: p.options.map((o) => ({ ...o })),
        });
      }
    }
    return results;
  }

  savePollVote(pollId: string, participantId: string, optionIds: string[]): void {
    const votes = this.pollVotes.get(pollId) ?? {};
    votes[participantId] = [...optionIds];
    this.pollVotes.set(pollId, votes);
  }

  getPollVotes(pollId: string): Record<string, string[]> {
    const votes = this.pollVotes.get(pollId);
    return votes ? { ...votes } : {};
  }

  saveNavigationRule(rule: NavigationRule): void {
    const list = this.navigationRules.get(rule.pollId) ?? [];
    list.push({ ...rule });
    this.navigationRules.set(rule.pollId, list);
  }

  getNavigationRules(pollId: string): NavigationRule[] {
    const list = this.navigationRules.get(pollId);
    return list ? list.map((r) => ({ ...r })) : [];
  }

  saveWordCloudPrompt(prompt: WordCloudPrompt): void {
    this.wordCloudPrompts.set(prompt.id, { ...prompt });
  }

  getWordCloudPrompt(promptId: string): WordCloudPrompt | null {
    const p = this.wordCloudPrompts.get(promptId);
    return p ? { ...p } : null;
  }

  getWordCloudPromptsBySession(sessionId: string): WordCloudPrompt[] {
    const results: WordCloudPrompt[] = [];
    for (const p of this.wordCloudPrompts.values()) {
      if (p.sessionId === sessionId) {
        results.push({ ...p });
      }
    }
    return results;
  }

  saveWordCloudSubmission(promptId: string, _participantId: string, rawTerm: string): void {
    const list = this.wordCloudSubmissions.get(promptId) ?? [];
    list.push(rawTerm);
    this.wordCloudSubmissions.set(promptId, list);
  }

  getWordCloudSubmissions(promptId: string): string[] {
    const list = this.wordCloudSubmissions.get(promptId);
    return list ? [...list] : [];
  }
}

/**
 * AgoraPlatformService orchestrates stateful multi-step workflows across administration,
 * live presentation delivery, audience interactions, and gated downloads.
 */
export class AgoraPlatformService {
  private readonly presentationRepo: IPresentationRepository;
  private readonly sessionRepo: ISessionRepository;
  private readonly interactionRepo: IInteractionRepository;

  private readonly questionRateLimiter: RateLimiter;
  private readonly reactionRateLimiter: RateLimiter;
  private readonly wordCloudRateLimiter: RateLimiter;

  private readonly eventLog: RealtimeEvent<unknown>[] = [];
  private readonly listeners = new Set<RealtimeEventListener>();

  constructor(options?: AgoraPlatformServiceOptions) {
    this.presentationRepo = options?.presentationRepo ?? new InMemoryPresentationRepository();
    this.sessionRepo = options?.sessionRepo ?? new InMemorySessionRepository();
    this.interactionRepo = options?.interactionRepo ?? new InMemoryInteractionRepository();

    this.questionRateLimiter = new RateLimiter(
      options?.rateLimiterOptions?.questions ?? { windowMs: 10_000, maxRequests: 5 },
    );
    this.reactionRateLimiter = new RateLimiter(
      options?.rateLimiterOptions?.reactions ?? { windowMs: 1_000, maxRequests: 10 },
    );
    this.wordCloudRateLimiter = new RateLimiter(
      options?.rateLimiterOptions?.wordClouds ?? { windowMs: 5_000, maxRequests: 5 },
    );
  }

  private emitEvent<T>(type: RealtimeEventType, sessionId: string, payload: T): RealtimeEvent<T> {
    const event: RealtimeEvent<T> = {
      id: generateOpaqueId('evt'),
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.eventLog.push(event as RealtimeEvent<unknown>);
    for (const listener of this.listeners) {
      try {
        listener(event as RealtimeEvent<unknown>);
      } catch {
        // Listener errors should never break internal workflow
      }
    }
    return event;
  }

  // --- Realtime Event Logs & Subscriptions ---

  getEvents(sessionId?: string): RealtimeEvent<unknown>[] {
    if (!sessionId) {
      return [...this.eventLog];
    }
    return this.eventLog.filter((e) => e.sessionId === sessionId);
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Presentation Administration (SPEC-001, SPEC-013, SPEC-015, SPEC-017) ---

  createPresentation(input: CreatePresentationInput): Presentation {
    const presentation = createDomainPresentation(input);
    this.presentationRepo.savePresentation(presentation);
    if (presentation.slides) {
      this.presentationRepo.saveSlides(presentation.id, presentation.slides);
    }
    const initialManifest: AssetManifest = {
      presentationId: presentation.id,
      revision: presentation.revision,
      slidePngs: {},
    };
    this.presentationRepo.saveAssetManifest(initialManifest);
    return presentation;
  }

  getPresentation(id: string): {
    presentation: Presentation;
    slides: SlideMetadata[];
    assetManifest: AssetManifest | null;
  } | null {
    const presentation = this.presentationRepo.getPresentation(id);
    if (!presentation) return null;
    const slides = this.presentationRepo.getSlides(id);
    const assetManifest = this.presentationRepo.getAssetManifest(id);
    return { presentation, slides, assetManifest };
  }

  updatePresentation(presentation: Presentation): Presentation {
    const existing = this.presentationRepo.getPresentation(presentation.id);
    if (!existing) {
      throw new Error(`Presentation '${presentation.id}' not found`);
    }
    const updated: Presentation = {
      ...presentation,
      updatedAt: new Date().toISOString(),
    };
    this.presentationRepo.savePresentation(updated);
    return updated;
  }

  deletePresentation(id: string): boolean {
    return this.presentationRepo.deletePresentation(id);
  }

  publishPresentation(id: string): Presentation {
    const existing = this.presentationRepo.getPresentation(id);
    if (!existing) {
      throw new Error(`Presentation '${id}' not found`);
    }
    const published: Presentation = {
      ...existing,
      status: 'published',
      updatedAt: new Date().toISOString(),
    };
    this.presentationRepo.savePresentation(published);
    return published;
  }

  duplicatePresentation(
    sourceId: string,
    newId: string,
    newTitle?: string,
  ): { presentation: Presentation; slides: SlideMetadata[] } {
    const source = this.presentationRepo.getPresentation(sourceId);
    if (!source) {
      throw new Error(`Source presentation '${sourceId}' not found`);
    }
    const sourceSlides = this.presentationRepo.getSlides(sourceId);
    const result = duplicateDomainPresentation(source, sourceSlides, newId);

    if (newTitle) {
      result.presentation.title = newTitle.trim();
    }

    this.presentationRepo.savePresentation(result.presentation);
    this.presentationRepo.saveSlides(newId, result.slides);

    const initialManifest: AssetManifest = {
      presentationId: newId,
      revision: result.presentation.revision,
      slidePngs: {},
    };
    this.presentationRepo.saveAssetManifest(initialManifest);

    return result;
  }

  editSlide(
    presentationId: string,
    updatedSlide: SlideMetadata,
  ): { presentation: Presentation; assetManifest: AssetManifest; slide: SlideMetadata } {
    const presentation = this.presentationRepo.getPresentation(presentationId);
    if (!presentation) {
      throw new Error(`Presentation '${presentationId}' not found`);
    }
    const slides = this.presentationRepo.getSlides(presentationId);
    const manifest = this.presentationRepo.getAssetManifest(presentationId);

    const editResult = editDomainPresentationSlide(
      { ...presentation, slides },
      manifest ?? undefined,
      updatedSlide,
    );

    this.presentationRepo.savePresentation(editResult.presentation);
    if (editResult.presentation.slides) {
      this.presentationRepo.saveSlides(presentationId, editResult.presentation.slides);
    }
    this.presentationRepo.saveAssetManifest(editResult.assetManifest);

    return {
      presentation: editResult.presentation,
      assetManifest: editResult.assetManifest,
      slide: updatedSlide,
    };
  }

  // --- Asset Registration (SPEC-013, SPEC-015, SPEC-024) ---

  registerAsset(
    presentationId: string,
    entry: AssetManifestEntry,
    options?: RegisterAssetOptions,
  ): AssetManifest {
    const presentation = this.presentationRepo.getPresentation(presentationId);
    if (!presentation) {
      throw new Error(`Presentation '${presentationId}' not found`);
    }

    if (entry.revision !== presentation.revision) {
      throw new Error(
        `Asset revision '${entry.revision}' does not match current presentation revision '${presentation.revision}'`,
      );
    }

    if (entry.kind === 'deck-pdf' && options?.pdfSeparateFragments === true) {
      throw new Error('PDF export must be produced with pdfSeparateFragments: false (SPEC-015)');
    }

    const manifest = this.presentationRepo.getAssetManifest(presentationId) ?? {
      presentationId,
      revision: presentation.revision,
      slidePngs: {},
    };

    if (entry.kind === 'slide-png') {
      if (!entry.slideId) {
        throw new Error('Slide PNG asset registration requires slideId');
      }
      manifest.slidePngs[entry.slideId] = entry;
    } else if (entry.kind === 'deck-pdf') {
      manifest.deckPdf = entry;
    } else if (entry.kind === 'logo') {
      manifest.logo = entry;
    }

    this.presentationRepo.saveAssetManifest(manifest);
    return manifest;
  }

  // --- Live Session Lifecycle (SPEC-002, SPEC-003, SPEC-022, SPEC-023) ---

  createSession(
    presentationId: string,
    sessionId: string,
    baseUrl: string,
    actorRole: ActorRole,
  ): PresentationSession {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: attendees cannot create sessions');
    }
    const presentation = this.presentationRepo.getPresentation(presentationId);
    if (!presentation) {
      throw new Error(`Presentation '${presentationId}' not found`);
    }

    const session = createDomainLiveSession(presentation, sessionId, baseUrl);
    this.sessionRepo.saveSession(session);
    this.emitEvent('session.state', sessionId, session);
    return session;
  }

  getSession(sessionId: string): PresentationSession | null {
    return this.sessionRepo.getSession(sessionId);
  }

  navigateSlide(
    sessionId: string,
    targetSlideId: string,
    actorRole: ActorRole,
  ): PresentationSession {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    const presentation = this.presentationRepo.getPresentation(session.presentationId);
    if (!presentation) {
      throw new Error(`Presentation '${session.presentationId}' not found`);
    }
    const slides = this.presentationRepo.getSlides(presentation.id);

    const previouslyUnlocked = session.pdfDownloadUnlocked;
    const updated = navigatePresenterSlide(
      session,
      slides,
      targetSlideId,
      actorRole,
      presentation.endingSlideId,
    );

    this.sessionRepo.saveSession(updated);

    this.emitEvent('slide.changed', sessionId, {
      currentSlideId: updated.currentSlideId,
      revealedSlideIds: updated.revealedSlideIds,
      pdfDownloadUnlocked: updated.pdfDownloadUnlocked,
    });

    if (!previouslyUnlocked && updated.pdfDownloadUnlocked) {
      this.emitEvent('presentation.download.unlocked', sessionId, {
        unlocked: true,
        endingSlideId: targetSlideId,
      });
    }

    return updated;
  }

  completeSession(sessionId: string, actorRole: ActorRole): PresentationSession {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    const completed = completeDomainSession(session, actorRole);
    this.sessionRepo.saveSession(completed);
    this.emitEvent('session.state', sessionId, completed);
    return completed;
  }

  // --- Participant Join & Identity (SPEC-002, SPEC-018) ---

  joinSession(sessionId: string, rawDisplayName?: string): ParticipantIdentity {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (session.status === 'completed') {
      throw new Error('Cannot join completed session');
    }

    const participantId = generateOpaqueId('part');
    const token = generateOpaqueId('tok');

    let displayName: string | undefined;
    if (rawDisplayName) {
      const stripped = rawDisplayName.replace(/<[^>]*>/g, '').trim();
      if (stripped.length > 0) {
        displayName = stripped.slice(0, 50);
      }
    }

    const participant: ParticipantIdentity = {
      id: participantId,
      sessionId,
      token,
      displayName,
      joinedAt: new Date().toISOString(),
    };

    this.sessionRepo.saveParticipant(participant);

    const updatedSession: PresentationSession = {
      ...session,
      connectedParticipants: (session.connectedParticipants ?? 0) + 1,
    };
    this.sessionRepo.saveSession(updatedSession);

    this.emitEvent('session.joined', sessionId, {
      participantId: participant.id,
      displayName: participant.displayName,
      connectedParticipants: updatedSession.connectedParticipants,
    });

    return participant;
  }

  // --- Audience Safe View & Navigation Validation (SPEC-004, SPEC-005, SPEC-014, SPEC-016) ---

  validateSlideAccess(sessionId: string, slideId: string, mode: AudienceMode): boolean {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) return false;

    if (mode === 'solo') {
      return session.revealedSlideIds.includes(slideId);
    }
    return session.currentSlideId === slideId;
  }

  getAudienceSafeView(sessionId: string): AudienceSafeSessionView {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    const presentation = this.presentationRepo.getPresentation(session.presentationId);
    if (!presentation) {
      throw new Error(`Presentation '${session.presentationId}' not found`);
    }
    const slides = this.presentationRepo.getSlides(presentation.id);
    const assetManifest = this.presentationRepo.getAssetManifest(presentation.id);

    const availablePngSlideIds = assetManifest
      ? slides.filter((s) => canDownloadSlidePng(session, s.id, assetManifest)).map((s) => s.id)
      : [];

    const pdfAvailable = assetManifest ? canDownloadFullPdf(session, assetManifest) : false;

    const questions = this.interactionRepo.getQuestionsBySession(sessionId);
    const polls = this.interactionRepo.getPollsBySession(sessionId);
    const activePolls: PollResultsSummary[] = polls.map((p) => this.computePollSummary(p));

    const wordCloudPrompts = this.interactionRepo.getWordCloudPromptsBySession(sessionId);
    const activeWordClouds: WordCloudAggregate[] = wordCloudPrompts.map((p) => {
      const submissions = this.interactionRepo.getWordCloudSubmissions(p.id);
      return aggregateWordCloudSubmissions(p, submissions);
    });

    const reactionSummary = this.interactionRepo.getAllReactions(sessionId);

    return {
      session,
      slides,
      availablePngSlideIds,
      pdfAvailable,
      questions,
      activePolls,
      activeWordClouds,
      reactionSummary,
    };
  }

  // --- Q&A (SPEC-006, SPEC-007, SPEC-008, SPEC-018) ---

  submitQuestion(
    sessionId: string,
    participantId: string,
    slideId: string,
    rawContent: string,
    rawParticipantName?: string,
  ): AudienceQuestion {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (!session.revealedSlideIds.includes(slideId)) {
      throw new Error('Cannot submit questions on unrevealed slide');
    }

    if (!this.questionRateLimiter.consume(participantId)) {
      throw new Error('Rate limit exceeded for submitting questions');
    }

    const sanitized = sanitizeAndValidateQuestion(rawContent, rawParticipantName);

    const question: AudienceQuestion = {
      id: generateOpaqueId('q'),
      sessionId,
      slideId,
      participantId,
      participantName: sanitized.participantName,
      content: sanitized.content,
      status: 'pending',
      upvotes: 0,
      upvotedByParticipantIds: [],
      createdAt: new Date().toISOString(),
    };

    this.interactionRepo.saveQuestion(question);
    this.emitEvent('question.submitted', sessionId, question);
    return question;
  }

  moderateQuestion(
    sessionId: string,
    questionId: string,
    newStatus: QuestionStatus,
    actorRole: ActorRole,
  ): AudienceQuestion {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may moderate questions');
    }

    const question = this.interactionRepo.getQuestion(questionId);
    if (!question || question.sessionId !== sessionId) {
      throw new Error(`Question '${questionId}' not found in session`);
    }

    const updated: AudienceQuestion = {
      ...question,
      status: newStatus,
    };

    this.interactionRepo.saveQuestion(updated);
    this.emitEvent('question.updated', sessionId, updated);
    return updated;
  }

  upvoteQuestion(sessionId: string, questionId: string, participantId: string): AudienceQuestion {
    const question = this.interactionRepo.getQuestion(questionId);
    if (!question || question.sessionId !== sessionId) {
      throw new Error(`Question '${questionId}' not found in session`);
    }

    const updated = toggleQuestionUpvote(question, participantId);
    this.interactionRepo.saveQuestion(updated);

    this.emitEvent('question.upvoted', sessionId, {
      questionId: updated.id,
      upvotes: updated.upvotes,
    });

    return updated;
  }

  getQuestions(
    sessionId: string,
    slideId?: string,
    sortBy: 'votes' | 'time' = 'votes',
  ): AudienceQuestion[] {
    const list = this.interactionRepo.getQuestionsBySession(sessionId, slideId);
    return sortQuestions(list, sortBy);
  }

  // --- Emoji Reactions (SPEC-009, SPEC-018) ---

  recordReaction(
    sessionId: string,
    participantId: string,
    slideId: string,
    reaction: Reaction,
  ): ReactionCounts {
    if (!this.reactionRateLimiter.consume(participantId)) {
      throw new Error('Rate limit exceeded for reactions');
    }

    if (!ALLOWED_REACTIONS.includes(reaction)) {
      throw new Error(`Invalid reaction '${reaction}'`);
    }

    this.interactionRepo.saveReaction(sessionId, slideId, reaction);
    const summary = this.interactionRepo.getReactionSummary(sessionId, slideId);

    this.emitEvent('reaction.added', sessionId, {
      slideId,
      reaction,
    });
    this.emitEvent('reaction.summary', sessionId, {
      slideId,
      summary,
    });

    return summary;
  }

  getReactionSummary(sessionId: string, slideId: string): ReactionCounts {
    return this.interactionRepo.getReactionSummary(sessionId, slideId);
  }

  // --- Contextual Polls & Adaptive Navigation (SPEC-010, SPEC-011, SPEC-018) ---

  createPoll(
    sessionId: string,
    pollInput: Omit<PollDefinition, 'status' | 'resultsRevealed'>,
    actorRole: ActorRole,
  ): PollDefinition {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may create polls');
    }

    const poll: PollDefinition = {
      ...pollInput,
      sessionId,
      status: 'draft',
      resultsRevealed: false,
    };

    this.interactionRepo.savePoll(poll);
    return poll;
  }

  openPoll(sessionId: string, pollId: string, actorRole: ActorRole): PollDefinition {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may open polls');
    }

    const poll = this.interactionRepo.getPoll(pollId);
    if (!poll || poll.sessionId !== sessionId) {
      throw new Error(`Poll '${pollId}' not found in session`);
    }

    const opened: PollDefinition = { ...poll, status: 'open' };
    this.interactionRepo.savePoll(opened);
    this.emitEvent('poll.opened', sessionId, opened);
    return opened;
  }

  closePoll(sessionId: string, pollId: string, actorRole: ActorRole): PollDefinition {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may close polls');
    }

    const poll = this.interactionRepo.getPoll(pollId);
    if (!poll || poll.sessionId !== sessionId) {
      throw new Error(`Poll '${pollId}' not found in session`);
    }

    const closed: PollDefinition = { ...poll, status: 'closed' };
    this.interactionRepo.savePoll(closed);
    this.emitEvent('poll.closed', sessionId, closed);
    return closed;
  }

  revealPollResults(sessionId: string, pollId: string, actorRole: ActorRole): PollDefinition {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may reveal poll results');
    }

    const poll = this.interactionRepo.getPoll(pollId);
    if (!poll || poll.sessionId !== sessionId) {
      throw new Error(`Poll '${pollId}' not found in session`);
    }

    const revealed: PollDefinition = { ...poll, resultsRevealed: true };
    this.interactionRepo.savePoll(revealed);
    const summary = this.computePollSummary(revealed);
    this.emitEvent('poll.results', sessionId, summary);
    return revealed;
  }

  private computePollSummary(poll: PollDefinition): PollResultsSummary {
    const votes = this.interactionRepo.getPollVotes(poll.id);
    const countsByOptionId: Record<string, number> = {};
    for (const opt of poll.options) {
      countsByOptionId[opt.id] = 0;
    }

    let totalResponses = 0;
    for (const optionIds of Object.values(votes)) {
      totalResponses += 1;
      for (const optId of optionIds) {
        if (countsByOptionId[optId] !== undefined) {
          countsByOptionId[optId] += 1;
        }
      }
    }

    return {
      pollId: poll.id,
      slideId: poll.slideId,
      status: poll.status,
      resultsRevealed: poll.resultsRevealed,
      totalResponses,
      countsByOptionId,
    };
  }

  votePoll(
    sessionId: string,
    pollId: string,
    participantId: string,
    selectedOptionIds: string[],
  ): PollResultsSummary {
    const poll = this.interactionRepo.getPoll(pollId);
    if (!poll || poll.sessionId !== sessionId) {
      throw new Error(`Poll '${pollId}' not found in session`);
    }

    const existingVotes = this.interactionRepo.getPollVotes(pollId);
    recordDomainPollVote(poll, existingVotes, participantId, selectedOptionIds);

    this.interactionRepo.savePollVote(pollId, participantId, selectedOptionIds);
    const summary = this.computePollSummary(poll);

    this.emitEvent('poll.voted', sessionId, {
      pollId,
      participantId,
      totalResponses: summary.totalResponses,
    });

    // Check adaptive navigation rules upon votes
    const rules = this.interactionRepo.getNavigationRules(pollId);
    if (rules.length > 0) {
      const suggestions = evaluateAdaptiveNavigationRules(rules, summary);
      for (const suggestion of suggestions) {
        this.emitEvent('navigation.suggested', sessionId, suggestion);
      }
    }

    return summary;
  }

  addNavigationRule(rule: NavigationRule, actorRole: ActorRole): void {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may add navigation rules');
    }
    this.interactionRepo.saveNavigationRule(rule);
  }

  getNavigationRules(pollId: string): NavigationRule[] {
    return this.interactionRepo.getNavigationRules(pollId);
  }

  checkAdaptiveNavigation(sessionId: string, pollId: string): NavigationSuggestion[] {
    const poll = this.interactionRepo.getPoll(pollId);
    if (!poll || poll.sessionId !== sessionId) {
      return [];
    }
    const summary = this.computePollSummary(poll);
    const rules = this.interactionRepo.getNavigationRules(pollId);
    return evaluateAdaptiveNavigationRules(rules, summary);
  }

  confirmAdaptiveNavigation(
    sessionId: string,
    suggestion: NavigationSuggestion,
    actorRole: ActorRole,
  ): PresentationSession {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may confirm adaptive navigation');
    }
    return this.navigateSlide(sessionId, suggestion.targetSlideId, actorRole);
  }

  // --- Word Clouds (SPEC-021) ---

  createWordCloud(
    sessionId: string,
    promptInput: Omit<WordCloudPrompt, 'status'>,
    actorRole: ActorRole,
  ): WordCloudPrompt {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may create word clouds');
    }

    const prompt: WordCloudPrompt = {
      ...promptInput,
      sessionId,
      status: 'draft',
    };

    this.interactionRepo.saveWordCloudPrompt(prompt);
    return prompt;
  }

  openWordCloud(sessionId: string, promptId: string, actorRole: ActorRole): WordCloudPrompt {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may open word clouds');
    }

    const prompt = this.interactionRepo.getWordCloudPrompt(promptId);
    if (!prompt || prompt.sessionId !== sessionId) {
      throw new Error(`Word cloud prompt '${promptId}' not found in session`);
    }

    const opened: WordCloudPrompt = { ...prompt, status: 'open' };
    this.interactionRepo.saveWordCloudPrompt(opened);
    return opened;
  }

  closeWordCloud(sessionId: string, promptId: string, actorRole: ActorRole): WordCloudPrompt {
    if (actorRole === 'attendee') {
      throw new Error('Unauthorized: only presenter or admin may close word clouds');
    }

    const prompt = this.interactionRepo.getWordCloudPrompt(promptId);
    if (!prompt || prompt.sessionId !== sessionId) {
      throw new Error(`Word cloud prompt '${promptId}' not found in session`);
    }

    const closed: WordCloudPrompt = { ...prompt, status: 'closed' };
    this.interactionRepo.saveWordCloudPrompt(closed);
    return closed;
  }

  submitWordCloudTerm(
    sessionId: string,
    promptId: string,
    participantId: string,
    rawTerm: string,
  ): WordCloudAggregate {
    if (!this.wordCloudRateLimiter.consume(participantId)) {
      throw new Error('Rate limit exceeded for word cloud submissions');
    }

    const prompt = this.interactionRepo.getWordCloudPrompt(promptId);
    if (!prompt || prompt.sessionId !== sessionId) {
      throw new Error(`Word cloud prompt '${promptId}' not found in session`);
    }
    if (prompt.status !== 'open') {
      throw new Error(`Word cloud prompt is ${prompt.status}, submissions only allowed when open`);
    }

    const normalized = normalizeWordCloudTerm(rawTerm);
    if (normalized.length === 0) {
      throw new Error('Word cloud term cannot be empty');
    }

    this.interactionRepo.saveWordCloudSubmission(promptId, participantId, normalized);

    const submissions = this.interactionRepo.getWordCloudSubmissions(promptId);
    const aggregate = aggregateWordCloudSubmissions(prompt, submissions);

    this.emitEvent('wordcloud.submitted', sessionId, {
      promptId,
      participantId,
      term: normalized,
    });
    this.emitEvent('wordcloud.updated', sessionId, aggregate);

    return aggregate;
  }

  getWordCloudAggregate(sessionId: string, promptId: string): WordCloudAggregate {
    const prompt = this.interactionRepo.getWordCloudPrompt(promptId);
    if (!prompt || prompt.sessionId !== sessionId) {
      throw new Error(`Word cloud prompt '${promptId}' not found in session`);
    }
    const submissions = this.interactionRepo.getWordCloudSubmissions(promptId);
    return aggregateWordCloudSubmissions(prompt, submissions);
  }

  // --- Gated Asset Downloads (SPEC-014, SPEC-016, SPEC-024) ---

  downloadSlidePng(
    sessionId: string,
    slideId: string,
    _participantId?: string,
  ): { r2Key: string; contentType: string } {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    const manifest = this.presentationRepo.getAssetManifest(session.presentationId);
    if (!manifest) {
      throw new Error('Asset manifest not found');
    }

    if (!canDownloadSlidePng(session, slideId, manifest)) {
      throw new Error('Slide PNG download not permitted or asset not available');
    }

    const asset = manifest.slidePngs[slideId];
    if (!asset) {
      throw new Error(`Asset entry for slide '${slideId}' missing`);
    }

    return {
      r2Key: asset.r2Key,
      contentType: asset.contentType,
    };
  }

  downloadFullPdf(
    sessionId: string,
    _participantId?: string,
  ): { r2Key: string; contentType: string } {
    const session = this.sessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    const manifest = this.presentationRepo.getAssetManifest(session.presentationId);
    if (!manifest) {
      throw new Error('Asset manifest not found');
    }

    if (!canDownloadFullPdf(session, manifest)) {
      throw new Error('Full presentation PDF download not permitted or asset not available');
    }

    const asset = manifest.deckPdf;
    if (!asset) {
      throw new Error('Deck PDF asset entry missing');
    }

    return {
      r2Key: asset.r2Key,
      contentType: asset.contentType,
    };
  }
}
