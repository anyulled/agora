import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PollSlideController,
  QaSlideController,
  RevealAudience,
  RevealAudiencePlugin,
  type RevealDeck,
  type RevealSlideChangedEvent,
  computeBackoffDelayMs,
  extractSlideMetadata,
} from '../index';

class MockElement {
  public tagName: string;
  public attributes: Record<string, string> = {};
  public children: MockElement[] = [];
  public textContent = '';
  public className = '';
  public style: Record<string, string> = {};
  public alt = '';
  public src = '';
  public type = '';
  public scrollTop = 0;
  public listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public appendChild(child: MockElement): MockElement {
    this.children.push(child);
    return child;
  }

  public get firstChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  public removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
    }
    return child;
  }

  public addEventListener(event: string, fn: (e: unknown) => void): void {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event]?.push(fn);
  }

  public querySelector(selector: string): MockElement | null {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.findChild((el) => el.className.split(' ').includes(cls));
    }
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const [attr, val] = selector.slice(1, -1).split('=');
      const cleanVal = val ? val.replace(/['"]/g, '') : null;
      return this.findChild((el) => {
        const v = el.getAttribute(attr ?? '');
        return cleanVal ? v === cleanVal : v !== null;
      });
    }
    const tags = selector.split(',').map((s) => s.trim().toUpperCase());
    return this.findChild((el) => tags.includes(el.tagName));
  }

  public querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    this.collectChildren(selector, results);
    return results;
  }

  private findChild(predicate: (el: MockElement) => boolean): MockElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.findChild(predicate);
      if (found) return found;
    }
    return null;
  }

  private collectChildren(selector: string, results: MockElement[]): void {
    for (const child of this.children) {
      if (child.tagName === selector.toUpperCase() || child.className.includes(selector.slice(1))) {
        results.push(child);
      }
      child.collectChildren(selector, results);
    }
  }

  public trigger(event: string, payload?: unknown): void {
    const list = this.listeners[event] ?? [];
    for (const fn of list) {
      fn(payload);
    }
  }

  public set innerHTML(val: string) {
    if (val === '') {
      this.children = [];
    }
  }
}

class MockKeyboardEvent {
  public defaultPrevented = false;
  public propagationStopped = false;

  constructor(
    public type: string,
    public init: { key: string; cancelable?: boolean },
  ) {}

  public get key(): string {
    return this.init.key;
  }

  public preventDefault(): void {
    this.defaultPrevented = true;
  }

  public stopPropagation(): void {
    this.propagationStopped = true;
  }
}

