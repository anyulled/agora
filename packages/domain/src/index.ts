import type {
  ActorRole,
  AssetManifest,
  AudienceQuestion,
  NavigationRule,
  NavigationSuggestion,
  PollDefinition,
  PollResultsSummary,
  Presentation,
  PresentationBranding,
  PresentationSession,
  PresentationStatus,
  SlideMetadata,
  WordCloudAggregate,
  WordCloudPrompt,
} from '@agora/contracts';

export interface CreatePresentationInput {
  id: string;
  title: string;
  description?: string;
  eventName?: string;
  endingSlideId: string;
  branding: PresentationBranding;
  slides?: SlideMetadata[];
  initialRevision?: string;
  status?: PresentationStatus;
}

export interface EditPresentationSlideResult {
  presentation: Presentation;
  assetManifest: AssetManifest;
}

export interface DuplicatePresentationResult {
  presentation: Presentation;
  slides: SlideMetadata[];
}

export interface PollVoteRecord {
  participantId: string;
  optionIds: string[];
  votedAt: string;
}

export interface SanitizedQuestionResult {
  content: string;
  participantName?: string;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Pure TypeScript SHA-256 digest (FIPS 180-4) with zero runtime/platform imports.
 */
export function sha256Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const totalBytes = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(utf8);
  padded[utf8.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalBytes - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(7, w15) ^ rotr(18, w15) ^ (w15 >>> 3);
      const s1 = rotr(17, w2) ^ rotr(19, w2) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export interface RevisionHashInput {
  title: string;
  description?: string;
  eventName?: string;
  endingSlideId: string;
  branding?: PresentationBranding;
  slides?: SlideMetadata[];
}

/**
 * Computes a deterministic cryptographic SHA-256 revision hash from presentation attributes and ordered slide metadata (SPEC-001b).
 */
export function computePresentationRevisionHash(input: RevisionHashInput): string {
  const orderedSlides = [...(input.slides ?? [])]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      h: s.horizontalIndex,
      v: s.verticalIndex,
      order: s.order,
      qa: Boolean(s.isQaSlide),
    }));

  const sortedColors = Object.entries(input.branding?.colors ?? {}).sort(([k1], [k2]) =>
    k1.localeCompare(k2),
  );

  const canonicalPayload = JSON.stringify({
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    eventName: input.eventName?.trim() ?? '',
    endingSlideId: input.endingSlideId.trim(),
    branding: {
      colors: sortedColors,
      logoAssetId: input.branding?.logoAssetId ?? '',
    },
    slides: orderedSlides,
  });

  return `sha256:${sha256Hex(canonicalPayload)}`;
}

/**
 * Increments presentation revision identifier (e.g. rev-1 -> rev-2).
 */
export function bumpRevision(currentRevision: string): string {
  const match = currentRevision.match(/^(.*?)(\d+)$/);
  if (match) {
    const prefix = match[1] ?? '';
    const num = Number.parseInt(match[2] ?? '0', 10);
    return `${prefix}${num + 1}`;
  }
  return `${currentRevision}-2`;
}

/**
 * Creates a new Presentation entity with validated metadata and initial revision (SPEC-001).
 */
