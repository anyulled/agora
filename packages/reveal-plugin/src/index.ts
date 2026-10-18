import type { AudienceQuestion, WebSocketLike } from '@agora/contracts';

export type { WebSocketLike };

export interface RevealAudienceConfig {
  sessionId: string;
  endpoint: string;
  presenterToken?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface SlideChangedDispatchPayload {
  slideId: string;
  horizontalIndex: number;
  verticalIndex: number;
  timestamp: string;
}

export interface SlideMetadataExtract {
  id: string;
  title: string;
  horizontalIndex: number;
  verticalIndex: number;
}

export interface RevealDeck {
  getConfig: () => Record<string, unknown> & { audience?: RevealAudienceConfig };
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  off?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  getCurrentSlide?: () => Element | null;
  getSlides?: () => Element[];
  getIndices?: (slide?: Element) => { h: number; v: number };
  slide?: (h: number, v?: number) => void;
}

export interface RevealSlideChangedEvent {
  currentSlide: Element;
  previousSlide?: Element;
  indexh: number;
  indexv: number;
}

export interface RevealPlugin {
  id: string;
  init: (deck: RevealDeck) => void | Promise<void>;
  destroy?: () => void;
}

export function computeBackoffDelayMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  if (attempt <= 0) return baseMs;
  const exponent = Math.min(attempt, 10);
  const delay = baseMs * 2 ** exponent;
  return Math.min(delay, maxMs);
}

export function buildSessionWebSocketUrl(
  endpoint: string,
  sessionId: string,
  presenterToken?: string,
): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  const baseUrl = `${wsBase}/api/v1/sessions/${encodeURIComponent(sessionId)}/ws`;
  if (presenterToken) {
    return `${baseUrl}?token=${encodeURIComponent(presenterToken)}`;
  }
  return baseUrl;
}

export function extractSlideMetadata(
  section: Element,
  defaultIndexH = 0,
  defaultIndexV = 0,
): SlideMetadataExtract {
  const dataId = section.getAttribute('data-slide-id');
  const id =
    dataId && dataId.trim() !== '' ? dataId.trim() : `slide-${defaultIndexH}-${defaultIndexV}`;

  const dataTitle = section.getAttribute('data-title');
  let title = dataTitle && dataTitle.trim() !== '' ? dataTitle.trim() : '';

  if (!title) {
    const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
    title = heading?.textContent?.trim() || `Slide ${defaultIndexH + 1}`;
  }

  return {
    id,
    title,
    horizontalIndex: defaultIndexH,
    verticalIndex: defaultIndexV,
  };
}

