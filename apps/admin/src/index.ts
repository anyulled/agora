import type {
  AssetManifest,
  AssetManifestEntry,
  Presentation,
  PresentationBranding,
  PresentationSession,
  SlideMetadata,
} from '@agora/contracts';

export interface CreateSlideInput {
  id?: string;
  presentationId?: string;
  title: string;
  horizontalIndex: number;
  verticalIndex: number;
  order?: number;
  isQaSlide?: boolean;
}

export interface CreatePresentationParams {
  title: string;
  description?: string;
  eventName?: string;
  branding?: Partial<PresentationBranding>;
  endingSlideId?: string;
  slides?: CreateSlideInput[];
}

export interface UpdatePresentationParams {
  title?: string;
  description?: string;
  eventName?: string;
  branding?: PresentationBranding;
  endingSlideId?: string;
}

export interface DeleteModalState {
  isOpen: boolean;
  presentationId: string | null;
  presentationTitle: string | null;
}

export type SlideImageStatus = 'pending' | 'rendering' | 'completed' | 'failed';

export interface FailedSlideImage {
  slideId: string;
  slideTitle: string;
  error: string;
}

export interface GenerateImagesWorkflowState {
  presentationId: string;
  revision: string;
  totalSlides: number;
  completedSlides: number;
  inProgress: boolean;
  statusBySlideId: Record<string, SlideImageStatus>;
  failedSlides: FailedSlideImage[];
}

export interface SlideRenderer {
  renderSlide(slide: SlideMetadata, presentation: Presentation): Promise<string | Uint8Array>;
}

export class DefaultDomSlideRenderer implements SlideRenderer {
  async renderSlide(slide: SlideMetadata, presentation: Presentation): Promise<string> {
    // Browser-side DOM capture representation for MVP (SPEC-013)
    return `data:image/png;base64,agora_dom_capture_${presentation.id}_${slide.id}_${presentation.revision}`;
  }
}

export interface AssetPreviewSlide {
  slide: SlideMetadata;
  hasPng: boolean;
  pngEntry?: AssetManifestEntry;
}

export interface AssetPreviewModel {
  presentationId: string;
  title: string;
  revision: string;
  slides: AssetPreviewSlide[];
  deckPdf?: AssetManifestEntry;
  isPdfStale: boolean;
  isReadyForLiveDelivery: boolean;
}

export interface AdminDashboardViewModel {
  presentations: Presentation[];
  manifestsByPresentationId: Record<string, AssetManifest>;
  deleteModalState: DeleteModalState;
  activeSessionsByPresentationId: Record<string, PresentationSession>;
}

