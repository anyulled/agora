import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
});