export function createPresentation(input: CreatePresentationInput): Presentation {
  if (!input.id || input.id.trim() === '') {
    throw new Error('Presentation ID is required');
  }
  const trimmedTitle = input.title.trim();
  if (!trimmedTitle) {
    throw new Error('Presentation title cannot be empty');
  }
  if (!input.endingSlideId || input.endingSlideId.trim() === '') {
    throw new Error('Ending slide ID is required');
  }

  const now = new Date().toISOString();
  const slides = input.slides ? input.slides.map((s) => ({ ...s })) : [];
  const branding: PresentationBranding = {
    colors: { ...input.branding.colors },
    logoAssetId: input.branding.logoAssetId,
  };
  const endingSlideId = input.endingSlideId.trim();
  const description = input.description?.trim();
  const eventName = input.eventName?.trim();

  return {
    id: input.id.trim(),
    title: trimmedTitle,
    description,
    eventName,
    revision: input.initialRevision?.trim() || 'rev-1',
    revisionHash: computePresentationRevisionHash({
      title: trimmedTitle,
      description,
      eventName,
      endingSlideId,
      branding,
      slides,
    }),
    status: input.status ?? 'draft',
    endingSlideId,
    branding,
    slides,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Edits a presentation slide, bumping presentation revision and invalidating stale assets (SPEC-001, SPEC-013, SPEC-015).
 */
export function editPresentationSlide(
  presentation: Presentation,
  assets: AssetManifest | undefined,
  updatedSlide: SlideMetadata,
): EditPresentationSlideResult {
  if (!presentation.slides || presentation.slides.length === 0) {
    throw new Error('Presentation has no slides to edit');
  }
  const slideIndex = presentation.slides.findIndex((s) => s.id === updatedSlide.id);
  if (slideIndex === -1) {
    throw new Error(`Slide '${updatedSlide.id}' not found in presentation`);
  }

  const newSlides = [...presentation.slides];
  newSlides[slideIndex] = { ...updatedSlide, presentationId: presentation.id };

  const nextRevision = bumpRevision(presentation.revision);
  const nextRevisionHash = computePresentationRevisionHash({
    title: presentation.title,
    description: presentation.description,
    eventName: presentation.eventName,
    endingSlideId: presentation.endingSlideId,
    branding: presentation.branding,
    slides: newSlides,
  });
  const now = new Date().toISOString();

  const updatedPresentation: Presentation = {
    ...presentation,
    revision: nextRevision,
    revisionHash: nextRevisionHash,
    slides: newSlides,
    updatedAt: now,
  };

  const invalidatedManifest: AssetManifest = {
    presentationId: presentation.id,
    revision: nextRevision,
    slidePngs: {},
    deckPdf: undefined,
    logo: assets?.logo,
  };

  return {
    presentation: updatedPresentation,
    assetManifest: invalidatedManifest,
  };
}

/**
 * Duplicates a presentation, copying content and branding without sessions, votes, or questions (SPEC-001, SPEC-017).
 */
export function duplicatePresentation(
  sourcePresentation: Presentation,
  sourceSlides: SlideMetadata[],
  newId: string,
  newRevision?: string,
): DuplicatePresentationResult {
  if (!newId || newId.trim() === '') {
    throw new Error('New presentation ID is required');
  }
  if (newId === sourcePresentation.id) {
    throw new Error('Duplicated presentation must have a distinct ID');
  }

  const now = new Date().toISOString();
  const revision = newRevision?.trim() || 'rev-1';

  const duplicatedSlides: SlideMetadata[] = sourceSlides.map((slide) => ({
    ...slide,
    presentationId: newId,
  }));

  const title = `${sourcePresentation.title} (Copy)`;
  const branding: PresentationBranding = {
    colors: { ...sourcePresentation.branding.colors },
    logoAssetId: sourcePresentation.branding.logoAssetId,
  };

  const duplicatedPresentation: Presentation = {
    id: newId,
    title,
    description: sourcePresentation.description,
    eventName: sourcePresentation.eventName,
    revision,
    revisionHash: computePresentationRevisionHash({
      title,
      description: sourcePresentation.description,
      eventName: sourcePresentation.eventName,
      endingSlideId: sourcePresentation.endingSlideId,
      branding,
      slides: duplicatedSlides,
    }),
    status: 'draft',
    endingSlideId: sourcePresentation.endingSlideId,
    branding,
    slides: duplicatedSlides,
    createdAt: now,
    updatedAt: now,
  };

  return {
    presentation: duplicatedPresentation,
    slides: duplicatedSlides,
  };
}

export interface CreateSessionOptions {
  initialStatus?: 'scheduled' | 'live';
  firstSlideId?: string | null;
}

/**
 * Creates a live or scheduled presentation session (SPEC-002).
 */
export function createLiveSession(
  presentation: Presentation,
  sessionId: string,
  baseUrl: string,
  options?: CreateSessionOptions,
): PresentationSession {
  if (!sessionId || sessionId.trim() === '') {
    throw new Error('Session ID is required');
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const audienceUrl = `${cleanBase}/session/${sessionId}`;
  const qrCodeDataUrl = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="50">QR:${sessionId}</text></svg>`;
  const status = options?.initialStatus ?? 'live';
  const firstSlideId = status === 'live' ? (options?.firstSlideId ?? null) : null;

  return {
    id: sessionId,
    presentationId: presentation.id,
    presentationRevision: presentation.revision,
    status,
    currentSlideId: firstSlideId,
    revealedSlideIds: firstSlideId ? [firstSlideId] : [],
    pdfDownloadUnlocked: false,
    audienceUrl,
    qrCodeDataUrl,
    connectedParticipants: 0,
    startedAt: status === 'live' ? new Date().toISOString() : undefined,
  };
}

/**
 * Transitions a scheduled presentation session to live status (SPEC-002).
 */
export function startScheduledSession(
  session: PresentationSession,
  slides: SlideMetadata[],
  actorRole: ActorRole,
): PresentationSession {
  if (actorRole === 'attendee') {
    throw new Error('Unauthorized: attendee cannot start session');
  }
  if (session.status === 'completed') {
    throw new Error('Cannot start a completed session');
  }
  const firstSlide = slides[0];
  const currentSlideId = session.currentSlideId ?? firstSlide?.id ?? null;
  const revealedSlideIds =
    currentSlideId && !session.revealedSlideIds.includes(currentSlideId)
      ? [...session.revealedSlideIds, currentSlideId]
      : [...session.revealedSlideIds];

  return {
    ...session,
    status: 'live',
    currentSlideId,
    revealedSlideIds,
    startedAt: session.startedAt ?? new Date().toISOString(),
  };
}

/**
 * Navigates the authoritative presenter slide (SPEC-003, SPEC-004, SPEC-005, SPEC-016, SPEC-022, SPEC-023).
 */
export function navigatePresenterSlide(
  session: PresentationSession,
  slides: SlideMetadata[],
  targetSlideId: string,
  actorRole: ActorRole,
  endingSlideId?: string,
): PresentationSession {
  if (actorRole === 'attendee') {
    throw new Error('Unauthorized: attendee cannot navigate presenter slide');
  }
  if (session.status === 'completed') {
    throw new Error('Cannot navigate completed session');
  }

  const slideExists = slides.some((s) => s.id === targetSlideId);
  if (!slideExists) {
    throw new Error(`Target slide '${targetSlideId}' does not exist in presentation`);
  }

  const alreadyRevealed = session.revealedSlideIds.includes(targetSlideId);
  const revealedSlideIds = alreadyRevealed
    ? session.revealedSlideIds
    : [...session.revealedSlideIds, targetSlideId];

  const reachesEndingSlide = targetSlideId === endingSlideId;
  const pdfDownloadUnlocked = session.pdfDownloadUnlocked || reachesEndingSlide;

  return {
    ...session,
    currentSlideId: targetSlideId,
    revealedSlideIds,
    pdfDownloadUnlocked,
  };
}

/**
 * Explicitly marks a presentation session as completed (SPEC-002, SPEC-022).
 */
export function completeSession(
  session: PresentationSession,
  actorRole: ActorRole,
): PresentationSession {
  if (actorRole === 'attendee') {
    throw new Error('Unauthorized: attendee cannot complete session');
  }

  return {
    ...session,
    status: 'completed',
    completedAt: new Date().toISOString(),
  };
}

/**
 * Returns slides that have been revealed, sorted strictly by order (SPEC-005).
 */
export function getSoloNavigableSlides(
  session: PresentationSession,
  allSlides: SlideMetadata[],
): SlideMetadata[] {
  return allSlides
    .filter((slide) => session.revealedSlideIds.includes(slide.id))
    .sort((a, b) => a.order - b.order);
}

/**
 * Navigates Solo mode through revealed slides only, excluding skipped slides (SPEC-005).
 */
export function navigateSoloMode(
  session: PresentationSession,
  allSlides: SlideMetadata[],
  currentSoloSlideId: string | null,
  direction: 'prev' | 'next',
): SlideMetadata | null {
  const soloSlides = getSoloNavigableSlides(session, allSlides);
  if (soloSlides.length === 0) {
    return null;
  }

  if (currentSoloSlideId === null) {
    return soloSlides[0] ?? null;
  }

  const currentIndex = soloSlides.findIndex((s) => s.id === currentSoloSlideId);
  if (currentIndex === -1) {
    return soloSlides[0] ?? null;
  }

  if (direction === 'prev') {
    const prevIndex = Math.max(0, currentIndex - 1);
    return soloSlides[prevIndex] ?? null;
  }

  const nextIndex = Math.min(soloSlides.length - 1, currentIndex + 1);
  return soloSlides[nextIndex] ?? null;
}

/**
 * Validates whether single-slide PNG download is permitted (SPEC-014, SPEC-024).
 */
export function canDownloadSlidePng(
  session: PresentationSession,
  slideId: string,
  assetManifest: AssetManifest,
): boolean {
  return (
    session.revealedSlideIds.includes(slideId) &&
    assetManifest.revision === session.presentationRevision &&
    Boolean(assetManifest.slidePngs[slideId])
  );
}

/**
 * Validates whether full PDF deck download is permitted (SPEC-016, SPEC-022, SPEC-024).
 */
export function canDownloadFullPdf(
  session: PresentationSession,
  assetManifest: AssetManifest,
): boolean {
  return (
    session.pdfDownloadUnlocked === true &&
    assetManifest.revision === session.presentationRevision &&
    Boolean(assetManifest.deckPdf)
  );
}

function stripHtml(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/**
 * Strips HTML tags and validates question content and optional participant name (SPEC-006, SPEC-018).
 */
export function sanitizeAndValidateQuestion(
  rawContent: string,
  rawParticipantName?: string,
): SanitizedQuestionResult {
  const content = stripHtml(rawContent);
  if (content.length === 0) {
    throw new Error('Question content cannot be empty');
  }
  if (content.length > 500) {
    throw new Error('Question content exceeds maximum length of 500 characters');
  }

  let participantName: string | undefined;
  if (rawParticipantName !== undefined) {
    const strippedName = stripHtml(rawParticipantName);
    if (strippedName.length > 0) {
      participantName = strippedName.slice(0, 50);
    }
  }

  return {
    content,
    participantName,
  };
}

/**
 * Enforces one upvote per participant per question and allows retracting (SPEC-007).
 */
export function toggleQuestionUpvote(
  question: AudienceQuestion,
  participantId: string,
): AudienceQuestion {
  if (!participantId || participantId.trim() === '') {
    throw new Error('Participant ID is required to vote');
  }

  const upvoters = question.upvotedByParticipantIds ? [...question.upvotedByParticipantIds] : [];
  const index = upvoters.indexOf(participantId);

  if (index >= 0) {
    upvoters.splice(index, 1);
    return {
      ...question,
      upvotes: Math.max(0, question.upvotes - 1),
      upvotedByParticipantIds: upvoters,
    };
  }

  upvoters.push(participantId);
  return {
    ...question,
    upvotes: question.upvotes + 1,
    upvotedByParticipantIds: upvoters,
  };
}

/**
 * Sorts audience questions by votes (tie-breaker createdAt) or by time (SPEC-007, SPEC-008).
 */
export function sortQuestions(
  questions: AudienceQuestion[],
  sortBy: 'votes' | 'time',
): AudienceQuestion[] {
  return [...questions].sort((a, b) => {
    if (sortBy === 'votes') {
      if (b.upvotes !== a.upvotes) {
        return b.upvotes - a.upvotes;
      }
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * Validates and records a poll vote with idempotency and option count invariants (SPEC-010, SPEC-018).
 */
export function recordPollVote(
  poll: PollDefinition,
  existingVotesByParticipant: Record<string, string[]>,
  participantId: string,
  selectedOptionIds: string[],
): PollVoteRecord {
  if (poll.status !== 'open') {
    throw new Error(`Poll is ${poll.status}, voting is only allowed when open`);
  }
  if (!participantId || participantId.trim() === '') {
    throw new Error('Participant ID is required');
  }
  if (existingVotesByParticipant[participantId]) {
    throw new Error('Participant has already voted in this poll');
  }
  if (!selectedOptionIds || selectedOptionIds.length === 0) {
    throw new Error('Must select at least one option');
  }

  const validOptionIds = new Set(poll.options.map((opt) => opt.id));
  for (const optionId of selectedOptionIds) {
    if (!validOptionIds.has(optionId)) {
      throw new Error(`Invalid option ID '${optionId}' for poll`);
    }
  }

  if ((poll.type === 'single' || poll.type === 'binary') && selectedOptionIds.length !== 1) {
    throw new Error(`Poll type '${poll.type}' requires exactly one selection`);
  }

  return {
    participantId,
    optionIds: [...selectedOptionIds],
    votedAt: new Date().toISOString(),
  };
}

/**
 * Evaluates adaptive navigation rules against poll results (SPEC-011).
 * Never navigates automatically without presenter confirmation.
 */
export function evaluateAdaptiveNavigationRules(
  rules: NavigationRule[],
  pollResults: PollResultsSummary,
): NavigationSuggestion[] {
  const suggestions: NavigationSuggestion[] = [];

  for (const rule of rules) {
    if (rule.pollId !== pollResults.pollId) {
      continue;
    }

    const voteCount = pollResults.countsByOptionId[rule.optionId] ?? 0;
    const meetsVoteThreshold = voteCount >= rule.minVoteThreshold;

    let meetsPercentageThreshold = true;
    if (rule.minPercentageThreshold !== undefined) {
      const percentage =
        pollResults.totalResponses > 0 ? (voteCount / pollResults.totalResponses) * 100 : 0;
      meetsPercentageThreshold = percentage >= rule.minPercentageThreshold;
    }

    if (meetsVoteThreshold && meetsPercentageThreshold) {
      const pctDisplay =
        pollResults.totalResponses > 0
          ? Math.round((voteCount / pollResults.totalResponses) * 100)
          : 0;
      suggestions.push({
        ruleId: rule.id,
        sourceSlideId: rule.sourceSlideId,
        pollId: rule.pollId,
        optionId: rule.optionId,
        targetSlideId: rule.targetSlideId,
        targetHorizontalIndex: rule.targetHorizontalIndex,
        targetVerticalIndex: rule.targetVerticalIndex,
        reason: `Threshold met: ${voteCount} votes (${pctDisplay}%) for option ${rule.optionId}`,
      });
    }
  }

  return suggestions;
}

/**
 * Normalizes a word cloud submission by lowercasing, stripping punctuation, and trimming (SPEC-021).
 */
export function normalizeWordCloudTerm(rawText: string): string {
  const trimmed = rawText.trim().toLowerCase();
  return trimmed
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aggregates word cloud submissions, filtering empty tokens and sorting by frequency desc (SPEC-021).
 */
export function aggregateWordCloudSubmissions(
  prompt: WordCloudPrompt,
  rawSubmissions: string[],
): WordCloudAggregate {
  const frequencyMap = new Map<string, number>();
  let totalSubmissions = 0;

  for (const raw of rawSubmissions) {
    const normalized = normalizeWordCloudTerm(raw);
    if (normalized.length > 0) {
      frequencyMap.set(normalized, (frequencyMap.get(normalized) ?? 0) + 1);
      totalSubmissions += 1;
    }
  }

  const terms = Array.from(frequencyMap.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.term.localeCompare(b.term);
    });

  return {
    promptId: prompt.id,
    slideId: prompt.slideId,
    status: prompt.status,
    totalSubmissions,
    terms,
  };
}

/**
 * Sliding-window rate limiter per participant (SPEC-006, SPEC-009, SPEC-018, SPEC-021).
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(options: RateLimiterOptions) {
    if (options.windowMs <= 0 || options.maxRequests <= 0) {
      throw new Error('RateLimiter options windowMs and maxRequests must be positive numbers');
    }
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  private purge(participantId: string, now: number): number[] {
    const timestamps = this.buckets.get(participantId);
    if (!timestamps) {
      return [];
    }
    const cutoff = now - this.windowMs;
    const active = timestamps.filter((t) => t > cutoff);
    if (active.length === 0) {
      this.buckets.delete(participantId);
      return [];
    }
    this.buckets.set(participantId, active);
    return active;
  }

  check(participantId: string, now: number = Date.now()): boolean {
    const active = this.purge(participantId, now);
    return active.length < this.maxRequests;
  }

  consume(participantId: string, now: number = Date.now()): boolean {
    const active = this.purge(participantId, now);
    if (active.length >= this.maxRequests) {
      return false;
    }
    active.push(now);
    this.buckets.set(participantId, active);
    return true;
  }

  getRemaining(participantId: string, now: number = Date.now()): number {
    const active = this.purge(participantId, now);
    return Math.max(0, this.maxRequests - active.length);
  }

  reset(participantId?: string): void {
    if (participantId) {
      this.buckets.delete(participantId);
    } else {
      this.buckets.clear();
    }
  }
}
