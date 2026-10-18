export interface SlideRenderTask {
  slideId: string;
  element: HTMLElement;
  order: number;
}

export interface SlideRenderOutput {
  slideId: string;
  pngBytes: Uint8Array;
  byteSize: number;
  width: number;
  height: number;
}

export interface SlideExportProgress {
  currentSlideId: string;
  completedCount: number;
  totalCount: number;
  percentage: number;
}

export interface SlideExportError {
  slideId: string;
  error: string;
}

export interface SlideExportBatchResult {
  renderedSlides: SlideRenderOutput[];
  errors: SlideExportError[];
  totalCount: number;
  successCount: number;
  failureCount: number;
}

export interface SlideRendererOptions {
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  captureFn?: (
    element: HTMLElement,
    options: { width: number; height: number },
  ) => Promise<Uint8Array>;
  onProgress?: (progress: SlideExportProgress) => void;
}

export interface SlideRenderer {
  renderSlide(task: SlideRenderTask): Promise<SlideRenderOutput>;
  renderBatch(tasks: SlideRenderTask[]): Promise<SlideExportBatchResult>;
  retryFailed(tasks: SlideRenderTask[], failedSlideIds: string[]): Promise<SlideExportBatchResult>;
  forceFinalFragmentState(element: HTMLElement): void;
}

export interface PdfExportConfig {
  pdfSeparateFragments: boolean;
  deckRevision?: string;
  uploadedPdfRevision?: string;
  margin?: number;
  printBackground?: boolean;
}

export interface PdfValidationResult {
  valid: boolean;
  errors: string[];
}

export class BrowserDomSlideRenderer implements SlideRenderer {
  private readonly defaultWidth: number;
  private readonly defaultHeight: number;
  private readonly captureFn: (
    element: HTMLElement,
    options: { width: number; height: number },
  ) => Promise<Uint8Array>;
  private readonly onProgress?: (progress: SlideExportProgress) => void;

  constructor(options?: SlideRendererOptions) {
    this.defaultWidth = options?.width ?? 1920;
    this.defaultHeight = options?.height ?? 1080;
    this.onProgress = options?.onProgress;
    this.captureFn =
      options?.captureFn ??
      (async () => {
        // Fallback dummy 1x1 PNG bytes if no capture implementation injected
        return new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
          0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
          0x15, 0xc4, 0x89,
        ]);
      });
  }

  public forceFinalFragmentState(element: HTMLElement): void {
    const fragments = Array.from(element.querySelectorAll?.('.fragment') ?? []);
    for (const rawFragment of fragments) {
      const fragment = rawFragment as HTMLElement;
      if (fragment.classList) {
        fragment.classList.add('visible');
      }
      if (fragment.style) {
        fragment.style.opacity = '1';
        fragment.style.visibility = 'visible';
      }
    }
  }

  public async renderSlide(task: SlideRenderTask): Promise<SlideRenderOutput> {
    this.forceFinalFragmentState(task.element);

    const originalWidth = task.element.style?.width;
    const originalHeight = task.element.style?.height;

    try {
      if (task.element.style) {
        task.element.style.width = `${this.defaultWidth}px`;
        task.element.style.height = `${this.defaultHeight}px`;
      }

      const pngBytes = await this.captureFn(task.element, {
        width: this.defaultWidth,
        height: this.defaultHeight,
      });

      return {
        slideId: task.slideId,
        pngBytes,
        byteSize: pngBytes.byteLength,
        width: this.defaultWidth,
        height: this.defaultHeight,
      };
    } finally {
      if (task.element.style) {
        task.element.style.width = originalWidth ?? '';
        task.element.style.height = originalHeight ?? '';
      }
    }
  }

  public async renderBatch(tasks: SlideRenderTask[]): Promise<SlideExportBatchResult> {
    const renderedSlides: SlideRenderOutput[] = [];
    const errors: SlideExportError[] = [];
    const totalCount = tasks.length;

    for (let i = 0; i < totalCount; i++) {
      const task = tasks[i]!;
      try {
        const output = await this.renderSlide(task);
        renderedSlides.push(output);
      } catch (err) {
        errors.push({
          slideId: task.slideId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      this.onProgress?.({
        currentSlideId: task.slideId,
        completedCount: i + 1,
        totalCount,
        percentage: Math.round(((i + 1) / totalCount) * 100),
      });
    }

    return {
      renderedSlides,
      errors,
      totalCount,
      successCount: renderedSlides.length,
      failureCount: errors.length,
    };
  }

  public async retryFailed(
    tasks: SlideRenderTask[],
    failedSlideIds: string[],
  ): Promise<SlideExportBatchResult> {
    const tasksToRetry = tasks.filter((t) => failedSlideIds.includes(t.slideId));
    return this.renderBatch(tasksToRetry);
  }
}

export function buildNativePdfPrintUrl(deckUrl: string, config?: Partial<PdfExportConfig>): string {
  const isRelative = !deckUrl.startsWith('http://') && !deckUrl.startsWith('https://');
  const base = isRelative ? 'http://localhost' : undefined;
  const url = new URL(deckUrl, base);

  url.searchParams.set('print-pdf', 'true');
  url.searchParams.set(
    'pdfSeparateFragments',
    config?.pdfSeparateFragments === true ? 'true' : 'false',
  );

  if (isRelative) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}

export function validatePdfExportConfig(config: Partial<PdfExportConfig>): PdfValidationResult {
  const errors: string[] = [];

  if (config.pdfSeparateFragments !== false) {
    errors.push(
      'pdfSeparateFragments must be set to false to prevent fragment-by-fragment page splits.',
    );
  }

  if (
    config.deckRevision &&
    config.uploadedPdfRevision &&
    config.deckRevision !== config.uploadedPdfRevision
  ) {
    errors.push(
      `Uploaded PDF revision (${config.uploadedPdfRevision}) is stale and does not match current presentation revision (${config.deckRevision}).`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
