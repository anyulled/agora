import { describe, expect, it, vi } from 'vitest';
import {
  BrowserDomSlideRenderer,
  type SlideExportProgress,
  type SlideRenderTask,
  buildNativePdfPrintUrl,
  validatePdfExportConfig,
} from '../index';

class MockDomFragment {
  public classList = {
    classes: new Set<string>(['fragment']),
    add(cls: string) {
      this.classes.add(cls);
    },
    contains(cls: string) {
      return this.classes.has(cls);
    },
  };
  public style: Record<string, string> = {
    opacity: '0',
    visibility: 'hidden',
  };
}

class MockDomSlide {
  public fragments: MockDomFragment[] = [new MockDomFragment(), new MockDomFragment()];
  public style: Record<string, string> = {
    width: '100px',
    height: '100px',
  };

  public querySelectorAll(selector: string) {
    if (selector === '.fragment') {
      return this.fragments;
    }
    return [];
  }
}

describe('BrowserDomSlideRenderer', () => {
  it('forces all fragments on a slide to their final visible state', async () => {
    const renderer = new BrowserDomSlideRenderer();
    const mockSlide = new MockDomSlide();

    expect(mockSlide.fragments[0]?.classList.contains('visible')).toBe(false);
    expect(mockSlide.fragments[0]?.style.opacity).toBe('0');

    renderer.forceFinalFragmentState(mockSlide as unknown as HTMLElement);

    expect(mockSlide.fragments[0]?.classList.contains('visible')).toBe(true);
    expect(mockSlide.fragments[0]?.style.opacity).toBe('1');
    expect(mockSlide.fragments[0]?.style.visibility).toBe('visible');

    expect(mockSlide.fragments[1]?.classList.contains('visible')).toBe(true);
    expect(mockSlide.fragments[1]?.style.opacity).toBe('1');
    expect(mockSlide.fragments[1]?.style.visibility).toBe('visible');
  });

  it('renders a single slide and returns png output', async () => {
    const mockBytes = new Uint8Array([1, 2, 3, 4]);
    const captureFn = vi.fn().mockResolvedValue(mockBytes);

    const renderer = new BrowserDomSlideRenderer({ captureFn, width: 1920, height: 1080 });
    const mockSlide = new MockDomSlide();

    const output = await renderer.renderSlide({
      slideId: 'slide-1',
      element: mockSlide as unknown as HTMLElement,
      order: 1,
    });

    expect(output.slideId).toBe('slide-1');
    expect(output.width).toBe(1920);
    expect(output.height).toBe(1080);
    expect(output.byteSize).toBe(4);
    expect(captureFn).toHaveBeenCalledTimes(1);
  });

  it('reports progress per slide and captures errors without aborting batch', async () => {
    const progressUpdates: SlideExportProgress[] = [];
    const captureFn = vi.fn().mockImplementation((element: HTMLElement) => {
      const slide = element as unknown as MockDomSlide & { fail?: boolean };
      if (slide.fail) {
        throw new Error('Canvas render failed');
      }
      return Promise.resolve(new Uint8Array([10, 20]));
    });

    const renderer = new BrowserDomSlideRenderer({
      captureFn,
      onProgress: (p) => progressUpdates.push(p),
    });

    const slide1 = new MockDomSlide();
    const slide2 = new MockDomSlide();
    (slide2 as unknown as { fail: boolean }).fail = true;
    const slide3 = new MockDomSlide();

    const tasks: SlideRenderTask[] = [
      { slideId: 'slide-1', element: slide1 as unknown as HTMLElement, order: 1 },
      { slideId: 'slide-2', element: slide2 as unknown as HTMLElement, order: 2 },
      { slideId: 'slide-3', element: slide3 as unknown as HTMLElement, order: 3 },
    ];

    const result = await renderer.renderBatch(tasks);

    expect(result.totalCount).toBe(3);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.errors).toEqual([{ slideId: 'slide-2', error: 'Canvas render failed' }]);
    expect(result.renderedSlides.map((s) => s.slideId)).toEqual(['slide-1', 'slide-3']);

    expect(progressUpdates.length).toBe(3);
    expect(progressUpdates[2]?.percentage).toBe(100);
  });

  it('supports retrying failed slides', async () => {
    let shouldFail = true;
    const captureFn = vi.fn().mockImplementation(() => {
      if (shouldFail) {
        throw new Error('Temporary failure');
      }
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    });

    const renderer = new BrowserDomSlideRenderer({ captureFn });
    const slide1 = new MockDomSlide();
    const tasks: SlideRenderTask[] = [
      { slideId: 'slide-retry', element: slide1 as unknown as HTMLElement, order: 1 },
    ];

    const initialResult = await renderer.renderBatch(tasks);
    expect(initialResult.failureCount).toBe(1);

    // Now retry after fixing transient issue
    shouldFail = false;
    const retryResult = await renderer.retryFailed(tasks, ['slide-retry']);
    expect(retryResult.successCount).toBe(1);
    expect(retryResult.failureCount).toBe(0);
    expect(retryResult.renderedSlides[0]?.slideId).toBe('slide-retry');
  });
});

describe('Native PDF export URL and configuration validation', () => {
  it('builds native PDF print URL enforcing ?print-pdf and pdfSeparateFragments=false', () => {
    const url1 = buildNativePdfPrintUrl('https://deck.agora.test/slides/');
    expect(url1).toBe('https://deck.agora.test/slides/?print-pdf=true&pdfSeparateFragments=false');

    const url2 = buildNativePdfPrintUrl('/relative/deck?theme=dark#overview');
    expect(url2).toContain('print-pdf=true');
    expect(url2).toContain('pdfSeparateFragments=false');
    expect(url2).toContain('theme=dark');
  });

  it('validates config enforcing pdfSeparateFragments: false', () => {
    const invalidConfig = validatePdfExportConfig({
      pdfSeparateFragments: true,
    });
    expect(invalidConfig.valid).toBe(false);
    expect(invalidConfig.errors[0]).toContain('pdfSeparateFragments must be set to false');

    const validConfig = validatePdfExportConfig({
      pdfSeparateFragments: false,
    });
    expect(validConfig.valid).toBe(true);
    expect(validConfig.errors.length).toBe(0);
  });

  it('validates uploaded PDF revision against presentation revision to reject stale PDFs', () => {
    const staleResult = validatePdfExportConfig({
      pdfSeparateFragments: false,
      deckRevision: 'rev-2',
      uploadedPdfRevision: 'rev-1',
    });
    expect(staleResult.valid).toBe(false);
    expect(staleResult.errors[0]).toContain('Uploaded PDF revision (rev-1) is stale');

    const freshResult = validatePdfExportConfig({
      pdfSeparateFragments: false,
      deckRevision: 'rev-2',
      uploadedPdfRevision: 'rev-2',
    });
    expect(freshResult.valid).toBe(true);
    expect(freshResult.errors.length).toBe(0);
  });
});