export class QaSlideController {
  private viewMode: 'list' | 'detail' = 'list';
  private selectedQuestion: AudienceQuestion | null = null;
  private scrollPosition = 0;
  private questions: AudienceQuestion[] = [];
  private containerElement: HTMLElement | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly endpoint: string,
  ) {}

  public getViewMode(): 'list' | 'detail' {
    return this.viewMode;
  }

  public getSelectedQuestion(): AudienceQuestion | null {
    return this.selectedQuestion;
  }

  public setQuestions(questions: AudienceQuestion[]): void {
    this.questions = questions;
    this.render();
  }

  public selectQuestion(questionId: string): void {
    const question = this.questions.find((q) => q.id === questionId);
    if (!question) return;

    if (this.containerElement) {
      this.scrollPosition = this.containerElement.scrollTop;
    }
    this.selectedQuestion = question;
    this.viewMode = 'detail';
    this.render();
  }

  public backToList(): void {
    this.viewMode = 'list';
    this.selectedQuestion = null;
    this.render();
    if (this.containerElement) {
      this.containerElement.scrollTop = this.scrollPosition;
    }
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    if (this.viewMode === 'detail' && (event.key === 'Escape' || event.key === 'Esc')) {
      event.preventDefault?.();
      event.stopPropagation?.();
      this.backToList();
      return true;
    }
    return false;
  }

  public mount(container: HTMLElement): void {
    this.containerElement = container;
    this.render();
  }

  public render(): void {
    if (!this.containerElement || typeof document === 'undefined') return;

    this.containerElement.innerHTML = '';
    this.containerElement.setAttribute('data-qa-mode', this.viewMode);

    if (this.viewMode === 'list') {
      const listWrapper = document.createElement('div');
      listWrapper.className = 'qa-list-view';

      const header = document.createElement('h2');
      header.textContent = 'Audience Q&A';
      listWrapper.appendChild(header);

      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'qa-question-items';

      if (this.questions.length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'qa-empty-msg';
        emptyMsg.textContent = 'No audience questions yet.';
        itemsContainer.appendChild(emptyMsg);
      } else {
        const sorted = [...this.questions].sort((a, b) => b.upvotes - a.upvotes);
        for (const q of sorted) {
          const item = document.createElement('div');
          item.className = 'qa-question-card';
          item.setAttribute('data-question-id', q.id);

          const upvotesBadge = document.createElement('span');
          upvotesBadge.className = 'qa-votes-badge';
          upvotesBadge.textContent = `▲ ${q.upvotes}`;

          const content = document.createElement('p');
          content.className = 'qa-question-text';
          content.textContent = q.content;

          item.appendChild(upvotesBadge);
          item.appendChild(content);

          item.addEventListener('click', () => {
            this.selectQuestion(q.id);
          });

          itemsContainer.appendChild(item);
        }
      }

      listWrapper.appendChild(itemsContainer);
      this.containerElement.appendChild(listWrapper);
    } else if (this.viewMode === 'detail' && this.selectedQuestion) {
      const detailWrapper = document.createElement('div');
      detailWrapper.className = 'qa-detail-view';

      const backBtn = document.createElement('button');
      backBtn.className = 'qa-back-btn';
      backBtn.type = 'button';
      backBtn.textContent = '← Back to Questions (Esc)';
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.backToList();
      });
      detailWrapper.appendChild(backBtn);

      const questionBox = document.createElement('div');
      questionBox.className = 'qa-detail-question-box';

      const votes = document.createElement('span');
      votes.className = 'qa-votes-badge';
      votes.textContent = `▲ ${this.selectedQuestion.upvotes} upvotes`;

      const text = document.createElement('h3');
      text.className = 'qa-detail-question-text';
      text.textContent = this.selectedQuestion.content;

      questionBox.appendChild(votes);
      questionBox.appendChild(text);
      detailWrapper.appendChild(questionBox);

      const slidePreviewContainer = document.createElement('div');
      slidePreviewContainer.className = 'qa-slide-preview-container';

      const img = document.createElement('img');
      img.className = 'qa-slide-preview-image';
      img.alt = `Slide ${this.selectedQuestion.slideId}`;
      img.src = `${this.endpoint}/api/v1/sessions/${this.sessionId}/slides/${this.selectedQuestion.slideId}/download`;

      const fallback = document.createElement('div');
      fallback.className = 'qa-slide-fallback';
      fallback.style.display = 'none';
      fallback.textContent = 'Slide preview unavailable';

      img.addEventListener('error', () => {
        img.style.display = 'none';
        fallback.style.display = 'block';
      });

      slidePreviewContainer.appendChild(img);
      slidePreviewContainer.appendChild(fallback);
      detailWrapper.appendChild(slidePreviewContainer);

      this.containerElement.appendChild(detailWrapper);
    }
  }
}

export class RevealAudiencePlugin implements RevealPlugin {
  public readonly id = 'audience';
  private deck: RevealDeck | null = null;
  private config: RevealAudienceConfig | null = null;
  private qaController: QaSlideController | null = null;
  private currentMetadata: SlideMetadataExtract | null = null;
  private pendingSlideUpdate: { slideId: string; indexh: number; indexv: number } | null = null;
  private retryAttempt = 0;
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocketLike | null = null;
  private wsRetryAttempt = 0;
  private wsRetryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private isReconciling = false;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;
  private readyListener: ((rawEvent: unknown) => void) | null = null;
  private slideChangedListener: ((rawEvent: unknown) => void) | null = null;