function setupMockDom() {
  const windowListeners: Record<string, ((event: unknown) => void)[]> = {};

  const mockDoc = {
    createElement: (tag: string) => new MockElement(tag),
  };

  const mockWin = {
    addEventListener: (event: string, fn: (e: unknown) => void) => {
      windowListeners[event] = windowListeners[event] || [];
      windowListeners[event]?.push(fn);
    },
    removeEventListener: (event: string, fn: (e: unknown) => void) => {
      if (windowListeners[event]) {
        windowListeners[event] = windowListeners[event]?.filter((f) => f !== fn) ?? [];
      }
    },
    dispatchEvent: (event: unknown) => {
      const type = (event as { type: string }).type;
      for (const fn of windowListeners[type] ?? []) {
        fn(event);
      }
    },
  };

  (globalThis as unknown as { document: typeof mockDoc }).document = mockDoc;
  (globalThis as unknown as { window: typeof mockWin }).window = mockWin;
  (globalThis as unknown as { KeyboardEvent: typeof MockKeyboardEvent }).KeyboardEvent =
    MockKeyboardEvent;

  return {
    cleanup: () => {
      (globalThis as { document?: unknown }).document = undefined;
      (globalThis as { window?: unknown }).window = undefined;
      (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = undefined;
    },
  };
}

describe('computeBackoffDelayMs', () => {
  it('computes exponential backoff with a cap', () => {
    expect(computeBackoffDelayMs(0, 1000, 30000)).toBe(1000);
    expect(computeBackoffDelayMs(1, 1000, 30000)).toBe(2000);
    expect(computeBackoffDelayMs(2, 1000, 30000)).toBe(4000);
    expect(computeBackoffDelayMs(3, 1000, 30000)).toBe(8000);
    expect(computeBackoffDelayMs(10, 1000, 30000)).toBe(30000);
    expect(computeBackoffDelayMs(20, 1000, 30000)).toBe(30000);
  });
});

describe('extractSlideMetadata', () => {
  let domCleanup: () => void;

  beforeEach(() => {
    const { cleanup } = setupMockDom();
    domCleanup = cleanup;
  });

  afterEach(() => {
    domCleanup?.();
  });

  it('extracts data-slide-id and data-title if present', () => {
    const el = document.createElement('section');
    el.setAttribute('data-slide-id', 'slide-architecture');
    el.setAttribute('data-title', 'Architecture Deep Dive');

    const meta = extractSlideMetadata(el as unknown as Element, 0, 0);
    expect(meta.id).toBe('slide-architecture');
    expect(meta.title).toBe('Architecture Deep Dive');
    expect(meta.horizontalIndex).toBe(0);
    expect(meta.verticalIndex).toBe(0);
  });

  it('falls back to heading text or default index naming', () => {
    const el = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = 'Foundations';
    el.appendChild(h2);

    const meta = extractSlideMetadata(el as unknown as Element, 2, 1);
    expect(meta.id).toBe('slide-2-1');
    expect(meta.title).toBe('Foundations');
    expect(meta.horizontalIndex).toBe(2);
    expect(meta.verticalIndex).toBe(1);
  });
});

describe('RevealAudience Plugin', () => {
  let mockDeck: RevealDeck;
  let listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let domCleanup: () => void;

  beforeEach(() => {
    const { cleanup } = setupMockDom();
    domCleanup = cleanup;
    listeners = {};
    mockDeck = {
      getConfig: () => ({
        audience: {
          sessionId: 'session-123',
          endpoint: 'https://api.agora.test',
          presenterToken: 'secret-token',
        },
      }),
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event]?.push(fn);
      },
      slide: vi.fn(),
    };
  });

  afterEach(() => {
    domCleanup?.();
  });

  it('initializes via factory or object and registers listeners', async () => {
    expect(RevealAudience.id).toBe('audience');
    const created = RevealAudience({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
    });
    expect(created.id).toBe('audience');

    const plugin = new RevealAudiencePlugin();
    await plugin.init(mockDeck);

    expect(listeners.slidechanged).toBeDefined();
    expect(listeners.slidechanged?.length).toBe(1);
    plugin.destroy();
  });

  it('sends slide update when presenterToken is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const plugin = new RevealAudiencePlugin({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
      presenterToken: 'secret-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await plugin.init(mockDeck);

    const section = document.createElement('section');
    section.setAttribute('data-slide-id', 'intro-slide');
    section.setAttribute('data-title', 'Introduction');

    const event: RevealSlideChangedEvent = {
      currentSlide: section as unknown as Element,
      indexh: 0,
      indexv: 0,
    };

    listeners.slidechanged?.[0]?.(event);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.agora.test/api/v1/sessions/session-123/slide',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        }),
      );
    });

    plugin.destroy();
  });

  it('does NOT send slide update when presenterToken is omitted', async () => {
    const fetchMock = vi.fn();
    const plugin = new RevealAudiencePlugin({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    mockDeck.getConfig = () => ({
      audience: {
        sessionId: 'session-123',
        endpoint: 'https://api.agora.test',
      },
    });

    await plugin.init(mockDeck);

    const section = document.createElement('section');
    section.setAttribute('data-slide-id', 'intro-slide');

    listeners.slidechanged?.[0]?.({
      currentSlide: section as unknown as Element,
      indexh: 0,
      indexv: 0,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    plugin.destroy();
  });

  it('resilient offline mode: does NOT throw when fetch throws, buffers state', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network offline'));
    const plugin = new RevealAudiencePlugin({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
      presenterToken: 'secret-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await plugin.init(mockDeck);

    const section = document.createElement('section');
    section.setAttribute('data-slide-id', 'offline-slide');

    // Should not throw
    expect(() => {
      listeners.slidechanged?.[0]?.({
        currentSlide: section as unknown as Element,
        indexh: 1,
        indexv: 0,
      });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(plugin.getPendingUpdate()).toEqual({
      slideId: 'offline-slide',
      indexh: 1,
      indexv: 0,
    });

    plugin.destroy();
  });

  it('registers both ready and slidechanged listeners, handles 2D vertical slides, and keeps keyboard navigation unblocked offline (SPEC-003a)', async () => {
    const offMock = vi.fn();
    mockDeck.off = offMock;

    const fetchMock = vi.fn().mockRejectedValue(new Error('Offline'));
    const plugin = new RevealAudiencePlugin({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
      presenterToken: 'secret-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await plugin.init(mockDeck);

    expect(listeners.ready?.length).toBe(1);
    expect(listeners.slidechanged?.length).toBe(1);

    // Trigger ready event on a 2D nested vertical slide (h=2, v=3)
    const verticalSlide = document.createElement('section');
    verticalSlide.setAttribute('data-slide-id', 'slide-matrix-2-3');
    verticalSlide.setAttribute('data-title', 'Vertical Sub-Slide');

    listeners.ready?.[0]?.({
      currentSlide: verticalSlide as unknown as Element,
      indexh: 2,
      indexv: 3,
    });

    expect(plugin.getCurrentSlideMetadata()).toEqual({
      id: 'slide-matrix-2-3',
      title: 'Vertical Sub-Slide',
      horizontalIndex: 2,
      verticalIndex: 3,
    });

    // Verify all standard Reveal keyboard navigation keys remain completely unblocked offline
    for (const key of [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      ' ',
      'PageUp',
      'PageDown',
    ]) {
      const navKeyEvt = new MockKeyboardEvent('keydown', { key, cancelable: true });
      window.dispatchEvent(navKeyEvt as unknown as Event);
      expect(navKeyEvt.defaultPrevented).toBe(false);
      expect(navKeyEvt.propagationStopped).toBe(false);
    }

    plugin.destroy();
    expect(offMock).toHaveBeenCalledWith('ready', expect.any(Function));
    expect(offMock).toHaveBeenCalledWith('slidechanged', expect.any(Function));
  });

  it('establishes authenticated WebSocket, dispatches slide.changed, reconciles out-of-sync position, and auto-reconnects (SPEC-003b)', async () => {
    vi.useFakeTimers();
    try {
      const sentFrames: string[] = [];
      const wsListeners: Record<string, ((event: unknown) => void)[]> = {};
      const connectedUrls: string[] = [];

      const createMockWs = (url: string) => {
        connectedUrls.push(url);
        return {
          readyState: 1,
          send: (data: string) => sentFrames.push(data),
          close: vi.fn(),
          addEventListener: (type: string, fn: (event: unknown) => void) => {
            wsListeners[type] = wsListeners[type] || [];
            wsListeners[type]?.push(fn);
          },
        };
      };

      const slide0 = document.createElement('section');
      slide0.setAttribute('data-slide-id', 'slide-intro');
      slide0.setAttribute('data-index-h', '0');
      slide0.setAttribute('data-index-v', '0');

      const slide2 = document.createElement('section');
      slide2.setAttribute('data-slide-id', 'slide-deep-dive');
      slide2.setAttribute('data-index-h', '2');
      slide2.setAttribute('data-index-v', '1');

      mockDeck.getSlides = () => [slide0 as unknown as Element, slide2 as unknown as Element];
      mockDeck.getIndices = (el?: Element) => {
        if (el === (slide2 as unknown as Element)) return { h: 2, v: 1 };
        return { h: 0, v: 0 };
      };

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

      const plugin = new RevealAudiencePlugin({
        sessionId: 'session-123',
        endpoint: 'https://api.agora.test',
        presenterToken: 'secret-token',
        reconnectBaseMs: 50,
        reconnectMaxMs: 200,
        fetchFn: fetchMock as unknown as typeof fetch,
        webSocketFactory: createMockWs,
      });

      await plugin.init(mockDeck);

      expect(connectedUrls[0]).toBe(
        'wss://api.agora.test/api/v1/sessions/session-123/ws?token=secret-token',
      );

      // Presenter navigates to (1, 2) -> dispatches slide.changed over WebSocket
      const navSection = document.createElement('section');
      navSection.setAttribute('data-slide-id', 'slide-1-2');
      listeners.slidechanged?.[0]?.({
        currentSlide: navSection as unknown as Element,
        indexh: 1,
        indexv: 2,
      });

      expect(sentFrames.length).toBe(1);
      const dispatched = JSON.parse(sentFrames[0]!);
      expect(dispatched.type).toBe('slide.changed');
      expect(dispatched.token).toBe('secret-token');
      expect(dispatched.payload).toMatchObject({
        slideId: 'slide-1-2',
        horizontalIndex: 1,
        verticalIndex: 2,
      });
      expect(typeof dispatched.payload.timestamp).toBe('string');

      // Receive authoritative session.state sync message pointing to slide-deep-dive (2, 1)
      wsListeners.message?.[0]?.({
        data: JSON.stringify({
          type: 'session.state',
          sessionId: 'session-123',
          payload: {
            id: 'session-123',
            currentSlideId: 'slide-deep-dive',
          },
        }),
      });

      expect(mockDeck.slide).toHaveBeenCalledWith(2, 1);

      // Simulate WebSocket disconnect -> triggers auto-reconnect without disrupting presenter
      wsListeners.close?.[0]?.({});
      vi.advanceTimersByTime(150);
      expect(connectedUrls.length).toBe(2);

      plugin.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QaSlideController and Q&A transitions', () => {
  let domCleanup: () => void;

  beforeEach(() => {
    const { cleanup } = setupMockDom();
    domCleanup = cleanup;
  });

  afterEach(() => {
    domCleanup?.();
  });

  it('manages list view vs detail view and Escape key returns to list without slide change', () => {
    const qa = new QaSlideController('session-123', 'https://api.agora.test');
    const container = document.createElement('div');
    qa.mount(container as unknown as HTMLElement);

    qa.setQuestions([
      {
        id: 'q1',
        sessionId: 'session-123',
        slideId: 'slide-1',
        participantId: 'p1',
        content: 'How does Durable Object SQLite scale?',
        status: 'pending',
        upvotes: 42,
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(qa.getViewMode()).toBe('list');
    expect(container.querySelector('.qa-question-card')).not.toBeNull();

    // Select question -> transitions to detail view
    qa.selectQuestion('q1');
    expect(qa.getViewMode()).toBe('detail');
    expect(qa.getSelectedQuestion()?.id).toBe('q1');
    expect(container.querySelector('.qa-detail-view')).not.toBeNull();

    // Escape key press returns to list view without navigating Reveal.js
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    const handled = qa.handleKeyDown(escEvent);
    expect(handled).toBe(true);
    expect(escEvent.defaultPrevented).toBe(true);
    expect(qa.getViewMode()).toBe('list');
    expect(qa.getSelectedQuestion()).toBeNull();
  });

  it('renders ranked question list view with vote badges, submitter names, slide titles, and status badges (SPEC-008a)', () => {
    const qa = new QaSlideController('session-123', 'https://api.agora.test', {
      slideTitles: {
        'slide-arch': 'System Architecture',
        'slide-db': 'SQLite Durability',
      },
    });
    const container = document.createElement('div');
    qa.mount(container as unknown as HTMLElement);

    qa.setQuestions([
      {
        id: 'q1',
        sessionId: 'session-123',
        slideId: 'slide-arch',
        participantId: 'p1',
        participantName: 'Alice',
        content: 'Why D1 over traditional PostgreSQL?',
        status: 'pending',
        upvotes: 10,
        createdAt: '2026-10-19T10:00:00.000Z',
      },
      {
        id: 'q2',
        sessionId: 'session-123',
        slideId: 'slide-db',
        participantId: 'p2',
        // Omitted participantName to verify "Anonymous" fallback
        content: 'What is the R2 cache invalidation latency?',
        status: 'answered',
        upvotes: 25,
        createdAt: '2026-10-19T10:01:00.000Z',
      },
    ]);

    const cards = container.querySelectorAll('.qa-question-card');
    expect(cards.length).toBe(2);

    // Highest votes (q2 with 25 upvotes) ranks first
    const firstCard = cards[0]!;
    expect(firstCard.getAttribute('data-question-id')).toBe('q2');
    expect(firstCard.querySelector('.qa-votes-badge')?.textContent).toBe('▲ 25');
    expect(firstCard.querySelector('.qa-status-badge')?.textContent).toBe('answered');
    expect(firstCard.querySelector('.qa-referenced-slide')?.textContent).toBe('SQLite Durability');
    expect(firstCard.querySelector('.qa-submitter-name')?.textContent).toBe('Anonymous');

    // Second card (q1 with 10 upvotes)
    const secondCard = cards[1]!;
    expect(secondCard.getAttribute('data-question-id')).toBe('q1');
    expect(secondCard.querySelector('.qa-votes-badge')?.textContent).toBe('▲ 10');
    expect(secondCard.querySelector('.qa-status-badge')?.textContent).toBe('pending');
    expect(secondCard.querySelector('.qa-referenced-slide')?.textContent).toBe(
      'System Architecture',
    );
    expect(secondCard.querySelector('.qa-submitter-name')?.textContent).toBe('Alice');
  });

  it('updates dynamically on real-time events without jumping scroll position (SPEC-008a)', () => {
    const qa = new QaSlideController('session-123', 'https://api.agora.test');
    const container = document.createElement('div');
    qa.mount(container as unknown as HTMLElement);

    qa.setQuestions([
      {
        id: 'q1',
        sessionId: 'session-123',
        slideId: 'slide-1',
        participantId: 'p1',
        content: 'Initial question',
        status: 'pending',
        upvotes: 5,
        createdAt: '2026-10-19T10:00:00.000Z',
      },
    ]);

    // Simulate user scroll position on conference projector/presenter screen
    container.scrollTop = 240;

    // 1. Live new question submitted
    qa.handleRealtimeEvent('question.submitted', {
      id: 'q2',
      sessionId: 'session-123',
      slideId: 'slide-2',
      participantId: 'p2',
      participantName: 'Bob',
      content: 'Real-time submitted question',
      status: 'pending',
      upvotes: 1,
      createdAt: '2026-10-19T10:05:00.000Z',
    });

    expect(qa.getQuestions().length).toBe(2);
    // Invariant: scroll position preserved without jumping to top
    expect(container.scrollTop).toBe(240);

    // 2. Live upvote received: q2 gets 20 upvotes -> ranks top
    qa.handleRealtimeEvent('question.upvoted', {
      questionId: 'q2',
      voteCount: 20,
      upvotes: 20,
    });

    expect(
      container.querySelectorAll('.qa-question-card')[0]?.getAttribute('data-question-id'),
    ).toBe('q2');
    expect(container.scrollTop).toBe(240);

    // 3. Live question updated: q1 answered
    qa.handleRealtimeEvent('question.updated', {
      id: 'q1',
      sessionId: 'session-123',
      slideId: 'slide-1',
      participantId: 'p1',
      content: 'Initial question',
      status: 'answered',
      upvotes: 5,
      createdAt: '2026-10-19T10:00:00.000Z',
    });

    const q1Card = container.querySelectorAll('.qa-question-card')[1]!;
    expect(q1Card.querySelector('.qa-status-badge')?.textContent).toBe('answered');
    expect(container.scrollTop).toBe(240);
  });

  it('renders question detail view with slide snapshot fallback and keyboard/Esc return handling (SPEC-008b)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const qa = new QaSlideController('session-123', 'https://api.agora.test', {
      presenterToken: 'pres-token-xyz',
      fetchFn: fetchMock as unknown as typeof fetch,
      slideTitles: { 'slide-hero': 'Hero Architecture' },
    });

    const container = document.createElement('div');
    qa.mount(container as unknown as HTMLElement);

    qa.setQuestions([
      {
        id: 'q-detail-1',
        sessionId: 'session-123',
        slideId: 'slide-hero',
        participantId: 'p-1',
        participantName: 'Charlie',
        content: 'Can you zoom in on the Durable Object SQLite boundary?',
        status: 'pending',
        upvotes: 15,
        createdAt: '2026-10-19T10:00:00.000Z',
      },
    ]);

    container.scrollTop = 150;

    // Click card to open detail view
    const card = container.querySelector('.qa-question-card') as MockElement | null;
    card?.trigger('click');

    expect(qa.getViewMode()).toBe('detail');
    expect(container.querySelector('.qa-detail-view')).not.toBeNull();

    // Verify slide snapshot URL
    const img = container.querySelector('.qa-slide-preview-image') as MockElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toBe(
      'https://api.agora.test/api/v1/sessions/session-123/slides/slide-hero/download',
    );

    const fallback = container.querySelector('.qa-slide-fallback') as MockElement | null;
    expect(fallback?.style.display).toBe('none');

    // Simulate missing slide PNG asset firing image error event -> displays graceful fallback
    img?.trigger('error');
    expect(img?.style.display).toBe('none');
    expect(fallback?.style.display).toBe('block');
    expect(fallback?.textContent).toBe('Slide preview unavailable');

    // Presenter action: mark question as answered from detail view
    const markAnsweredBtn = container.querySelector('.qa-mark-answered-btn') as MockElement | null;
    expect(markAnsweredBtn).not.toBeNull();
    expect(markAnsweredBtn?.textContent).toBe('Mark as Answered');

    markAnsweredBtn?.trigger('click');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.agora.test/api/v1/sessions/session-123/questions/q-detail-1',
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            Authorization: 'Bearer pres-token-xyz',
            'x-presenter-token': 'pres-token-xyz',
          }),
          body: JSON.stringify({ status: 'answered' }),
        }),
      );
    });

    expect(qa.getSelectedQuestion()?.status).toBe('answered');
    const updatedBtn = container.querySelector('.qa-mark-answered-btn') as MockElement | null;
    expect(updatedBtn?.textContent).toBe('Answered ✓');

    // UI Back Button returns to list view and restores saved scroll position
    const backBtn = container.querySelector('.qa-back-btn') as MockElement | null;
    expect(backBtn).not.toBeNull();
    backBtn?.trigger('click');

    expect(qa.getViewMode()).toBe('list');
    expect(container.scrollTop).toBe(150);
  });

  it('integrates embedded Q&A slide with RevealAudiencePlugin without navigating deck (SPEC-008)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/questions')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'q-init-1',
              sessionId: 'session-123',
              slideId: 'slide-intro',
              participantId: 'p-init',
              content: 'Plugin initial question',
              status: 'pending',
              upvotes: 8,
              createdAt: '2026-10-19T10:00:00.000Z',
            },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const mockDeck: RevealDeck = {
      getConfig: () => ({
        audience: {
          sessionId: 'session-123',
          endpoint: 'https://api.agora.test',
          presenterToken: 'pres-token',
        },
      }),
      on: vi.fn(),
      slide: vi.fn(),
    };

    const plugin = new RevealAudiencePlugin({
      sessionId: 'session-123',
      endpoint: 'https://api.agora.test',
      presenterToken: 'pres-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await plugin.init(mockDeck);

    // Slide marked with data-component="audience-qa"
    const qaSlideSection = document.createElement('section');
    qaSlideSection.setAttribute('data-slide-id', 'qa-slide');
    qaSlideSection.setAttribute('data-component', 'audience-qa');

    // Trigger slide change to Q&A slide
    const slideChangedListener = (mockDeck.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'slidechanged',
    )?.[1] as (e: RevealSlideChangedEvent) => void;

    expect(slideChangedListener).toBeDefined();

    slideChangedListener({
      currentSlide: qaSlideSection as unknown as Element,
      indexh: 3,
      indexv: 0,
    });

    const qaController = plugin.getQaController();
    expect(qaController).not.toBeNull();

    // Verify initial questions loaded via fetchFn
    await vi.waitFor(() => {
      expect(qaController?.getQuestions().length).toBe(1);
    });

    // Enter detail view on the Q&A slide
    qaController?.selectQuestion('q-init-1');
    expect(qaController?.getViewMode()).toBe('detail');

    // Invariant: mockDeck.slide MUST NOT be invoked when inspecting question detail
    expect(mockDeck.slide).not.toHaveBeenCalled();

    // Press Escape to return to list
    const escEvent = new MockKeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(escEvent as unknown as Event);

    expect(qaController?.getViewMode()).toBe('list');
    expect(escEvent.defaultPrevented).toBe(true);
    expect(escEvent.propagationStopped).toBe(true);

    // Deck slide coordinates still untouched
    expect(mockDeck.slide).not.toHaveBeenCalled();

    plugin.destroy();
  });

  describe('PollSlideController and contextual polls (SPEC-010)', () => {
    it('mounts on slide container and renders poll questions and options', () => {
      const container = document.createElement('div');
      container.setAttribute('data-slide-id', 'slide-poll-1');

      const controller = new PollSlideController('session-1', 'https://api.agora.test');
      controller.mount(container, 'slide-poll-1');

      controller.setPoll({
        id: 'poll-1',
        sessionId: 'session-1',
        slideId: 'slide-poll-1',
        question: 'Which deployment model fits your workload?',
        type: 'single-choice',
        options: [
          { id: 'opt-edge', label: 'Cloudflare Workers Edge', text: 'Cloudflare Workers Edge' },
          { id: 'opt-containers', label: 'Regional Containers', text: 'Regional Containers' },
        ],
        status: 'open',
        resultsRevealed: false,
      });

      expect(controller.getPollForSlide('slide-poll-1')?.id).toBe('poll-1');
      expect(container.querySelector('.poll-question-title')?.textContent).toBe(
        'Which deployment model fits your workload?',
      );
      expect(container.querySelector('.poll-status-tag')?.textContent).toBe('OPEN');
      expect(container.querySelector('.poll-type-tag')?.textContent).toBe('Single Choice');
      expect(container.querySelectorAll('.poll-projector-option-card').length).toBe(2);
    });

    it('updates results and renders progress bars upon real-time poll events', () => {
      const container = document.createElement('div');
      const controller = new PollSlideController('session-1', 'https://api.agora.test');
      controller.mount(container, 'slide-poll-2');

      // Realtime poll.opened event
      controller.handleRealtimeEvent('poll.opened', {
        id: 'poll-2',
        sessionId: 'session-1',
        slideId: 'slide-poll-2',
        question: 'Is serverless first viable for latency-critical apps?',
        type: 'binary',
        options: [
          { id: 'opt-yes', text: 'Yes' },
          { id: 'opt-no', text: 'No' },
        ],
        status: 'open',
      });

      expect(container.querySelector('.poll-type-tag')?.textContent).toBe('Binary (Yes/No)');

      // Realtime poll.voted event
      controller.handleRealtimeEvent('poll.voted', {
        pollId: 'poll-2',
        selectedOptionIds: ['opt-yes'],
        totalResponses: 1,
      });

      // Realtime poll.results event (revealing results to projector)
      controller.handleRealtimeEvent('poll.results', {
        pollId: 'poll-2',
        results: { 'opt-yes': 3, 'opt-no': 1 },
        totalVotes: 4,
        resultsRevealed: true,
      });

      const summary = controller.getPollResults('poll-2');
      expect(summary?.totalResponses).toBe(4);
      expect(summary?.countsByOptionId['opt-yes']).toBe(3);

      const statsElements = container.querySelectorAll('.poll-option-counts');
      expect(statsElements.length).toBe(2);
      expect(statsElements[0]?.textContent).toBe('3 votes (75%)');
      expect(statsElements[1]?.textContent).toBe('1 votes (25%)');

      const barFills = container.querySelectorAll('.poll-bar-fill');
      expect(barFills.length).toBe(2);
      expect((barFills[0] as HTMLElement).style.width).toBe('75%');
      expect((barFills[1] as HTMLElement).style.width).toBe('25%');

      // Realtime poll.closed event
      controller.handleRealtimeEvent('poll.closed', { pollId: 'poll-2' });
      expect(container.querySelector('.poll-status-tag')?.textContent).toBe('CLOSED');
    });

    it('mounts PollSlideController automatically on RevealAudiencePlugin slide change', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({}),
      }));

      const mockDeck: RevealDeck = {
        getConfig: () => ({
          audience: {
            sessionId: 'session-poll-deck',
            endpoint: 'https://api.agora.test',
            presenterToken: 'pres-token-poll',
          },
        }),
        on: vi.fn(),
        slide: vi.fn(),
      };

      const plugin = new RevealAudiencePlugin({
        sessionId: 'session-poll-deck',
        endpoint: 'https://api.agora.test',
        presenterToken: 'pres-token-poll',
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await plugin.init(mockDeck);

      const pollSlideSection = document.createElement('section');
      pollSlideSection.setAttribute('data-slide-id', 'slide-poll-deck');
      pollSlideSection.setAttribute('data-component', 'audience-poll');

      const slideChangedListener = (mockDeck.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === 'slidechanged',
      )?.[1] as (e: RevealSlideChangedEvent) => void;

      expect(slideChangedListener).toBeDefined();

      slideChangedListener({
        currentSlide: pollSlideSection as unknown as Element,
        indexh: 2,
        indexv: 0,
      });

      const pollCtrl = plugin.getPollController();
      expect(pollCtrl).not.toBeNull();

      plugin.destroy();
    });
  });
});
