import {
  ALLOWED_REACTIONS,
  type AssetManifestEntry,
  type AudienceQuestion,
  type AudienceSafeSessionView,
  type NavigationRule,
  type NavigationSuggestion,
  type ParticipantIdentity,
  type PollDefinition,
  type PollOption,
  type PollResultsSummary,
  type Presentation,
  type PresentationBranding,
  type PresentationRevisionStatus,
  type PresentationSession,
  type Reaction,
  type ReactionCounts,
  type ReactionSummaryPayload,
  type RealtimeEvent,
  type RealtimeEventType,
  type SlideMetadata,
  type WordCloudAggregate,
  type WordCloudPrompt,
} from '@agora/contracts';
import {
  bumpRevision,
  computePresentationRevisionHash,
  createAudienceQuestion,
  isSlideRevealed,
  sortQuestions,
  startScheduledSession,
  updateQuestionStatus,
} from '@agora/domain';
import type {
  LocalD1Database,
  LocalDurableObjectNamespace,
  LocalDurableObjectState,
  LocalR2Bucket,
} from './cloudflare-emulator';
import { AGORA_OPENAPI_SPEC, renderOpenApiDocsHtml } from './openapi';

export * from './cloudflare-emulator';
export * from './openapi';

export interface WorkerEnv {
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
  DB?: LocalD1Database | Record<string, unknown>;
  ASSETS_BUCKET?: LocalR2Bucket | Record<string, unknown>;
  SESSION_COORDINATOR?: LocalDurableObjectNamespace | Record<string, unknown>;
}

function generateSecureId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
  return `${prefix}-${Date.now()}-${rand}`;
}

export interface AgoraWorkerAppOptions {
  adminToken?: string;
  allowedOrigins?: string[];
  maxQuestionsPerWindow?: number;
  maxReactionsPerWindow?: number;
  rateWindowMs?: number;
}

export function sanitizeText(input: string): string {
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .trim();
}

export function normalizeWordCloudTerm(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .slice(0, 50);
}

export class InMemoryAgoraStore {
  public presentations = new Map<string, Presentation>();
  public slides = new Map<string, SlideMetadata[]>();
  public navigationRules = new Map<string, NavigationRule[]>();
  public assets = new Map<string, AssetManifestEntry[]>();
  public assetBlobs = new Map<string, { bytes: Uint8Array; contentType: string }>();

  public sessions = new Map<string, PresentationSession>();
  public participants = new Map<string, ParticipantIdentity>();
  public participantTokens = new Map<string, string>(); // token -> participantId
  public presenterTokens = new Map<string, string>(); // sessionId -> presenterToken

  public questions = new Map<string, AudienceQuestion[]>(); // sessionId -> questions
  public questionUpvotes = new Map<string, Set<string>>(); // questionId -> Set<participantId>
  public reactions = new Map<string, Map<string, ReactionCounts>>(); // sessionId -> slideId -> counts
  public polls = new Map<string, PollDefinition[]>(); // sessionId -> polls
  public pollVotes = new Map<string, Map<string, string>>(); // pollId -> participantId -> optionId
  public wordClouds = new Map<string, WordCloudPrompt[]>(); // sessionId -> prompts
  public wordCloudSubmissions = new Map<string, { participantId: string; term: string }[]>(); // promptId -> submissions
  public processedEvents = new Map<string, Set<string>>(); // sessionId -> Set<eventId>
}

class RateLimiter {
  private records = new Map<string, number[]>();

  public check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const timestamps = (this.records.get(key) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      this.records.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.records.set(key, timestamps);
    return true;
  }
}

export class SessionCoordinatorDO {
  private sockets = new Set<WebSocket>();
  private socketTokens = new Map<WebSocket, string | null>();
  private store: InMemoryAgoraStore;
  private sessionId: string;
  private allowedOrigins: string[];
  private reactionBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReactionSlides = new Set<string>();
  private reactionBatchIntervalMs = 500;
  private reactionRateLimiter = new RateLimiter();

  constructor(sessionId: string, store: InMemoryAgoraStore, allowedOrigins: string[] = ['*']) {
    this.sessionId = sessionId;
    this.store = store;
    this.allowedOrigins = allowedOrigins;
  }

  public validateOrigin(origin: string | null): boolean {
    if (this.allowedOrigins.includes('*')) return true;
    if (!origin) return false;
    return this.allowedOrigins.includes(origin);
  }

  public handleConnection(
    ws: WebSocket,
    origin: string | null,
    authToken: string | null = null,
  ): boolean {
    if (!this.validateOrigin(origin)) {
      ws.close(1008, 'Origin not allowed');
      return false;
    }

    this.sockets.add(ws);
    this.socketTokens.set(ws, authToken);

    ws.addEventListener?.('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this.handleMessage(ws, event.data);
      }
    });

    // SPEC-002: Restore authoritative session state snapshot upon WebSocket connection/reconnection
    const session = this.store.sessions.get(this.sessionId);
    if (session) {
      const snapshotEvent: RealtimeEvent<PresentationSession> = {
        id: generateSecureId('evt-restore'),
        type: 'session.state',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload: session,
      };
      try {
        if (ws.readyState === undefined || ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(snapshotEvent));
        }
      } catch {
        // Ignore send errors on mock sockets
      }
    }

    return true;
  }

  public handleMessage(ws: WebSocket, rawMessage: string, overrideToken?: string | null): boolean {
    let parsed: {
      id?: string;
      type?: string;
      token?: string;
      payload?: Record<string, unknown>;
    } | null = null;

    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    if (!parsed || typeof parsed !== 'object') return false;

    if (parsed.type === 'slide.changed') {
      const expectedToken = this.store.presenterTokens.get(this.sessionId);
      const candidateToken =
        overrideToken ??
        (typeof parsed.token === 'string' ? parsed.token : null) ??
        this.socketTokens.get(ws) ??
        null;

      if (!expectedToken || !candidateToken || candidateToken !== expectedToken) {
        const errorEvent: RealtimeEvent<{ code: string; message: string }> = {
          id: generateSecureId('evt-err'),
          type: 'error',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            code: 'UNAUTHORIZED_NAVIGATION',
            message: 'Unauthorized: Presenter authentication required',
          },
        };
        try {
          if (ws.readyState === undefined || ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(errorEvent));
          }
        } catch {
          // Ignore send error
        }
        return false;
      }

      const session = this.store.sessions.get(this.sessionId);
      if (!session || session.status !== 'live') {
        return false;
      }

      const payload = parsed.payload ?? {};
      const slideId = typeof payload.slideId === 'string' ? payload.slideId.trim() : '';
      if (!slideId) return false;

      const horizontalIndex =
        typeof payload.horizontalIndex === 'number' ? payload.horizontalIndex : 0;
      const verticalIndex = typeof payload.verticalIndex === 'number' ? payload.verticalIndex : 0;
      const timestamp =
        typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString();

      session.currentSlideId = slideId;
      // SPEC-003: Backward slide navigation maintains previously revealed slide status
      if (!session.revealedSlideIds.includes(slideId)) {
        session.revealedSlideIds.push(slideId);
      }

      const presentation = this.store.presentations.get(session.presentationId);
      if (presentation?.endingSlideId === slideId && !session.pdfDownloadUnlocked) {
        session.pdfDownloadUnlocked = true;
      }

      const eventId =
        typeof parsed.id === 'string' && parsed.id ? parsed.id : generateSecureId('evt');

      this.broadcast({
        id: eventId,
        type: 'slide.changed',
        sessionId: this.sessionId,
        timestamp,
        payload: {
          slideId,
          horizontalIndex,
          verticalIndex,
          timestamp,
          revealedSlideIds: session.revealedSlideIds,
        },
      });
      return true;
    }

    if (parsed.type === 'reaction.added') {
      const candidateToken =
        overrideToken ??
        (typeof parsed.token === 'string' ? parsed.token : null) ??
        this.socketTokens.get(ws) ??
        null;

      const session = this.store.sessions.get(this.sessionId);
      if (!session || session.status !== 'live') {
        return false;
      }

      const participantKey = candidateToken ?? 'anonymous';
      if (!this.reactionRateLimiter.check(`react:${participantKey}`, 10, 1000)) {
        const errorEvent: RealtimeEvent<{ code: string; message: string }> = {
          id: generateSecureId('evt-err'),
          type: 'error',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Reaction rate limit exceeded. Please slow down.',
          },
        };
        try {
          if (ws.readyState === undefined || ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(errorEvent));
          }
        } catch {
          // Ignore
        }
        return false;
      }

      const payload = parsed.payload ?? {};
      const slideId = typeof payload.slideId === 'string' ? payload.slideId.trim() : '';
      const reaction = payload.reaction as Reaction;

      if (!slideId || !reaction || !ALLOWED_REACTIONS.includes(reaction)) {
        return false;
      }

      if (!session.revealedSlideIds.includes(slideId)) {
        const errorEvent: RealtimeEvent<{ code: string; message: string }> = {
          id: generateSecureId('evt-err'),
          type: 'error',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
          payload: {
            code: 'SLIDE_NOT_REVEALED',
            message: 'Cannot react to unrevealed slide',
          },
        };
        try {
          if (ws.readyState === undefined || ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(errorEvent));
          }
        } catch {
          // Ignore
        }
        return false;
      }

      this.recordReaction(slideId, reaction);
      return true;
    }

    return false;
  }

  public recordReaction(slideId: string, reaction: Reaction): ReactionCounts {
    let sessionReactions = this.store.reactions.get(this.sessionId);
    if (!sessionReactions) {
      sessionReactions = new Map();
      this.store.reactions.set(this.sessionId, sessionReactions);
    }

    const currentCounts: ReactionCounts = sessionReactions.get(slideId) || {
      '👍': 0,
      '🤔': 0,
      '❤️': 0,
      '😴': 0,
    };

    currentCounts[reaction] = (currentCounts[reaction] ?? 0) + 1;
    sessionReactions.set(slideId, currentCounts);

    this.pendingReactionSlides.add(slideId);

    if (!this.reactionBatchTimer) {
      this.reactionBatchTimer = setTimeout(() => {
        this.flushReactionSummaries();
      }, this.reactionBatchIntervalMs);
    }

    return currentCounts;
  }

  public flushReactionSummaries(): void {
    if (this.reactionBatchTimer) {
      clearTimeout(this.reactionBatchTimer);
      this.reactionBatchTimer = null;
    }

    if (this.pendingReactionSlides.size === 0) return;

    const sessionReactions = this.store.reactions.get(this.sessionId);
    for (const slideId of this.pendingReactionSlides) {
      const counts = sessionReactions?.get(slideId) || {
        '👍': 0,
        '🤔': 0,
        '❤️': 0,
        '😴': 0,
      };
      this.broadcastSlideReactionSummary(slideId, counts);
    }

    this.pendingReactionSlides.clear();
  }

  public broadcastSlideReactionSummary(slideId: string, counts: ReactionCounts): void {
    const event: RealtimeEvent<ReactionSummaryPayload> = {
      id: generateSecureId('evt-react-sum'),
      type: 'reaction.summary',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        slideId,
        counts: { ...counts },
        timestamp: new Date().toISOString(),
      },
    };
    this.broadcast(event);
  }

  public destroy(): void {
    if (this.reactionBatchTimer) {
      clearTimeout(this.reactionBatchTimer);
      this.reactionBatchTimer = null;
    }
    this.sockets.clear();
    this.socketTokens.clear();
  }

  public removeConnection(ws: WebSocket): void {
    this.sockets.delete(ws);
    this.socketTokens.delete(ws);
  }

  public isEventProcessed(eventId: string): boolean {
    const set = this.store.processedEvents.get(this.sessionId);
    return set ? set.has(eventId) : false;
  }

  public markEventProcessed(eventId: string): void {
    let set = this.store.processedEvents.get(this.sessionId);
    if (!set) {
      set = new Set();
      this.store.processedEvents.set(this.sessionId, set);
    }
    set.add(eventId);
  }

  public broadcast<T>(event: RealtimeEvent<T>): void {
    this.markEventProcessed(event.id);
    const serialized = JSON.stringify(event);
    for (const socket of this.sockets) {
      try {
        if (socket.readyState === undefined || socket.readyState === WebSocket.OPEN) {
          socket.send(serialized);
        }
      } catch {
        this.sockets.delete(socket);
        this.socketTokens.delete(socket);
      }
    }
  }

  public getActiveConnectionCount(): number {
    return this.sockets.size;
  }
}