  constructor(presetConfig?: RevealAudienceConfig) {
    if (presetConfig) {
      this.config = presetConfig;
    }
  }

  public async init(deck: RevealDeck): Promise<void> {
    this.destroyed = false;
    this.deck = deck;
    const configFromDeck = deck.getConfig().audience;
    if (configFromDeck) {
      this.config = { ...configFromDeck, ...this.config };
    }

    if (!this.config?.sessionId || !this.config.endpoint) {
      return;
    }

    const { sessionId, endpoint } = this.config;
    this.qaController = new QaSlideController(sessionId, endpoint);

    if (typeof window !== 'undefined') {
      this.keydownListener = (event: KeyboardEvent) => {
        if (this.qaController?.handleKeyDown(event)) {
          // Prevent Reveal from navigating away when closing Q&A detail view
          event.stopPropagation();
        }
      };
      window.addEventListener('keydown', this.keydownListener, true);
    }

    this.connectWebSocket();

    this.readyListener = (rawEvent: unknown) => {
      const event = (rawEvent ?? {}) as Partial<RevealSlideChangedEvent>;
      const slide = event.currentSlide ?? deck.getCurrentSlide?.() ?? null;
      const indices = deck.getIndices?.() ?? { h: 0, v: 0 };
      if (slide) {
        this.handleSlideChange({
          currentSlide: slide,
          indexh: typeof event.indexh === 'number' ? event.indexh : indices.h,
          indexv: typeof event.indexv === 'number' ? event.indexv : indices.v,
        });
      }
    };

    this.slideChangedListener = (rawEvent: unknown) => {
      const event = rawEvent as RevealSlideChangedEvent;
      this.handleSlideChange(event);
    };

    deck.on('ready', this.readyListener);
    deck.on('slidechanged', this.slideChangedListener);

    const currentSlide = deck.getCurrentSlide?.();
    const indices = deck.getIndices?.() ?? { h: 0, v: 0 };
    if (currentSlide) {
      this.handleSlideChange({
        currentSlide,
        indexh: indices.h,
        indexv: indices.v,
      });
    }
  }

  public getQaController(): QaSlideController | null {
    return this.qaController;
  }

  public getCurrentSlideMetadata(): SlideMetadataExtract | null {
    return this.currentMetadata;
  }

  public getPendingUpdate(): { slideId: string; indexh: number; indexv: number } | null {
    return this.pendingSlideUpdate;
  }

  public getWebSocket(): WebSocketLike | null {
    return this.ws;
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.deck?.off) {
      if (this.readyListener) {
        this.deck.off('ready', this.readyListener);
      }
      if (this.slideChangedListener) {
        this.deck.off('slidechanged', this.slideChangedListener);
      }
    }
    this.readyListener = null;
    this.slideChangedListener = null;