export class AdminAppController {
  private presentations = new Map<string, Presentation>();
  private manifests = new Map<string, AssetManifest>();
  private activeSessions = new Map<string, PresentationSession>();
  private deleteModalState: DeleteModalState = {
    isOpen: false,
    presentationId: null,
    presentationTitle: null,
  };
  private workflowState: GenerateImagesWorkflowState | null = null;
  private idCounter = 1;

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${this.idCounter++}`;
  }

  createPresentation(params: CreatePresentationParams): Presentation {
    const id = this.generateId('pres');
    const defaultEndingSlideId = params.endingSlideId ?? `${id}_slide_end`;

    const slides: SlideMetadata[] = (params.slides ?? []).map((slide, index) => ({
      id: slide.id || `${id}_slide_${index + 1}`,
      presentationId: id,
      title: slide.title,
      horizontalIndex: slide.horizontalIndex,
      verticalIndex: slide.verticalIndex,
      order: slide.order ?? index,
      isQaSlide: slide.isQaSlide ?? false,
    }));

    const presentation: Presentation = {
      id,
      title: params.title,
      description: params.description,
      eventName: params.eventName,
      revision: 'rev_1',
      status: 'draft',
      endingSlideId:
        params.endingSlideId ||
        (slides.length > 0
          ? (slides[slides.length - 1]?.id ?? defaultEndingSlideId)
          : defaultEndingSlideId),
      branding: {
        colors: params.branding?.colors ?? { primary: '#2563eb', background: '#0f172a' },
        logoAssetId: params.branding?.logoAssetId,
      },
      slides,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.presentations.set(id, presentation);
    this.manifests.set(id, {
      presentationId: id,
      revision: presentation.revision,
      slidePngs: {},
    });

    return presentation;
  }

  getPresentation(id: string): Presentation | null {
    return this.presentations.get(id) ?? null;
  }

  getAllPresentations(): Presentation[] {
    return Array.from(this.presentations.values());
  }

  getAssetManifest(presentationId: string): AssetManifest | null {
    return this.manifests.get(presentationId) ?? null;
  }

  updatePresentation(id: string, updates: UpdatePresentationParams): Presentation {
    const presentation = this.presentations.get(id);
    if (!presentation) {
      throw new Error(`Presentation ${id} not found`);
    }

    if (updates.title !== undefined) presentation.title = updates.title;
    if (updates.description !== undefined) presentation.description = updates.description;
    if (updates.eventName !== undefined) presentation.eventName = updates.eventName;
    if (updates.branding !== undefined) presentation.branding = updates.branding;
    if (updates.endingSlideId !== undefined) presentation.endingSlideId = updates.endingSlideId;
    presentation.updatedAt = new Date().toISOString();

    return presentation;
  }

  updateSlide(
    presentationId: string,
    slideId: string,
    updates: Partial<Omit<SlideMetadata, 'id' | 'presentationId'>>,
  ): Presentation {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    const slide = presentation.slides?.find((s) => s.id === slideId);
    if (!slide) {
      throw new Error(`Slide ${slideId} not found in presentation ${presentationId}`);
    }

    Object.assign(slide, updates);

    // SPEC-001 & SPEC-015: Editing slide metadata triggers revision bump & flags stale assets
    const prevRevNum = Number.parseInt(presentation.revision.replace('rev_', ''), 10) || 1;
    const nextRevision = `rev_${prevRevNum + 1}`;
    presentation.revision = nextRevision;
    presentation.updatedAt = new Date().toISOString();

    // Flag stale assets: update manifest revision, clearing current revision associations
    const manifest = this.manifests.get(presentationId);
    if (manifest) {
      manifest.revision = nextRevision;
      // Previous PNGs and PDF now belong to an older revision and are flagged stale
      manifest.slidePngs = {};
      if (manifest.deckPdf) {
        manifest.deckPdf.revision = `stale_${manifest.deckPdf.revision}`;
      }
    }

    return presentation;
  }

  publishPresentation(id: string): Presentation {
    const presentation = this.presentations.get(id);
    if (!presentation) {
      throw new Error(`Presentation ${id} not found`);
    }
    presentation.status = 'published';
    presentation.updatedAt = new Date().toISOString();
    return presentation;
  }

  duplicatePresentation(id: string, newTitle?: string): Presentation {
    const source = this.presentations.get(id);
    if (!source) {
      throw new Error(`Source presentation ${id} not found`);
    }

    // SPEC-017: Deep copy content and branding without sessions, votes, questions, or participants
    const newId = this.generateId('pres');
    const title = newTitle || `${source.title} (Copy)`;

    const idMap = new Map<string, string>();
    const clonedSlides: SlideMetadata[] = (source.slides ?? []).map((slide, index) => {
      const clonedSlideId = `${newId}_slide_${index + 1}`;
      idMap.set(slide.id, clonedSlideId);
      return {
        id: clonedSlideId,
        presentationId: newId,
        title: slide.title,
        horizontalIndex: slide.horizontalIndex,
        verticalIndex: slide.verticalIndex,
        order: slide.order,
        isQaSlide: slide.isQaSlide,
      };
    });

    const clonedEndingSlideId = idMap.get(source.endingSlideId) ?? `${newId}_slide_end`;

    const duplicatedPresentation: Presentation = {
      id: newId,
      title,
      description: source.description,
      eventName: source.eventName,
      revision: 'rev_1',
      status: 'draft',
      endingSlideId: clonedEndingSlideId,
      branding: {
        colors: { ...source.branding.colors },
        logoAssetId: source.branding.logoAssetId,
      },
      slides: clonedSlides,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.presentations.set(newId, duplicatedPresentation);
    this.manifests.set(newId, {
      presentationId: newId,
      revision: duplicatedPresentation.revision,
      slidePngs: {},
    });

    return duplicatedPresentation;
  }

  requestDeletePresentation(id: string): DeleteModalState {
    const presentation = this.presentations.get(id);
    if (!presentation) {
      throw new Error(`Presentation ${id} not found`);
    }
    this.deleteModalState = {
      isOpen: true,
      presentationId: id,
      presentationTitle: presentation.title,
    };
    return { ...this.deleteModalState };
  }

  cancelDeletePresentation(): void {
    this.deleteModalState = {
      isOpen: false,
      presentationId: null,
      presentationTitle: null,
    };
  }

  confirmDeletePresentation(): Presentation {
    if (!this.deleteModalState.isOpen || !this.deleteModalState.presentationId) {
      throw new Error(
        'No pending delete confirmation modal open. SPEC-001 requires explicit confirmation.',
      );
    }

    const id = this.deleteModalState.presentationId;
    const presentation = this.presentations.get(id);
    if (!presentation) {
      throw new Error(`Presentation ${id} not found`);
    }

    this.presentations.delete(id);
    this.manifests.delete(id);
    this.activeSessions.delete(id);
    this.cancelDeletePresentation();

    return presentation;
  }

  getDeleteModalState(): DeleteModalState {
    return { ...this.deleteModalState };
  }

  // SPEC-013: Browser-side PNG generation workflow
  async generateAllSlideImages(
    presentationId: string,
    renderer: SlideRenderer = new DefaultDomSlideRenderer(),
  ): Promise<GenerateImagesWorkflowState> {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    const slides = presentation.slides ?? [];
    const statusBySlideId: Record<string, SlideImageStatus> = {};
    for (const slide of slides) {
      statusBySlideId[slide.id] = 'pending';
    }

    const workflow: GenerateImagesWorkflowState = {
      presentationId,
      revision: presentation.revision,
      totalSlides: slides.length,
      completedSlides: 0,
      inProgress: true,
      statusBySlideId,
      failedSlides: [],
    };
    this.workflowState = workflow;

    const manifest = this.manifests.get(presentationId) ?? {
      presentationId,
      revision: presentation.revision,
      slidePngs: {},
    };

    for (const slide of slides) {
      workflow.statusBySlideId[slide.id] = 'rendering';
      try {
        await renderer.renderSlide(slide, presentation);
        manifest.slidePngs[slide.id] = {
          assetId: `png_${presentationId}_${presentation.revision}_${slide.id}`,
          presentationId,
          revision: presentation.revision,
          kind: 'slide-png',
          slideId: slide.id,
          r2Key: `presentations/${presentationId}/${presentation.revision}/slides/${slide.id}.png`,
          contentType: 'image/png',
          byteSize: 1024 * 64,
          createdAt: new Date().toISOString(),
        };
        workflow.statusBySlideId[slide.id] = 'completed';
        workflow.completedSlides += 1;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        workflow.statusBySlideId[slide.id] = 'failed';
        workflow.failedSlides.push({
          slideId: slide.id,
          slideTitle: slide.title,
          error: errorMsg,
        });
      }
    }

    workflow.inProgress = false;
    this.manifests.set(presentationId, manifest);
    return { ...workflow };
  }

  async retryFailedSlideImages(
    presentationId: string,
    renderer: SlideRenderer = new DefaultDomSlideRenderer(),
  ): Promise<GenerateImagesWorkflowState> {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    if (!this.workflowState || this.workflowState.presentationId !== presentationId) {
      return this.generateAllSlideImages(presentationId, renderer);
    }

    const failedIds = this.workflowState.failedSlides.map((f) => f.slideId);
    if (failedIds.length === 0) {
      return { ...this.workflowState };
    }

    this.workflowState.inProgress = true;
    const slidesToRetry = (presentation.slides ?? []).filter((s) => failedIds.includes(s.id));
    const stillFailed: FailedSlideImage[] = [];

    const manifest = this.manifests.get(presentationId) ?? {
      presentationId,
      revision: presentation.revision,
      slidePngs: {},
    };

    for (const slide of slidesToRetry) {
      this.workflowState.statusBySlideId[slide.id] = 'rendering';
      try {
        await renderer.renderSlide(slide, presentation);
        manifest.slidePngs[slide.id] = {
          assetId: `png_${presentationId}_${presentation.revision}_${slide.id}`,
          presentationId,
          revision: presentation.revision,
          kind: 'slide-png',
          slideId: slide.id,
          r2Key: `presentations/${presentationId}/${presentation.revision}/slides/${slide.id}.png`,
          contentType: 'image/png',
          byteSize: 1024 * 64,
          createdAt: new Date().toISOString(),
        };
        this.workflowState.statusBySlideId[slide.id] = 'completed';
        this.workflowState.completedSlides += 1;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.workflowState.statusBySlideId[slide.id] = 'failed';
        stillFailed.push({
          slideId: slide.id,
          slideTitle: slide.title,
          error: errorMsg,
        });
      }
    }

    this.workflowState.failedSlides = stillFailed;
    this.workflowState.inProgress = false;
    this.manifests.set(presentationId, manifest);
    return { ...this.workflowState };
  }

  getWorkflowState(): GenerateImagesWorkflowState | null {
    return this.workflowState ? { ...this.workflowState } : null;
  }

  // SPEC-015: Reveal.js native PDF print helper and PDF upload
  getRevealPdfPrintUrl(presentationId: string, baseUrl = 'https://agora.live'): string {
    return `${baseUrl}/deck/${presentationId}?print-pdf`;
  }

  getRevealPrintConfig(): { printPdf: boolean; pdfSeparateFragments: boolean } {
    return {
      printPdf: true,
      pdfSeparateFragments: false,
    };
  }

  uploadDeckPdf(
    presentationId: string,
    pdfData: { byteSize: number; r2Key?: string; fileName?: string },
  ): AssetManifestEntry {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    const manifest = this.manifests.get(presentationId) ?? {
      presentationId,
      revision: presentation.revision,
      slidePngs: {},
    };

    const entry: AssetManifestEntry = {
      assetId: `pdf_${presentationId}_${presentation.revision}`,
      presentationId,
      revision: presentation.revision,
      kind: 'deck-pdf',
      r2Key: pdfData.r2Key || `presentations/${presentationId}/${presentation.revision}/deck.pdf`,
      contentType: 'application/pdf',
      byteSize: pdfData.byteSize,
      createdAt: new Date().toISOString(),
    };

    manifest.deckPdf = entry;
    this.manifests.set(presentationId, manifest);
    return entry;
  }

  isPdfStale(presentationId: string): boolean {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) return true;
    const manifest = this.manifests.get(presentationId);
    if (!manifest?.deckPdf) return true;
    return manifest.deckPdf.revision !== presentation.revision;
  }

  // SPEC-024: Asset preview before live delivery
  getAssetPreview(presentationId: string): AssetPreviewModel {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    const manifest = this.manifests.get(presentationId);
    const slides = presentation.slides ?? [];

    const previewSlides: AssetPreviewSlide[] = slides.map((slide) => {
      const entry = manifest?.slidePngs[slide.id];
      const hasPng = Boolean(entry && entry.revision === presentation.revision);
      return {
        slide,
        hasPng,
        pngEntry: hasPng ? entry : undefined,
      };
    });

    const hasDeckPdf = Boolean(
      manifest?.deckPdf && manifest.deckPdf.revision === presentation.revision,
    );
    const allSlidesRendered = previewSlides.every((s) => s.hasPng);

    return {
      presentationId,
      title: presentation.title,
      revision: presentation.revision,
      slides: previewSlides,
      deckPdf: manifest?.deckPdf,
      isPdfStale: this.isPdfStale(presentationId),
      isReadyForLiveDelivery: allSlidesRendered && hasDeckPdf,
    };
  }

  // SPEC-002: Live session starter
  startLiveSession(
    presentationId: string,
    options?: { audienceBaseUrl?: string; status?: 'scheduled' | 'live' },
  ): PresentationSession {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) {
      throw new Error(`Presentation ${presentationId} not found`);
    }

    const sessionId = this.generateId('sess');
    const baseUrl = options?.audienceBaseUrl || 'https://agora.live';
    const status = options?.status || 'live';
    const firstSlide = status === 'live' ? presentation.slides?.[0] : undefined;

    const session: PresentationSession = {
      id: sessionId,
      presentationId,
      presentationRevision: presentation.revision,
      status,
      currentSlideId: firstSlide?.id ?? null,
      revealedSlideIds: firstSlide ? [firstSlide.id] : [],
      pdfDownloadUnlocked: false,
      audienceUrl: `${baseUrl}/audience/${sessionId}`,
      qrCodeDataUrl: `data:image/svg+xml;utf8,<svg viewBox="0 0 100 100"><text y="50">QR_${sessionId}</text></svg>`,
      connectedParticipants: 0,
      startedAt: status === 'live' ? new Date().toISOString() : undefined,
    };

    this.activeSessions.set(presentationId, session);
    return session;
  }

  getActiveSession(presentationId: string): PresentationSession | null {
    return this.activeSessions.get(presentationId) ?? null;
  }

  getDashboardViewModel(): AdminDashboardViewModel {
    const manifestsByPresentationId: Record<string, AssetManifest> = {};
    for (const [id, m] of this.manifests.entries()) {
      manifestsByPresentationId[id] = m;
    }

    const activeSessionsByPresentationId: Record<string, PresentationSession> = {};
    for (const [id, s] of this.activeSessions.entries()) {
      activeSessionsByPresentationId[id] = s;
    }

    return {
      presentations: this.getAllPresentations(),
      manifestsByPresentationId,
      deleteModalState: this.getDeleteModalState(),
      activeSessionsByPresentationId,
    };
  }
}

// Clean UI view-model renderers
export function renderAdminDashboardHtml(state: AdminDashboardViewModel): string {
  const cardsHtml = state.presentations
    .map((p) => {
      const activeSession = state.activeSessionsByPresentationId[p.id];
      const sessionBadge = activeSession
        ? `<span class="badge badge-live">${activeSession.status.toUpperCase()} (${activeSession.id})</span>`
        : `<span class="badge badge-draft">${p.status}</span>`;

      const sessionJoinHtml = activeSession
        ? `<div class="session-join-info" data-session-id="${activeSession.id}">
            <p class="session-join-link">Join URL: <a href="${activeSession.audienceUrl ?? ''}" class="session-join-url">${activeSession.audienceUrl ?? ''}</a></p>
            ${activeSession.qrCodeDataUrl ? `<img src="${activeSession.qrCodeDataUrl}" alt="Join QR code for ${p.title}" class="session-qr-code" />` : ''}
          </div>`
        : '';

      return `
      <article class="card presentation-card" data-presentation-id="${p.id}">
        <div class="card-header">
          <h3>${p.title}</h3>
          ${sessionBadge}
        </div>
        <p class="revision-label">Revision: <strong>${p.revision}</strong> | Slides: ${p.slides?.length ?? 0}</p>
        ${sessionJoinHtml}
        <div class="button-group">
          <button class="btn-primary" data-action="start-session" data-id="${p.id}">Start Live Session</button>
          <button class="btn-secondary" data-action="generate-images" data-id="${p.id}">Generate Images</button>
          <button class="btn-secondary" data-action="duplicate" data-id="${p.id}">Duplicate</button>
          <button class="btn-danger" data-action="request-delete" data-id="${p.id}">Delete</button>
        </div>
      </article>`;
    })
    .join('');

  return `
    <div class="dashboard-view">
      <div class="dashboard-header">
        <h2>Presentations (${state.presentations.length})</h2>
        <button class="btn-primary" data-action="create-presentation">New Presentation</button>
      </div>
      <div class="presentations-list">
        ${cardsHtml || '<p class="empty-state">No presentations available. Create one to get started.</p>'}
      </div>
      ${renderDeleteConfirmationModalHtml(state.deleteModalState)}
    </div>`;
}

export function renderSlideImageWorkflowHtml(state: GenerateImagesWorkflowState): string {
  const percent =
    state.totalSlides > 0 ? Math.round((state.completedSlides / state.totalSlides) * 100) : 0;
  const slideRows = Object.entries(state.statusBySlideId)
    .map(([slideId, status]) => {
      const isFailed = status === 'failed';
      return `
      <li class="slide-status-item status-${status}">
        <span class="slide-id">${slideId}</span>
        <span class="status-badge">${status}</span>
        ${isFailed ? `<button class="btn-retry-single" data-slide-id="${slideId}">Retry</button>` : ''}
      </li>`;
    })
    .join('');

  const failedAlert =
    state.failedSlides.length > 0
      ? `<div class="alert alert-error" role="alert">
           <p>Failed to render ${state.failedSlides.length} slide(s).</p>
           <button class="btn-primary" data-action="retry-failed">Retry Failed Slides</button>
         </div>`
      : '';

  return `
    <div class="workflow-container" aria-live="polite">
      <h3>Generating Slide Images (Revision ${state.revision})</h3>
      <div class="progress-bar-wrapper">
        <div class="progress-bar" style="width: ${percent}%;" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
          ${percent}%
        </div>
      </div>
      <p class="progress-summary">${state.completedSlides} of ${state.totalSlides} slides processed</p>
      ${failedAlert}
      <ul class="slide-status-list">
        ${slideRows}
      </ul>
    </div>`;
}

export function renderDeleteConfirmationModalHtml(modalState: DeleteModalState): string {
  if (!modalState.isOpen) {
    return '';
  }

  return `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
      <div class="modal-content">
        <h3 id="delete-dialog-title">Confirm Deletion</h3>
        <p>Are you sure you want to delete <strong>${modalState.presentationTitle ?? 'this presentation'}</strong>? This action is permanent and cannot be undone.</p>
        <div class="button-group modal-actions">
          <button class="btn-secondary" data-action="cancel-delete">Cancel</button>
          <button class="btn-danger" data-action="confirm-delete" data-id="${modalState.presentationId ?? ''}">Delete Presentation</button>
        </div>
      </div>
    </div>`;
}

export function renderAssetPreviewHtml(preview: AssetPreviewModel): string {
  const slidePreviews = preview.slides
    .map(
      (s) => `
      <div class="asset-preview-item ${s.hasPng ? 'status-ready' : 'status-missing'}">
        <div class="preview-header">
          <strong>${s.slide.title}</strong>
          <span class="badge">${s.hasPng ? 'PNG Ready' : 'PNG Missing'}</span>
        </div>
        ${s.hasPng ? `<img src="/assets/${s.pngEntry?.r2Key ?? ''}" alt="${s.slide.title}" class="slide-thumbnail" />` : '<div class="thumbnail-placeholder">No Image</div>'}
      </div>`,
    )
    .join('');

  return `
    <div class="asset-preview-view">
      <h3>Asset Preview for "${preview.title}" (${preview.revision})</h3>
      <div class="pdf-status-banner ${preview.isPdfStale ? 'banner-stale' : 'banner-ready'}">
        <strong>Deck PDF:</strong> ${preview.isPdfStale ? 'Stale or not uploaded' : 'Up to date with current revision'}
      </div>
      <div class="slides-grid">
        ${slidePreviews}
      </div>
    </div>`;
}
