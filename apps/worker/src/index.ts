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
  type PresentationSession,
  type Reaction,
  type ReactionCounts,
  type RealtimeEvent,
  type RealtimeEventType,
  type SlideMetadata,
  type WordCloudAggregate,
  type WordCloudPrompt,
} from '@agora/contracts';

export interface WorkerEnv {
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
  DB?: unknown;
  ASSETS_BUCKET?: unknown;
  SESSION_COORDINATOR?: unknown;
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
  public presentations: Map<string, Presentation> = new Map();
  public slides: Map<string, SlideMetadata[]> = new Map();
  public navigationRules: Map<string, NavigationRule[]> = new Map();
  public assets: Map<string, AssetManifestEntry[]> = new Map();
  public assetBlobs: Map<string, { bytes: Uint8Array; contentType: string }> = new Map();

  public sessions: Map<string, PresentationSession> = new Map();
  public participants: Map<string, ParticipantIdentity> = new Map();
  public participantTokens: Map<string, string> = new Map(); // token -> participantId
  public presenterTokens: Map<string, string> = new Map(); // sessionId -> presenterToken

  public questions: Map<string, AudienceQuestion[]> = new Map(); // sessionId -> questions
  public questionUpvotes: Map<string, Set<string>> = new Map(); // questionId -> Set<participantId>
  public reactions: Map<string, Map<string, ReactionCounts>> = new Map(); // sessionId -> slideId -> counts
  public polls: Map<string, PollDefinition[]> = new Map(); // sessionId -> polls
  public pollVotes: Map<string, Map<string, string>> = new Map(); // pollId -> participantId -> optionId
  public wordClouds: Map<string, WordCloudPrompt[]> = new Map(); // sessionId -> prompts
  public wordCloudSubmissions: Map<string, { participantId: string; term: string }[]> = new Map(); // promptId -> submissions
  public processedEvents: Map<string, Set<string>> = new Map(); // sessionId -> Set<eventId>
}

export class SessionCoordinatorDO {
  private sockets: Set<WebSocket> = new Set();
  private store: InMemoryAgoraStore;
  private sessionId: string;
  private allowedOrigins: string[];

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

  public handleConnection(ws: WebSocket, origin: string | null): boolean {
    if (!this.validateOrigin(origin)) {
      ws.close(1008, 'Origin not allowed');
      return false;
    }

    this.sockets.add(ws);
    return true;
  }

  public removeConnection(ws: WebSocket): void {
    this.sockets.delete(ws);
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serialized);
        }
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  public getActiveConnectionCount(): number {
    return this.sockets.size;
  }
}

export const SessionDurableObject = SessionCoordinatorDO;

