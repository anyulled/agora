import type { AudienceQuestion } from '@agora/contracts';

export interface RevealAudienceConfig {
  sessionId: string;
  endpoint: string;
  presenterToken?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  fetchFn?: typeof fetch;
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
  getIndices?: () => { h: number; v: number };
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
  private pendingSlideUpdate: { slideId: string; indexh: number; indexv: number } | null = null;
  private retryAttempt = 0;
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(presetConfig?: RevealAudienceConfig) {
    if (presetConfig) {
      this.config = presetConfig;
    }
  }

  public async init(deck: RevealDeck): Promise<void> {
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
          // Prevent Reveal from navigating away
          event.stopPropagation();
        }
      };
      window.addEventListener('keydown', this.keydownListener, true);
    }

    deck.on('slidechanged', (rawEvent: unknown) => {
      const event = rawEvent as RevealSlideChangedEvent;
      this.handleSlideChange(event);
    });

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

  public getPendingUpdate(): { slideId: string; indexh: number; indexv: number } | null {
    return this.pendingSlideUpdate;
  }

  public destroy(): void {
    if (this.keydownListener && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.keydownListener, true);
      this.keydownListener = null;
    }
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  }

  private handleSlideChange(event: RevealSlideChangedEvent): void {
    const { currentSlide, indexh, indexv } = event;
    const metadata = extractSlideMetadata(currentSlide, indexh, indexv);

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

    if (this.config?.presenterToken) {
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
    const fetchImplementation = this.config.fetchFn ?? fetch;

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
          body: JSON.stringify({ slideId, indexh, indexv }),
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
