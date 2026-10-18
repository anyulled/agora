export type PresentationStatus = 'draft' | 'published';
export type SessionStatus = 'scheduled' | 'live' | 'completed';
export type QuestionStatus = 'pending' | 'answered' | 'dismissed';
export type AudienceMode = 'follow' | 'solo';
export type Reaction = '👍' | '🤔' | '❤️' | '😴';
export type PollType = 'single' | 'multiple' | 'binary';
export type PollStatus = 'draft' | 'open' | 'closed';
export type WordCloudStatus = 'draft' | 'open' | 'closed';
export type ActorRole = 'admin' | 'presenter' | 'attendee';

export const ALLOWED_REACTIONS: readonly Reaction[] = ['👍', '🤔', '❤️', '😴'] as const;

export interface PresentationBranding {
  colors: Record<string, string>;
  logoAssetId?: string;
}

export interface Presentation {
  id: string;
  title: string;
  description?: string;
  eventName?: string;
  revision: string;
  status: PresentationStatus;
  endingSlideId: string;
  branding: PresentationBranding;
  slides?: SlideMetadata[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SlideMetadata {
  id: string;
  presentationId: string;
  title: string;
  horizontalIndex: number;
  verticalIndex: number;
  order: number;
  isQaSlide?: boolean;
}

export interface AssetManifestEntry {
  assetId: string;
  presentationId: string;
  revision: string;
  kind: 'slide-png' | 'deck-pdf' | 'logo';
  slideId?: string;
  r2Key: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

export interface AssetManifest {
  presentationId: string;
  revision: string;
  slidePngs: Record<string, AssetManifestEntry>;
  deckPdf?: AssetManifestEntry;
  logo?: AssetManifestEntry;
}

export interface PresentationSession {
  id: string;
  presentationId: string;
  presentationRevision: string;
  status: SessionStatus;
  currentSlideId: string | null;
  revealedSlideIds: string[];
  pdfDownloadUnlocked: boolean;
  audienceUrl?: string;
  qrCodeDataUrl?: string;
  connectedParticipants?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface ParticipantIdentity {
  id: string;
  sessionId: string;
  token: string;
  displayName?: string;
  joinedAt: string;
}

export interface AudienceQuestion {
  id: string;
  sessionId: string;
  slideId: string;
  participantId: string;
  participantName?: string;
  content: string;
  status: QuestionStatus;
  upvotes: number;
  upvotedByParticipantIds?: string[];
  createdAt: string;
}

export interface PollOption {
  id: string;
  label: string;
}

export interface PollDefinition {
  id: string;
  sessionId: string;
  slideId: string;
  question: string;
  type: PollType;
  options: PollOption[];
  status: PollStatus;
  resultsRevealed: boolean;
}

export interface PollResultsSummary {
  pollId: string;
  slideId: string;
  status: PollStatus;
  resultsRevealed: boolean;
  totalResponses: number;
  countsByOptionId: Record<string, number>;
}

export interface NavigationRule {
  id: string;
  presentationId: string;
  sourceSlideId: string;
  pollId: string;
  optionId: string;
  minVoteThreshold: number;
  minPercentageThreshold?: number;
  targetSlideId: string;
  targetHorizontalIndex: number;
  targetVerticalIndex: number;
}

export interface NavigationSuggestion {
  ruleId: string;
  sourceSlideId: string;
  pollId: string;
  optionId: string;
  targetSlideId: string;
  targetHorizontalIndex: number;
  targetVerticalIndex: number;
  reason: string;
}

export interface WordCloudPrompt {
  id: string;
  sessionId: string;
  slideId: string;
  prompt: string;
  status: WordCloudStatus;
}

export interface WordCloudTerm {
  term: string;
  count: number;
}

export interface WordCloudAggregate {
  promptId: string;
  slideId: string;
  status: WordCloudStatus;
  totalSubmissions: number;
  terms: WordCloudTerm[];
}

export type ReactionCounts = Record<Reaction, number>;

export type RealtimeEventType =
  | 'session.joined'
  | 'session.state'
  | 'slide.changed'
  | 'question.submitted'
  | 'question.updated'
  | 'question.upvoted'
  | 'reaction.added'
  | 'reaction.summary'
  | 'poll.opened'
  | 'poll.closed'
  | 'poll.voted'
  | 'poll.results'
  | 'wordcloud.submitted'
  | 'wordcloud.updated'
  | 'navigation.suggested'
  | 'presentation.download.unlocked';

export interface RealtimeEvent<T = unknown> {
  id: string;
  type: RealtimeEventType;
  sessionId: string;
  timestamp: string;
  payload: T;
}

export interface AudienceSafeSessionView {
  session: PresentationSession;
  slides: SlideMetadata[];
  availablePngSlideIds: string[];
  pdfAvailable: boolean;
  questions: AudienceQuestion[];
  activePolls: PollResultsSummary[];
  activeWordClouds: WordCloudAggregate[];
  reactionSummary: Record<string, ReactionCounts>;
}