class RateLimiter {
  private records: Map<string, number[]> = new Map();

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
  const coordinators: Map<string, SessionCoordinatorDO> = new Map();

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
      id: id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      payload,
    };
    getCoordinator(sessionId).broadcast(event);
    return event;
  }

  async function handleRequest(request: Request, _env?: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, x-admin-token, x-presenter-token, x-participant-token, x-confirm-destroy',
        },
      });
    }

    // 1. POST /api/v1/presentations (Admin)
    if (method === 'POST' && path === '/api/v1/presentations') {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }

      const body = (await request.json().catch(() => ({}))) as Partial<Presentation>;
      const id = body.id || `pres-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const presentation: Presentation = {
        id,
        title: sanitizeText(body.title || 'Untitled Presentation'),
        description: body.description ? sanitizeText(body.description) : undefined,
        eventName: body.eventName ? sanitizeText(body.eventName) : undefined,
        revision: 'rev-1',
        status: body.status || 'draft',
        endingSlideId: body.endingSlideId || 'slide-ending',
        branding: body.branding || { colors: {} },
        slides: body.slides || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.presentations.set(id, presentation);
      store.slides.set(id, presentation.slides || []);
      store.assets.set(id, []);
      return jsonResponse(presentation, 201);
    }

    // 2. GET /api/v1/presentations/:id
    const presMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)$/);
    if (method === 'GET' && presMatch) {
      const id = presMatch[1]!;
      const presentation = store.presentations.get(id);
      if (!presentation) {
        return errorResponse('Presentation not found', 404);
      }
      return jsonResponse({
        ...presentation,
        slides: store.slides.get(id) || [],
      });
    }

    // 3. PATCH /api/v1/presentations/:id (Admin)
    if (method === 'PATCH' && presMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const id = presMatch[1]!;
      const existing = store.presentations.get(id);
      if (!existing) {
        return errorResponse('Presentation not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as Partial<Presentation>;
      // Bump revision on slide or content edit
      const currentRevNumber = Number.parseInt(existing.revision.replace(/\D/g, '') || '1', 10);
      const newRevision = `rev-${currentRevNumber + 1}`;

      const updated: Presentation = {
        ...existing,
        title: body.title ? sanitizeText(body.title) : existing.title,
        description:
          body.description !== undefined ? sanitizeText(body.description) : existing.description,
        eventName: body.eventName !== undefined ? sanitizeText(body.eventName) : existing.eventName,
        status: body.status || existing.status,
        endingSlideId: body.endingSlideId || existing.endingSlideId,
        branding: body.branding || existing.branding,
        revision: newRevision,
        updatedAt: new Date().toISOString(),
      };

      if (body.slides) {
        updated.slides = body.slides;
        store.slides.set(id, body.slides);
      }

      // Invalidate stale assets: keep only assets matching the new revision
      const existingAssets = store.assets.get(id) || [];
      const validAssets = existingAssets.filter((a) => a.revision === newRevision);
      store.assets.set(id, validAssets);

      store.presentations.set(id, updated);
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
      if (!store.presentations.has(id)) {
        return errorResponse('Presentation not found', 404);
      }

      store.presentations.delete(id);
      store.slides.delete(id);
      store.assets.delete(id);
      store.navigationRules.delete(id);
      return jsonResponse({ ok: true, deleted: id });
    }

    // 5. POST /api/v1/presentations/:id/duplicate (Admin)
    const dupMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/duplicate$/);
    if (method === 'POST' && dupMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const sourceId = dupMatch[1]!;
      const source = store.presentations.get(sourceId);
      if (!source) {
        return errorResponse('Source presentation not found', 404);
      }

      const targetId = `pres-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const sourceSlides = store.slides.get(sourceId) || [];
      const clonedSlides: SlideMetadata[] = sourceSlides.map((s) => ({
        ...s,
        presentationId: targetId,
      }));

      const duplicated: Presentation = {
        ...source,
        id: targetId,
        title: `${source.title} (Copy)`,
        revision: 'rev-1',
        slides: clonedSlides,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.presentations.set(targetId, duplicated);
      store.slides.set(targetId, clonedSlides);
      store.assets.set(targetId, []);
      return jsonResponse(duplicated, 201);
    }

    // 6. POST /api/v1/presentations/:id/assets (Admin)
    const assetMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/assets$/);
    if (method === 'POST' && assetMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const presentationId = assetMatch[1]!;
      const presentation = store.presentations.get(presentationId);
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

      const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

      return jsonResponse(entry, 201);
    }

    // 7. POST /api/v1/presentations/:id/sessions (Admin/Presenter)
    const sessionCreateMatch = path.match(/^\/api\/v1\/presentations\/([^/]+)\/sessions$/);
    if (method === 'POST' && sessionCreateMatch) {
      if (!authorizeAdmin(request)) {
        return errorResponse('Unauthorized: Admin authentication required', 401);
      }
      const presentationId = sessionCreateMatch[1]!;
      const presentation = store.presentations.get(presentationId);
      if (!presentation) {
        return errorResponse('Presentation not found', 404);
      }

      const sessionId = `session-${Date.now()}`;
      const presenterToken = `tok-pres-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const slides = store.slides.get(presentationId) || [];
      const firstSlideId = slides[0]?.id || null;

      const audienceUrl = `${url.origin}/sessions/${sessionId}`;
      const qrCodeDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50" font-size="6">Agora QR: ${audienceUrl}</text></svg>`,
      )}`;

      const session: PresentationSession = {
        id: sessionId,
        presentationId,
        presentationRevision: presentation.revision,
        status: 'live',
        currentSlideId: firstSlideId,
        revealedSlideIds: firstSlideId ? [firstSlideId] : [],
        pdfDownloadUnlocked: false,
        audienceUrl,
        qrCodeDataUrl,
        connectedParticipants: 0,
        startedAt: new Date().toISOString(),
      };

      store.sessions.set(sessionId, session);
      store.presenterTokens.set(sessionId, presenterToken);
      store.questions.set(sessionId, []);
      store.reactions.set(sessionId, new Map());
      store.polls.set(sessionId, []);
      store.wordClouds.set(sessionId, []);

      return jsonResponse({ ...session, presenterToken }, 201);
    }

    // 8. POST /api/v1/sessions/:id/join (Anonymous attendee join)
    const joinMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/join$/);
    if (method === 'POST' && joinMatch) {
      const sessionId = joinMatch[1]!;
      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as { displayName?: string };
      const participantId = `part-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const token = `ptok-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const participant: ParticipantIdentity = {
        id: participantId,
        sessionId,
        token,
        displayName: body.displayName ? sanitizeText(body.displayName) : undefined,
        joinedAt: new Date().toISOString(),
      };

      store.participants.set(participantId, participant);
      store.participantTokens.set(token, participantId);

      broadcastRealtimeEvent(sessionId, 'session.joined', {
        participantId,
        displayName: participant.displayName,
      });

      return jsonResponse(participant, 201);
    }

    // 9. GET /api/v1/sessions/:id (Audience-safe state)
    const sessionGetMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionGetMatch) {
      const sessionId = sessionGetMatch[1]!;
      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

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
      const activePolls: PollResultsSummary[] = sessionPolls.map((poll) => {
        const votes = store.pollVotes.get(poll.id) || new Map();
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
      });

      const sessionWordClouds = store.wordClouds.get(sessionId) || [];
      const activeWordClouds: WordCloudAggregate[] = sessionWordClouds.map((wc) => {
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
      });

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
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as { slideId?: string };
      if (!body.slideId) {
        return errorResponse('slideId is required', 400);
      }

      const slideId = body.slideId;
      session.currentSlideId = slideId;

      if (!session.revealedSlideIds.includes(slideId)) {
        session.revealedSlideIds.push(slideId);
      }

      const presentation = store.presentations.get(session.presentationId);
      let unlockedJustNow = false;
      if (presentation?.endingSlideId === slideId && !session.pdfDownloadUnlocked) {
        session.pdfDownloadUnlocked = true;
        unlockedJustNow = true;
      }

      broadcastRealtimeEvent(sessionId, 'slide.changed', {
        slideId,
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
      if (!authorizePresenter(request, sessionId)) {
        return errorResponse('Unauthorized: Presenter authentication required', 403);
      }

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      session.status = 'completed';
      session.completedAt = new Date().toISOString();

      broadcastRealtimeEvent(sessionId, 'session.state', session);
      return jsonResponse(session);
    }

    // 12. GET /api/v1/sessions/:id/slides/:slideId (Server-side validation for revealed slide)
    const slideDetailMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/slides\/([^/]+)$/);
    if (method === 'GET' && slideDetailMatch) {
      const sessionId = slideDetailMatch[1]!;
      const slideId = slideDetailMatch[2]!;

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      if (!session.revealedSlideIds.includes(slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

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
      const list = store.questions.get(sessionId) || [];
      const slideIdFilter = url.searchParams.get('slideId');
      const filtered = slideIdFilter ? list.filter((q) => q.slideId === slideIdFilter) : list;
      return jsonResponse(filtered);
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

      const session = store.sessions.get(sessionId);
      if (!session) {
        return errorResponse('Session not found', 404);
      }

      const body = (await request.json().catch(() => ({}))) as {
        slideId?: string;
        content?: string;
      };

      if (!body.slideId || !body.content) {
        return errorResponse('slideId and content are required', 400);
      }

      if (!session.revealedSlideIds.includes(body.slideId)) {
        return errorResponse('Slide has not been revealed yet', 403);
      }

      const sanitized = sanitizeText(body.content);
      if (!sanitized) {
        return errorResponse('Content cannot be empty after sanitization', 400);
      }

      const question: AudienceQuestion = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sessionId,
        slideId: body.slideId,
        participantId: participant.id,
        participantName: participant.displayName,
        content: sanitized,
        status: 'pending',
        upvotes: 0,
        createdAt: new Date().toISOString(),
      };

      const qList = store.questions.get(sessionId) || [];
      qList.push(question);
      store.questions.set(sessionId, qList);

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

      const qList = store.questions.get(sessionId) || [];
      const question = qList.find((q) => q.id === questionId);
      if (!question) {
        return errorResponse('Question not found', 404);
      }

      let upvotedSet = store.questionUpvotes.get(questionId);
      if (!upvotedSet) {
        upvotedSet = new Set();
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

      broadcastRealtimeEvent(sessionId, 'question.upvoted', {
        questionId,
        upvotes: question.upvotes,
        userUpvoted,
      });

      return jsonResponse({ ...question, userUpvoted });
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
      if (body.status && ['pending', 'answered', 'dismissed'].includes(body.status)) {
        question.status = body.status;
      }

      broadcastRealtimeEvent(sessionId, 'question.updated', question);
      return jsonResponse(question);
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

      let sessionReactions = store.reactions.get(sessionId);
      if (!sessionReactions) {
        sessionReactions = new Map();
        store.reactions.set(sessionId, sessionReactions);
      }

      const currentCounts: ReactionCounts = sessionReactions.get(body.slideId) || {
        '👍': 0,
        '🤔': 0,
        '❤️': 0,
        '😴': 0,
      };

      currentCounts[body.reaction] += 1;
      sessionReactions.set(body.slideId, currentCounts);

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
        id: `poll-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

      const counts: Record<string, number> = {};
      for (const opt of poll.options) {
        counts[opt.id] = 0;
      }
      for (const optId of votes.values()) {
        counts[optId] = (counts[optId] || 0) + 1;
      }

      const totalResponses = votes.size;
      const summary: PollResultsSummary = {
        pollId,
        slideId: poll.slideId,
        status: poll.status,
        resultsRevealed: poll.resultsRevealed,
        totalResponses,
        countsByOptionId: counts,
      };

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
        id: `wc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

      const termCounts: Record<string, number> = {};
      for (const sub of subs) {
        termCounts[sub.term] = (termCounts[sub.term] || 0) + 1;
      }
      const terms = Object.entries(termCounts)
        .map(([term, count]) => ({ term, count }))
        .sort((a, b) => b.count - a.count);

      const aggregate: WordCloudAggregate = {
        promptId,
        slideId: prompt.slideId,
        status: prompt.status,
        totalSubmissions: subs.length,
        terms,
      };

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
      const origin = request.headers.get('Origin');
      const coordinator = getCoordinator(sessionId);

      if (!coordinator.validateOrigin(origin)) {
        return errorResponse('Origin not allowed', 403);
      }

      // For tests or CF Workers WebSocketPair
      const pair = (globalThis as unknown as { WebSocketPair?: new () => [WebSocket, WebSocket] })
        .WebSocketPair;
      if (pair) {
        const [client, server] = new pair();
        (server as unknown as { accept: () => void }).accept?.();
        coordinator.handleConnection(server, origin);
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