export const SessionDurableObject = SessionCoordinatorDO;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function createAgoraWorkerApp(options?: AgoraWorkerAppOptions) {
  const adminSecret = options?.adminToken ?? 'agora-admin-secret-token';
  const allowedOrigins = options?.allowedOrigins ?? ['*'];
  const maxQuestions = options?.maxQuestionsPerWindow ?? 5;
  const maxReactions = options?.maxReactionsPerWindow ?? 10;
  const rateWindowMs = options?.rateWindowMs ?? 10000;

  const store = new InMemoryAgoraStore();
  const rateLimiter = new RateLimiter();
  const coordinators = new Map<string, SessionCoordinatorDO>();

  function getCoordinator(sessionId: string): SessionCoordinatorDO {
    let coord = coordinators.get(sessionId);
    if (!coord) {
      coord = new SessionCoordinatorDO(sessionId, store, allowedOrigins);
      coordinators.set(sessionId, coord);
    }
    return coord;
  }

  function authorizeAdmin(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');
    const customHeader = request.headers.get('x-admin-token');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : customHeader?.trim();

    return token === adminSecret;
  }

  function authorizePresenter(request: Request, sessionId: string): boolean {
    if (authorizeAdmin(request)) return true;

    const authHeader = request.headers.get('Authorization');
    const customHeader = request.headers.get('x-presenter-token');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : customHeader?.trim();

    const expectedToken = store.presenterTokens.get(sessionId);
    return Boolean(token && expectedToken && token === expectedToken);
  }

  function getParticipantFromToken(
    request: Request,
    sessionId: string,
  ): ParticipantIdentity | null {
    const authHeader = request.headers.get('Authorization');
    const customHeader = request.headers.get('x-participant-token');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : customHeader?.trim();

    if (!token) return null;
    const participantId = store.participantTokens.get(token);
    if (!participantId) return null;

    const participant = store.participants.get(participantId);
    if (!participant || participant.sessionId !== sessionId) return null;

    return participant;
  }

  function broadcastRealtimeEvent<T>(
    sessionId: string,
    type: RealtimeEventType,
    payload: T,
    id?: string,
  ): RealtimeEvent<T> {
    const event: RealtimeEvent<T> = {
      id: id || generateSecureId('evt'),
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
    getCoordinator(sessionId).broadcast(event);
    return event;
  }

  function buildPollResultsSummary(poll: PollDefinition): PollResultsSummary {
    const votes = store.pollVotes.get(poll.id) || new Map<string, string>();
    const counts: Record<string, number> = {};
    for (const opt of poll.options) {
      counts[opt.id] = 0;
    }
    for (const optId of votes.values()) {
      counts[optId] = (counts[optId] || 0) + 1;
    }
    return {
      pollId: poll.id,
      slideId: poll.slideId,
      status: poll.status,
      resultsRevealed: poll.resultsRevealed,
      totalResponses: votes.size,
      countsByOptionId: counts,
    };
  }

  function buildWordCloudAggregate(wc: WordCloudPrompt): WordCloudAggregate {
    const subs = store.wordCloudSubmissions.get(wc.id) || [];
    const termCounts: Record<string, number> = {};
    for (const sub of subs) {
      termCounts[sub.term] = (termCounts[sub.term] || 0) + 1;
    }
    const terms = Object.entries(termCounts)
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count);

    return {
      promptId: wc.id,
      slideId: wc.slideId,
      status: wc.status,
      totalSubmissions: subs.length,
      terms,
    };
  }

  function asD1(env?: WorkerEnv): LocalD1Database | null {
    const db = env?.DB as LocalD1Database | undefined;
    return db && typeof db.prepare === 'function' ? db : null;
  }

  function asR2(env?: WorkerEnv): LocalR2Bucket | null {
    const r2 = env?.ASSETS_BUCKET as LocalR2Bucket | undefined;
    return r2 && typeof r2.put === 'function' ? r2 : null;
  }

  function asDO(env: WorkerEnv | undefined, sessionId: string): LocalDurableObjectState | null {
    const ns = env?.SESSION_COORDINATOR as LocalDurableObjectNamespace | undefined;
    if (!ns || typeof ns.getState !== 'function' || typeof ns.idFromName !== 'function') {
      return null;
    }
    return ns.getState(ns.idFromName(sessionId));
  }

  async function persistSessionToDO(
    env: WorkerEnv | undefined,
    session: PresentationSession,
    presenterToken?: string,
  ): Promise<void> {
    const doState = asDO(env, session.id);
    if (!doState) return;

    doState.storage.sql.exec(
      `INSERT OR REPLACE INTO session_state
       (session_id, presentation_id, presentation_revision, status, current_slide_id, revealed_slide_ids_json, pdf_download_unlocked, audience_url, qr_code_data_url, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.presentationId,
      session.presentationRevision,
      session.status,
      session.currentSlideId ?? null,
      JSON.stringify(session.revealedSlideIds),
      session.pdfDownloadUnlocked ? 1 : 0,
      session.audienceUrl ?? null,
      session.qrCodeDataUrl ?? null,
      session.startedAt ?? new Date().toISOString(),
      session.completedAt ?? null,
    );

    if (presenterToken) {
      await doState.storage.put('presenterToken', presenterToken);
    }
  }

  function persistParticipantToDO(
    env: WorkerEnv | undefined,
    participant: ParticipantIdentity,
  ): void {
    const doState = asDO(env, participant.sessionId);
    if (!doState) return;

    doState.storage.sql.exec(
      `INSERT OR REPLACE INTO participants (id, session_id, token, display_name, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
      participant.id,
      participant.sessionId,
      participant.token,
      participant.displayName ?? null,
      participant.joinedAt,
    );
  }

  function persistQuestionToDO(env: WorkerEnv | undefined, question: AudienceQuestion): void {
    const doState = asDO(env, question.sessionId);
    if (!doState) return;

    doState.storage.sql.exec(
      `INSERT OR REPLACE INTO questions
       (id, session_id, slide_id, participant_id, participant_name, content, status, upvotes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      question.id,
      question.sessionId,
      question.slideId,
      question.participantId,
      question.participantName ?? null,
      question.content,
      question.status,
      question.upvotes ?? 0,
      question.createdAt,
    );
  }

  function updateQuestionStatusInDO(
    env: WorkerEnv | undefined,
    sessionId: string,
    questionId: string,
    status: 'pending' | 'answered' | 'dismissed',
  ): void {
    const doState = asDO(env, sessionId);
    if (!doState) return;

    doState.storage.sql.exec(
      'UPDATE questions SET status = ? WHERE id = ? AND session_id = ?',
      status,
      questionId,
      sessionId,
    );
  }

  async function hydrateSessionFromDO(
    env: WorkerEnv | undefined,
    sessionId: string,
  ): Promise<PresentationSession | null> {
    const inMem = store.sessions.get(sessionId);
    if (inMem) return inMem;

    const doState = asDO(env, sessionId);
    if (!doState) return null;

    const rows = doState.storage.sql
      .exec<Record<string, unknown>>('SELECT * FROM session_state WHERE session_id = ?', sessionId)
      .toArray();
    const row = rows[0];
    if (!row) return null;

    const pRows = doState.storage.sql
      .exec<Record<string, unknown>>('SELECT * FROM participants WHERE session_id = ?', sessionId)
      .toArray();

    for (const p of pRows) {
      const part: ParticipantIdentity = {
        id: String(p.id),
        sessionId: String(p.session_id),
        token: String(p.token),
        displayName: p.display_name ? String(p.display_name) : undefined,
        joinedAt: String(p.joined_at),
      };
      store.participants.set(part.id, part);
      store.participantTokens.set(part.token, part.id);
    }

    const savedPresenterToken = await doState.storage.get<string>('presenterToken');
    if (savedPresenterToken) {
      store.presenterTokens.set(sessionId, savedPresenterToken);
    }

    // Hydrate questions from Durable Object embedded SQLite (SPEC-006)
    const qRows = doState.storage.sql
      .exec<Record<string, unknown>>(
        'SELECT * FROM questions WHERE session_id = ? ORDER BY created_at ASC',
        sessionId,
      )
      .toArray();

    const loadedQuestions: AudienceQuestion[] = qRows.map((q) => ({
      id: String(q.id),
      sessionId: String(q.session_id),
      slideId: String(q.slide_id),
      participantId: String(q.participant_id),
      participantName: q.participant_name ? String(q.participant_name) : undefined,
      content: String(q.content),
      status: (q.status as 'pending' | 'answered' | 'dismissed') || 'pending',
      upvotes: Number(q.upvotes || 0),
      upvotedByParticipantIds: [],
      createdAt: String(q.created_at),
    }));
    store.questions.set(sessionId, loadedQuestions);

    // Hydrate question upvotes
    const upRows = doState.storage.sql
      .exec<Record<string, unknown>>(
        'SELECT question_id, participant_id FROM question_upvotes WHERE session_id = ?',
        sessionId,
      )
      .toArray();

    for (const up of upRows) {
      const qId = String(up.question_id);
      const pId = String(up.participant_id);
      let set = store.questionUpvotes.get(qId);
      if (!set) {
        set = new Set();
        store.questionUpvotes.set(qId, set);
      }
      set.add(pId);

      const targetQ = loadedQuestions.find((item) => item.id === qId);
      if (targetQ) {
        if (!targetQ.upvotedByParticipantIds) {
          targetQ.upvotedByParticipantIds = [];
        }
        if (!targetQ.upvotedByParticipantIds.includes(pId)) {
          targetQ.upvotedByParticipantIds.push(pId);
        }
      }
    }

    const status = (row.status as PresentationSession['status']) || 'live';
    const session: PresentationSession = {
      id: String(row.session_id),
      presentationId: String(row.presentation_id),
      presentationRevision: String(row.presentation_revision),
      status,
      currentSlideId: row.current_slide_id ? String(row.current_slide_id) : null,
      revealedSlideIds: JSON.parse(String(row.revealed_slide_ids_json || '[]')) as string[],
      pdfDownloadUnlocked: Boolean(row.pdf_download_unlocked),
      audienceUrl: row.audience_url ? String(row.audience_url) : undefined,
      qrCodeDataUrl: row.qr_code_data_url ? String(row.qr_code_data_url) : undefined,
      connectedParticipants: pRows.length,
      startedAt: status === 'scheduled' ? undefined : String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
    };

    store.sessions.set(sessionId, session);
    await hydratePresentationFromD1(env, session.presentationId);
    return session;
  }

  function validatePresentationPayload(
    body: Partial<Presentation>,
    isCreate: boolean,
  ): string | null {
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || sanitizeText(body.title).length === 0) {
        return 'Invalid presentation payload: title must be a non-empty string';
      }
    } else if (isCreate && Object.keys(body).length === 0) {
      // Allow default fallback only when caller omits title on minimal create, unless explicitly invalid
    }
    if (body.status !== undefined && body.status !== 'draft' && body.status !== 'published') {
      return "Invalid presentation payload: status must be 'draft' or 'published'";
    }
    if (body.slides !== undefined) {
      if (!Array.isArray(body.slides)) {
        return 'Invalid presentation payload: slides must be an array';
      }
      for (const s of body.slides) {
        if (
          !s ||
          typeof s.id !== 'string' ||
          !s.id.trim() ||
          typeof s.title !== 'string' ||
          typeof s.horizontalIndex !== 'number' ||
          typeof s.verticalIndex !== 'number' ||
          typeof s.order !== 'number'
        ) {
          return 'Invalid slide metadata in slides array';
        }
      }
    }
    return null;
  }

  function computeRevisionStatus(
    presentation: Presentation,
    allAssets: AssetManifestEntry[],
  ): PresentationRevisionStatus {
    const currentAssets = allAssets.filter((a) => a.revision === presentation.revision);
    const staleAssets = allAssets.filter((a) => a.revision !== presentation.revision);
    const hash =
      presentation.revisionHash ||
      computePresentationRevisionHash({
        title: presentation.title,
        description: presentation.description,
        eventName: presentation.eventName,
        endingSlideId: presentation.endingSlideId,
        branding: presentation.branding,
        slides: presentation.slides || [],
      });

    return {
      presentationId: presentation.id,
      revision: presentation.revision,
      revisionHash: hash,
      assetCount: currentAssets.length,
      staleAssetCount: staleAssets.length,
      isCurrent: staleAssets.length === 0,
    };
  }

  async function persistPresentationToD1(
    env: WorkerEnv | undefined,
    presentation: Presentation,
    slides: SlideMetadata[],
  ): Promise<void> {
    const db = asD1(env);
    if (!db) return;

    await db
      .prepare(
        `INSERT OR REPLACE INTO presentations
         (id, title, description, event_name, revision, revision_hash, status, ending_slide_id, branding_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        presentation.id,
        presentation.title,
        presentation.description ?? null,
        presentation.eventName ?? null,
        presentation.revision,
        presentation.revisionHash ?? '',
        presentation.status,
        presentation.endingSlideId,
        JSON.stringify(presentation.branding || { colors: {} }),
        presentation.createdAt || new Date().toISOString(),
        presentation.updatedAt || new Date().toISOString(),
      )
      .run();

    await db.prepare('DELETE FROM slides WHERE presentation_id = ?').bind(presentation.id).run();
    if (slides.length > 0) {
      await db.batch(
        slides.map((s) =>
          db
            .prepare(
              `INSERT INTO slides (id, presentation_id, title, horizontal_index, vertical_index, slide_order, is_qa_slide)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              s.id,
              presentation.id,
              s.title,
              s.horizontalIndex,
              s.verticalIndex,
              s.order,
              s.isQaSlide ? 1 : 0,
            ),
        ),
      );
    }
  }

  async function hydratePresentationFromD1(
    env: WorkerEnv | undefined,
    id: string,
  ): Promise<Presentation | null> {
    const inMem = store.presentations.get(id);
    if (inMem) return inMem;

    const db = asD1(env);
    if (!db) return null;

    const row = await db
      .prepare('SELECT * FROM presentations WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return null;

    const slideRows = await db
      .prepare('SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_order ASC')
      .bind(id)
      .all<Record<string, unknown>>();

    const slides: SlideMetadata[] = slideRows.results.map((r) => ({
      id: String(r.id),
      presentationId: String(r.presentation_id),
      title: String(r.title),
      horizontalIndex: Number(r.horizontal_index),
      verticalIndex: Number(r.vertical_index),
      order: Number(r.slide_order),
      isQaSlide: Boolean(r.is_qa_slide),
    }));

    const branding = JSON.parse(
      String(row.branding_json || '{"colors":{}}'),
    ) as PresentationBranding;
    const presentation: Presentation = {
      id: String(row.id),
      title: String(row.title),
      description: row.description ? String(row.description) : undefined,
      eventName: row.event_name ? String(row.event_name) : undefined,
      revision: String(row.revision),
      revisionHash: row.revision_hash ? String(row.revision_hash) : undefined,
      status: (row.status as Presentation['status']) || 'draft',
      endingSlideId: String(row.ending_slide_id),
      branding,
      slides,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };

    const assetRows = await db
      .prepare('SELECT * FROM asset_manifests WHERE presentation_id = ?')
      .bind(id)
      .all<Record<string, unknown>>();
    const assets: AssetManifestEntry[] = assetRows.results.map((a) => ({
      assetId: String(a.asset_id),
      presentationId: String(a.presentation_id),
      revision: String(a.revision),
      kind: a.kind as AssetManifestEntry['kind'],
      slideId: a.slide_id ? String(a.slide_id) : undefined,
      r2Key: String(a.r2_key),
      contentType: String(a.content_type),
      byteSize: Number(a.byte_size),
      createdAt: String(a.created_at),
    }));

    store.presentations.set(id, presentation);
    store.slides.set(id, slides);
    store.assets.set(id, assets);
    return presentation;
  }

  async function purgeStaleAssets(
    env: WorkerEnv | undefined,
    presentationId: string,
    newRevision: string,
  ): Promise<void> {
    const existingAssets = store.assets.get(presentationId) || [];
    const staleAssets = existingAssets.filter((a) => a.revision !== newRevision);
    const validAssets = existingAssets.filter((a) => a.revision === newRevision);
    store.assets.set(presentationId, validAssets);

    const r2 = asR2(env);
    for (const stale of staleAssets) {
      store.assetBlobs.delete(stale.r2Key);
      if (r2) {
        await r2.delete(stale.r2Key);
      }
    }

    const db = asD1(env);
    if (db) {
      await db
        .prepare('DELETE FROM asset_manifests WHERE presentation_id = ? AND revision != ?')
        .bind(presentationId, newRevision)
        .run();
    }
  }

  async function handleRequest(request: Request, env?: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, x-admin-token, x-presenter-token, x-participant-token, x-confirm-destroy',
        },
      });
    }

    // OpenAPI 3.1.0 Specification & Interactive Documentation
    if (method === 'GET' && path === '/api/v1/openapi.json') {
      return jsonResponse(AGORA_OPENAPI_SPEC);
    }
    if (method === 'GET' && path === '/api/v1/docs') {
      return new Response(renderOpenApiDocsHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 0. GET /api/v1/presentations (List all presentations)
    if (method === 'GET' && path === '/api/v1/presentations') {
      return jsonResponse(Array.from(store.presentations.values()));
    }

    // 1. POST /api/v1/presentations (Admin)
    if (method === 'POST' && path === '/api/v1/presentations') {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }

      const rawBody = await request.json().catch(() => null);
      if (rawBody === null || typeof rawBody !== 'object') {
        return errorResponse('Invalid JSON request body', 400);
      }
      const body = rawBody as Partial<Presentation>;
      const validationErr = validatePresentationPayload(body, true);
      if (validationErr) {
        return errorResponse(validationErr, 400);
      }

      const id = body.id || generateSecureId('pres');
      const slides: SlideMetadata[] = (body.slides || []).map((s) => ({
        ...s,
        presentationId: id,
        title: sanitizeText(s.title),
      }));
      const branding: PresentationBranding = {
        colors: { ...(body.branding?.colors ?? {}) },
        logoAssetId: body.branding?.logoAssetId,
      };
      const title = sanitizeText(body.title || 'Untitled Presentation');
      const description = body.description ? sanitizeText(body.description) : undefined;
      const eventName = body.eventName ? sanitizeText(body.eventName) : undefined;
      const endingSlideId = body.endingSlideId || 'slide-ending';
      const now = new Date().toISOString();

      const presentation: Presentation = {
        id,
        title,
        description,
        eventName,
        revision: 'rev-1',
        revisionHash: computePresentationRevisionHash({
          title,
          description,
          eventName,
          endingSlideId,
          branding,
          slides,
        }),
        status: body.status || 'draft',
        endingSlideId,
        branding,
        slides,
        createdAt: now,
        updatedAt: now,
      };

      store.presentations.set(id, presentation);
      store.slides.set(id, slides);
      store.assets.set(id, []);
      await persistPresentationToD1(env, presentation, slides);
      return jsonResponse(presentation, 201);
    }

    // 2. GET /api/v1/presentations/:id
    const presMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)$/);
    if (method === 'GET' && presMatch) {
      const id = presMatch[1]!;
      const presentation = await hydratePresentationFromD1(env, id);
      if (!presentation) {
        return errorResponse('Presentation not found', 404);
      }
      const slides = store.slides.get(id) || [];
      const assets = store.assets.get(id) || [];
      const revisionStatus = computeRevisionStatus({ ...presentation, slides }, assets);
      return jsonResponse({
        ...presentation,
        slides,
        revisionHash: revisionStatus.revisionHash,
        revisionStatus,
      });
    }

    // 3. PUT & PATCH /api/v1/presentations/:id (Admin)
    if ((method === 'PATCH' || method === 'PUT') && presMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const id = presMatch[1]!;
      const existing = await hydratePresentationFromD1(env, id);
      if (!existing) {
        return errorResponse('Presentation not found', 404);
      }

      const rawBody = await request.json().catch(() => null);
      if (rawBody === null || typeof rawBody !== 'object') {
        return errorResponse('Invalid JSON request body', 400);
      }
      const body = rawBody as Partial<Presentation>;
      const validationErr = validatePresentationPayload(body, false);
      if (validationErr) {
        return errorResponse(validationErr, 400);
      }

      const newRevision = bumpRevision(existing.revision);
      const updatedSlides = body.slides
        ? body.slides.map((s) => ({ ...s, presentationId: id, title: sanitizeText(s.title) }))
        : store.slides.get(id) || existing.slides || [];
      const updatedBranding: PresentationBranding = body.branding
        ? { colors: { ...(body.branding.colors ?? {}) }, logoAssetId: body.branding.logoAssetId }
        : {
            colors: { ...(existing.branding?.colors ?? {}) },
            logoAssetId: existing.branding?.logoAssetId,
          };

      const updatedTitle = body.title ? sanitizeText(body.title) : existing.title;
      const updatedDescription =
        body.description !== undefined ? sanitizeText(body.description) : existing.description;
      const updatedEventName =
        body.eventName !== undefined ? sanitizeText(body.eventName) : existing.eventName;
      const updatedEndingSlideId = body.endingSlideId || existing.endingSlideId;

      const updated: Presentation = {
        ...existing,
        title: updatedTitle,
        description: updatedDescription,
        eventName: updatedEventName,
        status: body.status || existing.status,
        endingSlideId: updatedEndingSlideId,
        branding: updatedBranding,
        slides: updatedSlides,
        revision: newRevision,
        revisionHash: computePresentationRevisionHash({
          title: updatedTitle,
          description: updatedDescription,
          eventName: updatedEventName,
          endingSlideId: updatedEndingSlideId,
          branding: updatedBranding,
          slides: updatedSlides,
        }),
        updatedAt: new Date().toISOString(),
      };

      store.slides.set(id, updatedSlides);
      store.presentations.set(id, updated);

      // Invalidate & purge stale assets in memory, D1, and R2
      await purgeStaleAssets(env, id, newRevision);
      await persistPresentationToD1(env, updated, updatedSlides);

      return jsonResponse(updated);
    }

    // 4. DELETE /api/v1/presentations/:id (Admin, confirmDestroy required)
    if (method === 'DELETE' && presMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }

      const headerConfirm = request.headers.get('x-confirm-destroy');
      const queryConfirm = url.searchParams.get('confirmDestroy');
      let bodyConfirm = false;
      try {
        const parsed = (await request.json().catch(() => ({}))) as { confirmDestroy?: boolean };
        bodyConfirm = parsed.confirmDestroy === true;
      } catch {
        bodyConfirm = false;
      }

      const confirmed = headerConfirm === 'true' || queryConfirm === 'true' || bodyConfirm;
      if (!confirmed) {
        return errorResponse(
          'Destructive action requires confirmation (confirmDestroy: true)',
          400,
        );
      }

      const id = presMatch[1]!;
      const existing = await hydratePresentationFromD1(env, id);
      if (!existing) {
        return errorResponse('Presentation not found', 404);
      }

      await purgeStaleAssets(env, id, '__deleted__');
      store.presentations.delete(id);
      store.slides.delete(id);
      store.assets.delete(id);
      store.navigationRules.delete(id);

      const db = asD1(env);
      if (db) {
        await db.prepare('DELETE FROM presentations WHERE id = ?').bind(id).run();
      }

      return jsonResponse({ ok: true, deleted: id });
    }

    // 5. POST /api/v1/presentations/:id/duplicate (Admin, SPEC-017)
    const dupMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/duplicate$/);
    if (method === 'POST' && dupMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const sourceId = dupMatch[1]!;
      const source = await hydratePresentationFromD1(env, sourceId);
      if (!source) {
        return errorResponse('Source presentation not found', 404);
      }

      const dupBody = (await request.json().catch(() => ({}))) as { title?: string };
      const targetId = generateSecureId('pres');
      const sourceSlides = store.slides.get(sourceId) || [];
      const clonedSlides: SlideMetadata[] = sourceSlides.map((s) => ({
        ...s,
        presentationId: targetId,
      }));
      const clonedBranding: PresentationBranding = {
        colors: { ...(source.branding?.colors ?? {}) },
        logoAssetId: source.branding?.logoAssetId,
      };
      const dupTitle = dupBody.title ? sanitizeText(dupBody.title) : `${source.title} (Copy)`;
      const now = new Date().toISOString();

      const duplicated: Presentation = {
        id: targetId,
        title: dupTitle,
        description: source.description,
        eventName: source.eventName,
        revision: 'rev-1',
        revisionHash: computePresentationRevisionHash({
          title: dupTitle,
          description: source.description,
          eventName: source.eventName,
          endingSlideId: source.endingSlideId,
          branding: clonedBranding,
          slides: clonedSlides,
        }),
        status: 'draft',
        endingSlideId: source.endingSlideId,
        branding: clonedBranding,
        slides: clonedSlides,
        createdAt: now,
        updatedAt: now,
      };

      store.presentations.set(targetId, duplicated);
      store.slides.set(targetId, clonedSlides);
      store.assets.set(targetId, []);
      await persistPresentationToD1(env, duplicated, clonedSlides);
      return jsonResponse(duplicated, 201);
    }

    // 6. POST /api/v1/presentations/:id/assets (Admin)
    const assetMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/assets$/);
    if (method === 'POST' && assetMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const presentationId = assetMatch[1]!;
      const presentation = await hydratePresentationFromD1(env, presentationId);
      if (!presentation) {
        return errorResponse('Presentation not found', 404);
      }

      const contentType = request.headers.get('content-type') || '';
      let assetKind: 'slide-png' | 'deck-pdf' | 'logo' = 'slide-png';
      let slideId: string | undefined = url.searchParams.get('slideId') || undefined;
      let revision = url.searchParams.get('revision') || presentation.revision;
      let rawBytes: Uint8Array;

      if (contentType.includes('application/json')) {
        const body = (await request.json()) as {
          kind?: 'slide-png' | 'deck-pdf' | 'logo';
          slideId?: string;
          revision?: string;
          base64?: string;
        };
        assetKind = body.kind || 'slide-png';
        slideId = body.slideId || slideId;
        revision = body.revision || revision;
        rawBytes = body.base64
          ? Uint8Array.from(atob(body.base64), (c) => c.charCodeAt(0))
          : new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      } else {
        const arrayBuf = await request.arrayBuffer();
        rawBytes = new Uint8Array(arrayBuf);
        if (contentType.includes('pdf')) {
          assetKind = 'deck-pdf';
        }
      }

      if (revision !== presentation.revision) {
        return errorResponse(
          `Revision mismatch: asset revision '${revision}' does not match current presentation revision '${presentation.revision}'`,
          409,
        );
      }

      const assetId = generateSecureId('asset');
      const r2Key = `presentations/${presentationId}/${revision}/${assetKind}/${slideId ? `${slideId}.png` : 'deck.pdf'}`;

      const entry: AssetManifestEntry = {
        assetId,
        presentationId,
        revision,
        kind: assetKind,
        slideId,
        r2Key,
        contentType: assetKind === 'deck-pdf' ? 'application/pdf' : 'image/png',
        byteSize: rawBytes.byteLength,
        createdAt: new Date().toISOString(),
      };

      const existingAssets = store.assets.get(presentationId) || [];
      existingAssets.push(entry);
      store.assets.set(presentationId, existingAssets);
      store.assetBlobs.set(r2Key, { bytes: rawBytes, contentType: entry.contentType });

      const r2 = asR2(env);
      if (r2) {
        await r2.put(r2Key, rawBytes, { httpMetadata: { contentType: entry.contentType } });
      }
      const db = asD1(env);
      if (db) {
        await db
          .prepare(
            `INSERT OR REPLACE INTO asset_manifests
             (asset_id, presentation_id, revision, kind, slide_id, r2_key, content_type, byte_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.assetId,
            entry.presentationId,
            entry.revision,
            entry.kind,
            entry.slideId ?? null,
            entry.r2Key,
            entry.contentType,
            entry.byteSize,
            entry.createdAt,
          )
          .run();
      }

      return jsonResponse(entry, 201);
    }

    // 7. POST /api/v1/presentations/:id/sessions (Admin/Presenter)
    const sessionCreateMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/sessions$/);
    if (method === 'POST' && sessionCreateMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const presentationId = sessionCreateMatch[1]!;
      const presentation = await hydratePresentationFromD1(env, presentationId);
      if (!presentation) {
        return errorResponse('Presentation not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        status?: 'scheduled' | 'live';
      };
      const initialStatus = body.status === 'scheduled' ? 'scheduled' : 'live';

      const sessionId = generateSecureId('session');
      const presenterToken = generateSecureId('tok-pres');
      const slides = store.slides.get(presentationId) || [];
      const firstSlideId = initialStatus === 'live' ? slides[0]?.id || null : null;

      const audienceUrl = `${url.origin}/sessions/${sessionId}`;
      const qrCodeDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50" font-size="6">Agora QR: ${audienceUrl}</text></svg>`,
      )}`;

      const session: PresentationSession = {
        id: sessionId,
        presentationId,
        presentationRevision: presentation.revision,
        status: initialStatus,
        currentSlideId: firstSlideId,
        revealedSlideIds: firstSlideId ? [firstSlideId] : [],
        pdfDownloadUnlocked: false,
        audienceUrl,
        qrCodeDataUrl,
        connectedParticipants: 0,
        startedAt: initialStatus === 'live' ? new Date().toISOString() : undefined,
      };

      store.sessions.set(sessionId, session);
      store.presenterTokens.set(sessionId, presenterToken);
      store.questions.set(sessionId, []);
      store.reactions.set(sessionId, new Map());
      store.polls.set(sessionId, []);
      store.wordClouds.set(sessionId, []);

      await persistSessionToDO(env, session, presenterToken);
      broadcastRealtimeEvent(sessionId, 'session.state', session);

      return jsonResponse({ ...session, presenterToken }, 201);
    }

    // 7b. POST /api/v1/sessions/:id/start (Transition scheduled -> live, SPEC-002)
    const startMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/start$/);
    if (method === 'POST' && startMatch) {
      const sessionId = startMatch[1]!;
      const session = await hydrateSessionFromDO(env, sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }
      if (session.status === 'completed') {
        return errorResponse('Cannot start a completed session', 400);
      }

      const slides = store.slides.get(session.presentationId) || [];
      const started = startScheduledSession(session, slides, 'presenter');
      store.sessions.set(sessionId, started);
      await persistSessionToDO(env, started);
      broadcastRealtimeEvent(sessionId, 'session.state', started);

      return jsonResponse(started);
    }

    // 8. POST /api/v1/sessions/:id/join (Anonymous attendee join)
    const joinMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/join$/);
    if (method === 'POST' && joinMatch) {
      const sessionId = joinMatch[1]!;
      const session = await hydrateSessionFromDO(env, sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }
      if (session.status === 'completed') {
        return errorResponse('Cannot join completed session', 400);
      }

      const body = (await request.json().catch(() => ({}))) as { displayName?: string };
      const participantId = generateSecureId('part');
      const token = generateSecureId('ptok');

      const participant: ParticipantIdentity = {
        id: participantId,
        sessionId,
        token,
        displayName: body.displayName ? sanitizeText(body.displayName) : undefined,
        joinedAt: new Date().toISOString(),
      };

      store.participants.set(participantId, participant);
      store.participantTokens.set(token, participantId);
      session.connectedParticipants = (session.connectedParticipants ?? 0) + 1;

      persistParticipantToDO(env, participant);
      await persistSessionToDO(env, session);

      broadcastRealtimeEvent(sessionId, 'session.joined', {
        participantId,
        displayName: participant.displayName,
        connectedParticipants: session.connectedParticipants,
      });

      return jsonResponse(participant, 201);
    }

    // 9. GET /api/v1/sessions/:id (Audience-safe state)
    const sessionGetMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionGetMatch) {
      const sessionId = sessionGetMatch[1]!;
      const session = await hydrateSessionFromDO(env, sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      await hydratePresentationFromD1(env, session.presentationId);
      const slides = store.slides.get(session.presentationId) || [];
      const presentationAssets = store.assets.get(session.presentationId) || [];
      const currentRevAssets = presentationAssets.filter(
        (a) => a.revision === session.presentationRevision,
      );

      const availablePngSlideIds = currentRevAssets
        .filter((a) => a.kind === 'slide-png' && a.slideId)
        .map((a) => a.slideId as string);

      const pdfAvailable = currentRevAssets.some((a) => a.kind === 'deck-pdf');

      const questions = store.questions.get(sessionId) || [];
      const sessionPolls = store.polls.get(sessionId) || [];
      const activePolls: PollResultsSummary[] = sessionPolls.map((poll) =>
        buildPollResultsSummary(poll),
      );

      const sessionWordClouds = store.wordClouds.get(sessionId) || [];
      const activeWordClouds: WordCloudAggregate[] = sessionWordClouds.map((wc) =>
        buildWordCloudAggregate(wc),
      );

      const reactionMap = store.reactions.get(sessionId) || new Map();
      const reactionSummary: Record<string, ReactionCounts> = {};
      for (const [sId, counts] of reactionMap.entries()) {
        reactionSummary[sId] = { ...counts };
      }

      const view: AudienceSafeSessionView = {
        session,
        slides,
        availablePngSlideIds,
        pdfAvailable,
        questions,
        activePolls,
        activeWordClouds,
        reactionSummary,
      };

      return jsonResponse(view);
    }

    // 10. POST /api/v1/sessions/:id/slide (Authorized Presenter)
    const slideMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/slide$/);
    if (method === 'POST' && slideMatch) {
      const sessionId = slideMatch[1]!;
      const session = await hydrateSessionFromDO(env, sessionId);
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        indexh?: number;
        indexv?: number;
        horizontalIndex?: number;
        verticalIndex?: number;
        timestamp?: string;
      };
      if (!body.slideId) {
        return errorResponse('slideId is required', 400);
      }

      const slideId = body.slideId;
      const horizontalIndex =
        typeof body.horizontalIndex === 'number'
          ? body.horizontalIndex
          : typeof body.indexh === 'number'
            ? body.indexh
            : 0;
      const verticalIndex =
        typeof body.verticalIndex === 'number'
          ? body.verticalIndex
          : typeof body.indexv === 'number'
            ? body.indexv
            : 0;
      const timestamp =
        typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString();

      session.currentSlideId = slideId;

      if (!session.revealedSlideIds.includes(slideId)) {
        session.revealedSlideIds.push(slideId);
      }

      const presentation = await hydratePresentationFromD1(env, session.presentationId);
      let unlockedJustNow = false;
      if (presentation?.endingSlideId === slideId && !session.pdfDownloadUnlocked) {
        session.pdfDownloadUnlocked = true;
        unlockedJustNow = true;
      }

      await persistSessionToDO(env, session);

      broadcastRealtimeEvent(sessionId, 'slide.changed', {
        slideId,
        horizontalIndex,
        verticalIndex,
        timestamp,
        revealedSlideIds: session.revealedSlideIds,
      });

      if (unlockedJustNow) {
        broadcastRealtimeEvent(sessionId, 'presentation.download.unlocked', {
          sessionId,
          unlockedAt: new Date().toISOString(),
        });
      }

      return jsonResponse(session);
    }

    // 11. POST /api/v1/sessions/:id/complete (Authorized Presenter explicit session completion)
    const completeMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/complete$/);
    if (method === 'POST' && completeMatch) {
      const sessionId = completeMatch[1]!;
      const session = await hydrateSessionFromDO(env, sessionId);
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      session.status = 'completed';
      session.completedAt = new Date().toISOString();

      await persistSessionToDO(env, session);
      broadcastRealtimeEvent(sessionId, 'session.state', session);
      return jsonResponse(session);
    }

    // 12. GET /api/v1/sessions/:id/slides/:slideId (Server-side validation for revealed slide)
    const slideDetailMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/slides\/([^/]+)$/);
    if (method === 'GET' && slideDetailMatch) {
      const sessionId = slideDetailMatch[1]!;
      const slideId = slideDetailMatch[2]!;

      const session = await hydrateSessionFromDO(env, sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      if (!session.revealedSlideIds.includes(slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      await hydratePresentationFromD1(env, session.presentationId);
      const slides = store.slides.get(session.presentationId) || [];
      const slide = slides.find((s) => s.id === slideId);
      if (!slide) {
        return errorResponse('Slide not found', 404);
      }

      return jsonResponse(slide);
    }

    // 13. GET & POST /api/v1/sessions/:id/questions
    const questionsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/questions$/);
    if (method === 'GET' && questionsMatch) {
      const sessionId = questionsMatch[1]!;
      let list = store.questions.get(sessionId);
      if (!list || list.length === 0) {
        await hydrateSessionFromDO(env, sessionId);
        list = store.questions.get(sessionId) || [];
      }
      const rawSlideIdFilter = url.searchParams.get('slideId');
      const slideIdFilter = rawSlideIdFilter ? rawSlideIdFilter.split(/[#/:]/)[0]!.trim() : null;
      const filtered = slideIdFilter ? list.filter((q) => q.slideId === slideIdFilter) : list;

      const rawSortBy = url.searchParams.get('sortBy');
      const sortBy =
        rawSortBy === 'time' || rawSortBy === 'created' || rawSortBy === 'createdAt'
          ? 'time'
          : 'votes';
      const rawOrder = url.searchParams.get('order');
      const order = rawOrder === 'asc' ? 'asc' : 'desc';

      const sorted = sortQuestions(filtered, sortBy, order);
      return jsonResponse(sorted);
    }

    if (method === 'POST' && questionsMatch) {
      const sessionId = questionsMatch[1]!;
      const participant = getParticipantFromToken(request, sessionId);
      if (!participant) {
        return errorResponse('Unauthorized participant', 401);
      }

      if (!rateLimiter.check(`q:${participant.id}`, maxQuestions, rateWindowMs)) {
        return errorResponse('Rate limit exceeded. Please slow down.', 429);
      }

      let session = store.sessions.get(sessionId);
      if (!session) {
        session = (await hydrateSessionFromDO(env, sessionId)) ?? undefined;
      }
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        content?: string;
        participantName?: string;
      };

      const rawSlideId =
        typeof body.slideId === 'string' ? body.slideId.split(/[#/:]/)[0]!.trim() : '';

      if (!rawSlideId || !body.content) {
        return errorResponse('slideId and content are required', 400);
      }

      if (!session.revealedSlideIds.includes(rawSlideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      let question: AudienceQuestion;
      try {
        question = createAudienceQuestion({
          id: generateSecureId('q'),
          sessionId,
          slideId: rawSlideId,
          participantId: participant.id,
          rawContent: body.content,
          rawParticipantName: body.participantName ?? participant.displayName,
        });
      } catch (err) {
        return errorResponse((err as Error).message || 'Invalid question content', 400);
      }

      const qList = store.questions.get(sessionId) || [];
      qList.push(question);
      store.questions.set(sessionId, qList);

      persistQuestionToDO(env, question);
      broadcastRealtimeEvent(sessionId, 'question.submitted', question);
      return jsonResponse(question, 201);
    }

    // 14. POST /api/v1/sessions/:id/questions/:questionId/upvote (Idempotent toggle upvote)
    const upvoteMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/questions\/([^/]+)\/upvote$/);
    if (method === 'POST' && upvoteMatch) {
      const sessionId = upvoteMatch[1]!;
      const questionId = upvoteMatch[2]!;

      const participant = getParticipantFromToken(request, sessionId);
      if (!participant) {
        return errorResponse('Unauthorized participant', 401);
      }

      const session = await hydrateSessionFromDO(env, sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      let qList = store.questions.get(sessionId);
      if (!qList || qList.length === 0) {
        await hydrateSessionFromDO(env, sessionId);
        qList = store.questions.get(sessionId) || [];
      }

      const question = qList.find((q) => q.id === questionId);
      if (!question) {
        return errorResponse('Question not found', 404);
      }

      // Authoritative revelation access control: question slide must be revealed (SPEC-005, SPEC-007)
      if (!isSlideRevealed(session, question.slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      let upvotedSet = store.questionUpvotes.get(questionId);
      if (!upvotedSet) {
        upvotedSet = new Set(question.upvotedByParticipantIds ?? []);
        store.questionUpvotes.set(questionId, upvotedSet);
      }

      let userUpvoted = false;
      if (upvotedSet.has(participant.id)) {
        upvotedSet.delete(participant.id);
        question.upvotes = Math.max(0, question.upvotes - 1);
        userUpvoted = false;
      } else {
        upvotedSet.add(participant.id);
        question.upvotes += 1;
        userUpvoted = true;
      }
      question.upvotedByParticipantIds = Array.from(upvotedSet);

      const doState = asDO(env, sessionId);
      if (doState) {
        if (userUpvoted) {
          doState.storage.sql.exec(
            `INSERT OR REPLACE INTO question_upvotes (question_id, participant_id, session_id, created_at)
             VALUES (?, ?, ?, ?)`,
            questionId,
            participant.id,
            sessionId,
            new Date().toISOString(),
          );
        } else {
          doState.storage.sql.exec(
            'DELETE FROM question_upvotes WHERE question_id = ? AND participant_id = ?',
            questionId,
            participant.id,
          );
        }
        doState.storage.sql.exec(
          'UPDATE questions SET upvotes = ? WHERE id = ? AND session_id = ?',
          question.upvotes,
          questionId,
          sessionId,
        );
      }

      broadcastRealtimeEvent(sessionId, 'question.upvoted', {
        questionId,
        voteCount: question.upvotes,
        upvotes: question.upvotes,
        participantId: participant.id,
        hasUpvoted: userUpvoted,
        userUpvoted,
      });

      return jsonResponse({
        ...question,
        voteCount: question.upvotes,
        hasUpvoted: userUpvoted,
        userUpvoted,
      });
    }

    // 15. PATCH /api/v1/sessions/:id/questions/:questionId (Presenter marks answered/dismissed)
    const questionUpdateMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/questions\/([^/]+)$/);
    if (method === 'PATCH' && questionUpdateMatch) {
      const sessionId = questionUpdateMatch[1]!;
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }

      const questionId = questionUpdateMatch[2]!;
      const qList = store.questions.get(sessionId) || [];
      const question = qList.find((q) => q.id === questionId);
      if (!question) {
        return errorResponse('Question not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        status?: 'pending' | 'answered' | 'dismissed';
      };
      if (!body.status || !['pending', 'answered', 'dismissed'].includes(body.status)) {
        return errorResponse("status must be 'pending', 'answered', or 'dismissed'", 400);
      }

      const updated = updateQuestionStatus(question, body.status);
      const idx = qList.findIndex((q) => q.id === questionId);
      if (idx >= 0) {
        qList[idx] = updated;
      }

      updateQuestionStatusInDO(env, sessionId, questionId, body.status);
      broadcastRealtimeEvent(sessionId, 'question.updated', updated);
      return jsonResponse(updated);
    }

    // 16. POST /api/v1/sessions/:id/reactions (Emoji reactions 👍 🤔 ❤️ 😴)
    const reactionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/reactions$/);
    if (method === 'POST' && reactionMatch) {
      const sessionId = reactionMatch[1]!;
      const participant = getParticipantFromToken(request, sessionId);
      if (!participant) {
        return errorResponse('Unauthorized participant', 401);
      }

      if (!rateLimiter.check(`react:${participant.id}`, maxReactions, rateWindowMs)) {
        return errorResponse('Rate limit exceeded. Please slow down.', 429);
      }

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        reaction?: Reaction;
      };

      if (!body.slideId || !body.reaction) {
        return errorResponse('slideId and reaction are required', 400);
      }

      if (!ALLOWED_REACTIONS.includes(body.reaction)) {
        return errorResponse('Invalid reaction emoji', 400);
      }

      if (!session.revealedSlideIds.includes(body.slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      const coordinator = getCoordinator(sessionId);
      const currentCounts = coordinator.recordReaction(body.slideId, body.reaction);

      broadcastRealtimeEvent(sessionId, 'reaction.added', {
        slideId: body.slideId,
        reaction: body.reaction,
        counts: currentCounts,
      });

      return jsonResponse({ ok: true, summary: currentCounts });
    }

    // 17. POST /api/v1/sessions/:id/polls (Presenter creates poll)
    const pollCreateMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/polls$/);
    if (method === 'POST' && pollCreateMatch) {
      const sessionId = pollCreateMatch[1]!;
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        question?: string;
        type?: 'single' | 'multiple' | 'binary';
        options?: PollOption[];
      };

      if (!body.slideId || !body.question || !body.options || body.options.length === 0) {
        return errorResponse('slideId, question, and options are required', 400);
      }

      const poll: PollDefinition = {
        id: generateSecureId('poll'),
        sessionId,
        slideId: body.slideId,
        question: sanitizeText(body.question),
        type: body.type || 'single',
        options: body.options,
        status: 'open',
        resultsRevealed: false,
      };

      const pollList = store.polls.get(sessionId) || [];
      pollList.push(poll);
      store.polls.set(sessionId, pollList);
      store.pollVotes.set(poll.id, new Map());

      broadcastRealtimeEvent(sessionId, 'poll.opened', poll);
      return jsonResponse(poll, 201);
    }

    // 18. POST /api/v1/sessions/:id/polls/:pollId/vote (Attendee votes + adaptive navigation suggestion)
    const pollVoteMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/polls\/([^/]+)\/vote$/);
    if (method === 'POST' && pollVoteMatch) {
      const sessionId = pollVoteMatch[1]!;
      const pollId = pollVoteMatch[2]!;

      const participant = getParticipantFromToken(request, sessionId);
      if (!participant) {
        return errorResponse('Unauthorized participant', 401);
      }

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const pollList = store.polls.get(sessionId) || [];
      const poll = pollList.find((p) => p.id === pollId);
      if (!poll) {
        return errorResponse('Poll not found', 404);
      }

      if (poll.status !== 'open') {
        return errorResponse('Poll is closed', 400);
      }

      if (!isSlideRevealed(session, poll.slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      const body = (await request.json().catch(() => ({}))) as { optionId?: string };
      if (!body.optionId || !poll.options.some((o: PollOption) => o.id === body.optionId)) {
        return errorResponse('Valid optionId is required', 400);
      }

      let votes = store.pollVotes.get(pollId);
      if (!votes) {
        votes = new Map();
        store.pollVotes.set(pollId, votes);
      }

      // Single-choice poll uniqueness per participant
      if (votes.has(participant.id)) {
        return errorResponse('Participant has already voted in this poll', 409);
      }

      votes.set(participant.id, body.optionId);

      const summary = buildPollResultsSummary(poll);
      const counts = summary.countsByOptionId;
      const totalResponses = summary.totalResponses;

      // Evaluate adaptive navigation rules
      const rules = store.navigationRules.get(session.presentationId) || [];
      const suggestions: NavigationSuggestion[] = [];

      for (const rule of rules) {
        if (rule.pollId === pollId && rule.optionId === body.optionId) {
          const voteCount = counts[rule.optionId] || 0;
          const percentage = totalResponses > 0 ? (voteCount / totalResponses) * 100 : 0;

          const meetsCount = voteCount >= rule.minVoteThreshold;
          const meetsPercent =
            rule.minPercentageThreshold !== undefined
              ? percentage >= rule.minPercentageThreshold
              : true;

          if (meetsCount && meetsPercent) {
            const suggestion: NavigationSuggestion = {
              ruleId: rule.id,
              sourceSlideId: rule.sourceSlideId,
              pollId: rule.pollId,
              optionId: rule.optionId,
              targetSlideId: rule.targetSlideId,
              targetHorizontalIndex: rule.targetHorizontalIndex,
              targetVerticalIndex: rule.targetVerticalIndex,
              reason: `Poll option reached ${voteCount} votes (${Math.round(percentage)}%)`,
            };
            suggestions.push(suggestion);
            broadcastRealtimeEvent(sessionId, 'navigation.suggested', suggestion);
          }
        }
      }

      broadcastRealtimeEvent(sessionId, 'poll.results', summary);
      return jsonResponse({ ok: true, summary, suggestions });
    }

    // 19. POST /api/v1/sessions/:id/wordclouds (Presenter creates prompt)
    const wcCreateMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/wordclouds$/);
    if (method === 'POST' && wcCreateMatch) {
      const sessionId = wcCreateMatch[1]!;
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        prompt?: string;
      };

      if (!body.slideId || !body.prompt) {
        return errorResponse('slideId and prompt are required', 400);
      }

      const prompt: WordCloudPrompt = {
        id: generateSecureId('wc'),
        sessionId,
        slideId: body.slideId,
        prompt: sanitizeText(body.prompt),
        status: 'open',
      };

      const promptList = store.wordClouds.get(sessionId) || [];
      promptList.push(prompt);
      store.wordClouds.set(sessionId, promptList);
      store.wordCloudSubmissions.set(prompt.id, []);

      return jsonResponse(prompt, 201);
    }

    // 20. POST /api/v1/sessions/:id/wordclouds/:promptId/submit (Attendee submits term)
    const wcSubmitMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/wordclouds\/([^/]+)\/submit$/);
    if (method === 'POST' && wcSubmitMatch) {
      const sessionId = wcSubmitMatch[1]!;
      const promptId = wcSubmitMatch[2]!;

      const participant = getParticipantFromToken(request, sessionId);
      if (!participant) {
        return errorResponse('Unauthorized participant', 401);
      }

      if (!rateLimiter.check(`wc:${participant.id}`, 10, rateWindowMs)) {
        return errorResponse('Rate limit exceeded. Please slow down.', 429);
      }

      const promptList = store.wordClouds.get(sessionId) || [];
      const prompt = promptList.find((p) => p.id === promptId);
      if (!prompt) {
        return errorResponse('Word cloud prompt not found', 404);
      }

      if (prompt.status !== 'open') {
        return errorResponse('Word cloud prompt is closed', 400);
      }

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      if (!isSlideRevealed(session, prompt.slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      const body = (await request.json().catch(() => ({}))) as { term?: string };
      if (!body.term) {
        return errorResponse('term is required', 400);
      }

      const normalized = normalizeWordCloudTerm(body.term);
      if (!normalized) {
        return errorResponse('Invalid term', 400);
      }

      let subs = store.wordCloudSubmissions.get(promptId);
      if (!subs) {
        subs = [];
        store.wordCloudSubmissions.set(promptId, subs);
      }
      subs.push({ participantId: participant.id, term: normalized });

      const aggregate = buildWordCloudAggregate(prompt);

      broadcastRealtimeEvent(sessionId, 'wordcloud.updated', aggregate);
      return jsonResponse(aggregate);
    }

    // 21. GET /api/v1/sessions/:id/slides/:slideId/download (Authorized PNG download)
    const pngDownloadMatch = path.match(
      /^\/api\/v1\/sessions\/([^/]+)\/slides\/([^/]+)\/download$/,
    );
    if (method === 'GET' && pngDownloadMatch) {
      const sessionId = pngDownloadMatch[1]!;
      const slideId = pngDownloadMatch[2]!;

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      // Must be revealed
      if (!session.revealedSlideIds.includes(slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      // Check current-revision PNG asset
      const assets = store.assets.get(session.presentationId) || [];
      const asset = assets.find(
        (a) =>
          a.revision === session.presentationRevision &&
          a.kind === 'slide-png' &&
          a.slideId === slideId,
      );

      if (!asset) {
        return errorResponse('Slide image not found for current revision', 404);
      }

      const blob = store.assetBlobs.get(asset.r2Key);
      const bytes = blob ? blob.bytes : new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      return new Response(bytes.buffer as ArrayBuffer, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': `inline; filename="${slideId}.png"`,
          'Cache-Control': 'private, no-cache',
        },
      });
    }

    // 22. GET /api/v1/sessions/:id/download (Authorized Full PDF download)
    const pdfDownloadMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/download$/);
    if (method === 'GET' && pdfDownloadMatch) {
      const sessionId = pdfDownloadMatch[1]!;
      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      // Must be unlocked
      if (!session.pdfDownloadUnlocked) {
        return errorResponse(
          'Full presentation PDF download is locked until presenter reaches ending slide',
          403,
        );
      }

      // Check current-revision PDF asset
      const assets = store.assets.get(session.presentationId) || [];
      const asset = assets.find(
        (a) => a.revision === session.presentationRevision && a.kind === 'deck-pdf',
      );

      if (!asset) {
        return errorResponse('Presentation PDF not found for current revision', 404);
      }

      const blob = store.assetBlobs.get(asset.r2Key);
      const bytes = blob
        ? blob.bytes
        : new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

      return new Response(bytes.buffer as ArrayBuffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="presentation.pdf"',
          'Cache-Control': 'private, no-cache',
        },
      });
    }

    // 23. WebSocket /api/v1/sessions/:id/ws
    const wsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const sessionId = wsMatch[1]!;
      await hydrateSessionFromDO(env, sessionId);
      const origin = request.headers.get('Origin');
      const coordinator = getCoordinator(sessionId);

      if (!coordinator.validateOrigin(origin)) {
        return errorResponse('Origin not allowed', 403);
      }

      const authHeader = request.headers.get('Authorization');
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const wsToken =
        url.searchParams.get('token') ??
        request.headers.get('x-presenter-token') ??
        bearerToken ??
        null;

      // For tests or CF Workers WebSocketPair
      const pair = (globalThis as unknown as { WebSocketPair?: new () => [WebSocket, WebSocket] })
        .WebSocketPair;
      if (pair) {
        const [client, server] = new pair();
        (server as unknown as { accept: () => void }).accept?.();
        asDO(env, sessionId)?.acceptWebSocket(server, ['session']);
        coordinator.handleConnection(server, origin, wsToken);
        return new Response(null, { status: 101, webSocket: client } as ResponseInit);
      }

      return new Response('WebSocket endpoint ready', { status: 200 });
    }

    return errorResponse(`Not Found: ${method} ${path}`, 404);
  }

  return {
    fetch: (request: Request, env?: WorkerEnv) => handleRequest(request, env),
    store,
    getCoordinator,
  };
}

const defaultApp = createAgoraWorkerApp();

export default {
  fetch(request: Request, env: WorkerEnv, _ctx?: unknown): Promise<Response> {
    const adminToken = env?.ADMIN_TOKEN;
    if (adminToken) {
      const app = createAgoraWorkerApp({ adminToken });
      return app.fetch(request, env);
    }
    return defaultApp.fetch(request, env);
  },
};