    if (this.keydownListener && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.keydownListener, true);
      this.keydownListener = null;
    }
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
    if (this.wsRetryTimeoutId !== null) {
      clearTimeout(this.wsRetryTimeoutId);
      this.wsRetryTimeoutId = null;
    }
    if (this.ws) {
      try {
        this.ws.close?.();
      } catch {
        // Ignore WebSocket close errors
      }
      this.ws = null;
    }
  }

  private connectWebSocket(): void {
    if (this.destroyed || !this.config) return;

    const factory =
      this.config.webSocketFactory ??
      (typeof WebSocket !== 'undefined'
        ? (url: string) => new WebSocket(url) as unknown as WebSocketLike
        : null);

    if (!factory) return;

    const wsUrl = buildSessionWebSocketUrl(
      this.config.endpoint,
      this.config.sessionId,
      this.config.presenterToken,
    );

    try {
      const socket = factory(wsUrl);
      this.ws = socket;

      const onOpen = () => {
        this.wsRetryAttempt = 0;
        if (this.wsRetryTimeoutId !== null) {
          clearTimeout(this.wsRetryTimeoutId);
          this.wsRetryTimeoutId = null;
        }
        if (this.pendingSlideUpdate && this.config?.presenterToken) {
          this.sendWebSocketSlideChange(
            this.pendingSlideUpdate.slideId,
            this.pendingSlideUpdate.indexh,
            this.pendingSlideUpdate.indexv,
          );
        }
      };

      const onMessage = (rawEvent: unknown) => {
        const data =
          typeof rawEvent === 'string' ? rawEvent : (rawEvent as { data?: unknown })?.data;
        if (typeof data === 'string') {
          this.handleIncomingWebSocketMessage(data);
        }
      };

      const onDisconnect = () => {
        if (!this.destroyed) {
          this.scheduleWebSocketReconnect();
        }
      };

      if (socket.addEventListener) {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('close', onDisconnect);
        socket.addEventListener('error', onDisconnect);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onclose = onDisconnect;
        socket.onerror = onDisconnect;
      }
    } catch {
      // Never block local Reveal navigation if WebSocket construction fails
      this.scheduleWebSocketReconnect();
    }
  }

  private scheduleWebSocketReconnect(): void {
    if (this.destroyed || !this.config) return;

    this.wsRetryAttempt += 1;
    const delay = computeBackoffDelayMs(
      this.wsRetryAttempt,
      this.config.reconnectBaseMs,
      this.config.reconnectMaxMs,
    );

    if (this.wsRetryTimeoutId !== null) {
      clearTimeout(this.wsRetryTimeoutId);
    }

    this.wsRetryTimeoutId = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  private handleIncomingWebSocketMessage(rawData: string): void {
    try {
      const parsed = JSON.parse(rawData) as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (!parsed || typeof parsed !== 'object' || !parsed.payload) return;

      if (parsed.type === 'slide.changed') {
        const slideId =
          typeof parsed.payload.slideId === 'string' ? parsed.payload.slideId : undefined;
        const h =
          typeof parsed.payload.horizontalIndex === 'number'
            ? parsed.payload.horizontalIndex
            : undefined;
        const v =
          typeof parsed.payload.verticalIndex === 'number'
            ? parsed.payload.verticalIndex
            : undefined;
        this.reconcileSlidePosition(slideId, h, v);
      } else if (parsed.type === 'session.state') {
        const slideId =
          typeof parsed.payload.currentSlideId === 'string'
            ? parsed.payload.currentSlideId
            : undefined;
        this.reconcileSlidePosition(slideId, undefined, undefined);
      }
    } catch {
      // Ignore malformed WebSocket frames
    }
  }

  private reconcileSlidePosition(targetSlideId?: string, targetH?: number, targetV?: number): void {
    if (!this.deck?.slide) return;

    let resolvedH = targetH;
    let resolvedV = targetV;

    if ((resolvedH === undefined || resolvedV === undefined) && targetSlideId) {
      const slides = this.deck.getSlides?.() ?? [];
      for (let i = 0; i < slides.length; i++) {
        const el = slides[i];
        if (!el) continue;
        const attrH = Number(el.getAttribute('data-index-h') ?? i);
        const attrV = Number(el.getAttribute('data-index-v') ?? 0);
        const coords = this.deck.getIndices?.(el) ?? {
          h: Number.isNaN(attrH) ? i : attrH,
          v: Number.isNaN(attrV) ? 0 : attrV,
        };
        const meta = extractSlideMetadata(el, coords.h, coords.v);
        if (meta.id === targetSlideId) {
          resolvedH = coords.h;
          resolvedV = coords.v;
          break;
        }
      }
    }

    if (resolvedH === undefined) return;
    const finalV = resolvedV ?? 0;

    const currentIndices = this.deck.getIndices?.();
    const isSameCoords =
      currentIndices !== undefined && currentIndices.h === resolvedH && currentIndices.v === finalV;
    const isSameSlideId =
      targetSlideId !== undefined &&
      this.currentMetadata !== null &&
      this.currentMetadata.id === targetSlideId;

    if (isSameCoords || isSameSlideId) {
      return;
    }

    this.isReconciling = true;
    try {
      this.deck.slide(resolvedH, finalV);
    } finally {
      this.isReconciling = false;
    }
  }

  private sendWebSocketSlideChange(slideId: string, indexh: number, indexv: number): boolean {
    if (!this.ws || !this.config?.presenterToken) return false;
    // WebSocket.OPEN is 1; allow undefined for lightweight test mocks
    if (this.ws.readyState !== undefined && this.ws.readyState !== 1) {
      return false;
    }

    const payload: SlideChangedDispatchPayload = {
      slideId,
      horizontalIndex: indexh,
      verticalIndex: indexv,
      timestamp: new Date().toISOString(),
    };

    try {
      this.ws.send(
        JSON.stringify({
          id: `evt-nav-${Date.now()}`,
          type: 'slide.changed',
          sessionId: this.config.sessionId,
          timestamp: payload.timestamp,
          token: this.config.presenterToken,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private handleSlideChange(event: RevealSlideChangedEvent): void {
    const { currentSlide, indexh, indexv } = event;
    const metadata = extractSlideMetadata(currentSlide, indexh, indexv);
    this.currentMetadata = metadata;

    const isQa =
      currentSlide.getAttribute('data-component') === 'audience-qa' ||
      currentSlide.querySelector('[data-component="audience-qa"]') !== null;

    if (isQa && this.qaController) {
      const target =
        currentSlide.getAttribute('data-component') === 'audience-qa'
          ? (currentSlide as HTMLElement)
          : (currentSlide.querySelector('[data-component="audience-qa"]') as HTMLElement);
      if (target) {
        this.qaController.mount(target);
      }
    }

    if (!this.isReconciling && this.config?.presenterToken) {
      this.sendWebSocketSlideChange(metadata.id, indexh, indexv);
      void this.dispatchSlideChange(metadata.id, indexh, indexv);
    }
  }

  private async dispatchSlideChange(
    slideId: string,
    indexh: number,
    indexv: number,
  ): Promise<void> {
    if (!this.config || !this.config.presenterToken) return;

    this.pendingSlideUpdate = { slideId, indexh, indexv };
    const fetchImplementation =
      this.config.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImplementation) return;

    const timestamp = new Date().toISOString();

    try {
      const response = await fetchImplementation(
        `${this.config.endpoint}/api/v1/sessions/${this.config.sessionId}/slide`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.presenterToken}`,
            'x-presenter-token': this.config.presenterToken,
          },
          body: JSON.stringify({
            slideId,
            indexh,
            indexv,
            horizontalIndex: indexh,
            verticalIndex: indexv,
            timestamp,
          }),
        },
      );

      if (response.ok) {
        this.pendingSlideUpdate = null;
        this.retryAttempt = 0;
        if (this.retryTimeoutId !== null) {
          clearTimeout(this.retryTimeoutId);
          this.retryTimeoutId = null;
        }
      } else {
        this.scheduleRetry();
      }
    } catch {
      // Resilient offline mode: do NOT throw or block Reveal navigation
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (!this.pendingSlideUpdate || !this.config) return;

    this.retryAttempt += 1;
    const delay = computeBackoffDelayMs(
      this.retryAttempt,
      this.config.reconnectBaseMs,
      this.config.reconnectMaxMs,
    );

    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId);
    }

    this.retryTimeoutId = setTimeout(() => {
      if (this.pendingSlideUpdate) {
        void this.dispatchSlideChange(
          this.pendingSlideUpdate.slideId,
          this.pendingSlideUpdate.indexh,
          this.pendingSlideUpdate.indexv,
        );
      }
    }, delay);
  }
}

export type RevealAudienceFactory = {
  (config?: RevealAudienceConfig): RevealPlugin;
  id: string;
  init: (deck: RevealDeck) => Promise<void>;
};

const defaultPluginInstance = new RevealAudiencePlugin();

export const RevealAudience: RevealAudienceFactory = Object.assign(
  (config?: RevealAudienceConfig): RevealPlugin => {
    return new RevealAudiencePlugin(config);
  },
  {
    id: defaultPluginInstance.id,
    init: (deck: RevealDeck) => defaultPluginInstance.init(deck),
  },
);
