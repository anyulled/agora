import { beforeEach, describe, expect, it } from 'vitest';
import {
  AdminAppController,
  type SlideRenderer,
  renderAdminDashboardHtml,
  renderAssetPreviewHtml,
  renderDeleteConfirmationModalHtml,
  renderSlideImageWorkflowHtml,
} from '../index.js';

describe('AdminAppController (SPEC-001, SPEC-013, SPEC-015, SPEC-017, SPEC-024)', () => {
  let admin: AdminAppController;

  beforeEach(() => {
    admin = new AdminAppController();
  });

  describe('Presentation Administration & Lifecycle (SPEC-001)', () => {
    it('creates a presentation with initial draft status, rev_1 revision and empty manifest', () => {
      const pres = admin.createPresentation({
        title: 'Keynote 2026',
        description: 'Annual conference keynote',
        eventName: 'Agora Conf',
        slides: [
          { title: 'Intro', horizontalIndex: 0, verticalIndex: 0, order: 0 },
          { title: 'Vision', horizontalIndex: 1, verticalIndex: 0, order: 1 },
        ],
      });

      expect(pres.id).toBeDefined();
      expect(pres.title).toBe('Keynote 2026');
      expect(pres.status).toBe('draft');
      expect(pres.revision).toBe('rev_1');
      expect(pres.slides).toHaveLength(2);

      const manifest = admin.getAssetManifest(pres.id);
      expect(manifest).not.toBeNull();
      expect(manifest?.revision).toBe('rev_1');
      expect(manifest?.slidePngs).toEqual({});
    });

    it('updates presentation details and publishes it', () => {
      const pres = admin.createPresentation({ title: 'Draft Deck' });
      admin.updatePresentation(pres.id, {
        title: 'Final Deck',
        description: 'Ready for delivery',
      });

      const updated = admin.getPresentation(pres.id);
      expect(updated?.title).toBe('Final Deck');
      expect(updated?.description).toBe('Ready for delivery');

      admin.publishPresentation(pres.id);
      expect(admin.getPresentation(pres.id)?.status).toBe('published');
    });

    it('editing slide metadata triggers revision bump and flags stale assets (SPEC-001, SPEC-015)', () => {
      const pres = admin.createPresentation({
        title: 'Slideshow',
        slides: [{ title: 'Slide 1', horizontalIndex: 0, verticalIndex: 0, order: 0 }],
      });

      const slideId = pres.slides?.[0]?.id;
      expect(slideId).toBeDefined();

      // Upload a PDF to the first revision
      admin.uploadDeckPdf(pres.id, { byteSize: 50000 });
      expect(admin.isPdfStale(pres.id)).toBe(false);

      // Edit slide metadata
      admin.updateSlide(pres.id, slideId as string, { title: 'Updated Slide Title' });

      const updatedPres = admin.getPresentation(pres.id);
      expect(updatedPres?.revision).toBe('rev_2');
      expect(updatedPres?.slides?.[0]?.title).toBe('Updated Slide Title');

      // Check stale asset flagging
      expect(admin.isPdfStale(pres.id)).toBe(true);
      const manifest = admin.getAssetManifest(pres.id);
      expect(manifest?.revision).toBe('rev_2');
      expect(manifest?.slidePngs).toEqual({});
    });

    it('requires explicit confirmation modal state before deleting a presentation (SPEC-001)', () => {
      const pres = admin.createPresentation({ title: 'To Delete' });

      // Direct delete without confirmation throws error
      expect(() => admin.confirmDeletePresentation()).toThrow(
        /SPEC-001 requires explicit confirmation/,
      );

      // Request delete opens modal
      const modalState = admin.requestDeletePresentation(pres.id);
      expect(modalState.isOpen).toBe(true);
      expect(modalState.presentationId).toBe(pres.id);
      expect(modalState.presentationTitle).toBe('To Delete');

      // Cancel resets modal
      admin.cancelDeletePresentation();
      expect(admin.getDeleteModalState().isOpen).toBe(false);

      // Request again and confirm
      admin.requestDeletePresentation(pres.id);
      const deleted = admin.confirmDeletePresentation();
      expect(deleted.id).toBe(pres.id);
      expect(admin.getPresentation(pres.id)).toBeNull();
      expect(admin.getDeleteModalState().isOpen).toBe(false);
    });
  });

  describe('Presentation Duplication (SPEC-017)', () => {
    it('creates an independent copy without copying sessions, votes, or participants', () => {
      const source = admin.createPresentation({
        title: 'Original Deck',
        description: 'Original description',
        branding: { colors: { primary: '#10b981', background: '#000000' } },
        slides: [
          { title: 'Slide A', horizontalIndex: 0, verticalIndex: 0, order: 0 },
          { title: 'Slide B', horizontalIndex: 1, verticalIndex: 0, order: 1 },
        ],
      });

      // Start a session on the source
      const session = admin.startLiveSession(source.id);
      expect(session).toBeDefined();

      const copy = admin.duplicatePresentation(source.id, 'Cloned Deck');

      expect(copy.id).not.toBe(source.id);
      expect(copy.title).toBe('Cloned Deck');
      expect(copy.description).toBe(source.description);
      expect(copy.status).toBe('draft');
      expect(copy.revision).toBe('rev_1');
      expect(copy.branding.colors.primary).toBe('#10b981');
      expect(copy.slides).toHaveLength(2);
      expect(copy.slides?.[0]?.id).not.toBe(source.slides?.[0]?.id);

      // Duplication must NOT copy active sessions
      expect(admin.getActiveSession(copy.id)).toBeNull();
      // Fresh empty manifest
      const copyManifest = admin.getAssetManifest(copy.id);
      expect(copyManifest?.slidePngs).toEqual({});
      expect(copyManifest?.deckPdf).toBeUndefined();
    });
  });

  describe('Adaptive Navigation Settings (SPEC-011)', () => {
    it('configures and removes a branch rule that targets a valid 2D destination', () => {
      const presentation = admin.createPresentation({
        title: 'Branching Deck',
        slides: [
          { title: 'Poll', horizontalIndex: 0, verticalIndex: 0 },
          { title: 'Details', horizontalIndex: 1, verticalIndex: 1 },
        ],
      });
      const [sourceSlide, targetSlide] = presentation.slides ?? [];

      const rule = admin.addNavigationRule(presentation.id, {
        sourceSlideId: sourceSlide!.id,
        pollId: 'poll-architecture',
        optionId: 'show-details',
        minVoteThreshold: 3,
        minPercentageThreshold: 60,
        targetSlideId: targetSlide!.id,
        targetHorizontalIndex: 1,
        targetVerticalIndex: 1,
      });

      expect(admin.getNavigationRules(presentation.id)).toEqual([rule]);
      admin.removeNavigationRule(presentation.id, rule.id);
      expect(admin.getNavigationRules(presentation.id)).toEqual([]);
    });

    it('rejects a branch rule whose coordinates do not identify its target slide', () => {
      const presentation = admin.createPresentation({
        title: 'Validated Branching Deck',
        slides: [
          { title: 'Poll', horizontalIndex: 0, verticalIndex: 0 },
          { title: 'Details', horizontalIndex: 1, verticalIndex: 1 },
        ],
      });
      const [sourceSlide, targetSlide] = presentation.slides ?? [];

      expect(() =>
        admin.addNavigationRule(presentation.id, {
          sourceSlideId: sourceSlide!.id,
          pollId: 'poll-architecture',
          optionId: 'show-details',
          minVoteThreshold: 1,
          targetSlideId: targetSlide!.id,
          targetHorizontalIndex: 1,
          targetVerticalIndex: 0,
        }),
      ).toThrow(/coordinates must match/);
    });
  });

  describe('Browser-side PNG Generation Workflow (SPEC-013)', () => {
    it('tracks per-slide progress, logs errors, and retries failed slides', async () => {
      const pres = admin.createPresentation({
        title: 'Presentation for Export',
        slides: [
          { title: 'Slide 1', horizontalIndex: 0, verticalIndex: 0, order: 0 },
          { title: 'Slide 2', horizontalIndex: 1, verticalIndex: 0, order: 1 },
          { title: 'Slide 3', horizontalIndex: 2, verticalIndex: 0, order: 2 },
        ],
      });

      const slide2Id = pres.slides?.[1]?.id;

      // Mock renderer that fails on Slide 2
      let failSlide2 = true;
      const mockRenderer: SlideRenderer = {
        async renderSlide(slide) {
          if (slide.id === slide2Id && failSlide2) {
            throw new Error('Canvas render timeout');
          }
          return `data:image/png;base64,rendered_${slide.id}`;
        },
      };

      const result1 = await admin.generateAllSlideImages(pres.id, mockRenderer);
      expect(result1.totalSlides).toBe(3);
      expect(result1.completedSlides).toBe(2);
      expect(result1.failedSlides).toHaveLength(1);
      expect(result1.failedSlides[0]?.slideId).toBe(slide2Id);
      expect(result1.statusBySlideId[slide2Id as string]).toBe('failed');

      // Now retry with working renderer
      failSlide2 = false;
      const result2 = await admin.retryFailedSlideImages(pres.id, mockRenderer);
      expect(result2.failedSlides).toHaveLength(0);
      expect(result2.completedSlides).toBe(3);
      expect(result2.statusBySlideId[slide2Id as string]).toBe('completed');

      const manifest = admin.getAssetManifest(pres.id);
      expect(Object.keys(manifest?.slidePngs ?? {})).toHaveLength(3);
    });
  });

  describe('Native Reveal.js PDF Export & Upload (SPEC-015)', () => {
    it('generates native print-pdf url and respects pdfSeparateFragments: false', () => {
      const pres = admin.createPresentation({ title: 'PDF Test' });
      const printUrl = admin.getRevealPdfPrintUrl(pres.id);
      expect(printUrl).toContain('?print-pdf');
      expect(printUrl).toContain(pres.id);

      const printConfig = admin.getRevealPrintConfig();
      expect(printConfig.printPdf).toBe(true);
      expect(printConfig.pdfSeparateFragments).toBe(false);
    });

    it('associates uploaded PDF with presentation revision and tracks staleness', () => {
      const pres = admin.createPresentation({ title: 'PDF Staleness Test' });
      expect(admin.isPdfStale(pres.id)).toBe(true);

      const entry = admin.uploadDeckPdf(pres.id, { byteSize: 1048576 });
      expect(entry.kind).toBe('deck-pdf');
      expect(entry.revision).toBe(pres.revision);
      expect(admin.isPdfStale(pres.id)).toBe(false);
    });
  });

  describe('Asset Preview & Live Delivery (SPEC-024, SPEC-002)', () => {
    it('reports ready state only when all slide PNGs and current PDF exist', async () => {
      const pres = admin.createPresentation({
        title: 'Preview Test',
        slides: [{ title: 'Slide 1', horizontalIndex: 0, verticalIndex: 0, order: 0 }],
      });

      let preview = admin.getAssetPreview(pres.id);
      expect(preview.isReadyForLiveDelivery).toBe(false);

      // Generate PNGs
      await admin.generateAllSlideImages(pres.id);
      preview = admin.getAssetPreview(pres.id);
      expect(preview.slides[0]?.hasPng).toBe(true);
      expect(preview.isReadyForLiveDelivery).toBe(false); // PDF still missing

      // Upload PDF
      admin.uploadDeckPdf(pres.id, { byteSize: 50000 });
      preview = admin.getAssetPreview(pres.id);
      expect(preview.isReadyForLiveDelivery).toBe(true);
      expect(preview.isPdfStale).toBe(false);
    });

    it('starts a live session with unique audience url and qr code (SPEC-002)', () => {
      const pres = admin.createPresentation({
        title: 'Session Test',
        slides: [{ title: 'First', horizontalIndex: 0, verticalIndex: 0, order: 0 }],
      });

      const session = admin.startLiveSession(pres.id);
      expect(session.id).toBeDefined();
      expect(session.status).toBe('live');
      expect(session.currentSlideId).toBe(pres.slides?.[0]?.id);
      expect(session.revealedSlideIds).toContain(pres.slides?.[0]?.id);
      expect(session.pdfDownloadUnlocked).toBe(false);
      expect(session.audienceUrl).toContain(session.id);
      expect(session.qrCodeDataUrl).toContain('QR_');
    });
  });

  describe('View-Model HTML Renderers', () => {
    it('renders dashboard HTML with presentations, active session join URL, QR code, and delete modal placeholder (SPEC-002)', () => {
      const pres = admin.createPresentation({ title: 'Dashboard Presentation' });
      const session = admin.startLiveSession(pres.id);
      const vm = admin.getDashboardViewModel();
      const html = renderAdminDashboardHtml(vm);

      expect(html).toContain('Dashboard Presentation');
      expect(html).toContain('Start Live Session');
      expect(html).toContain('Generate Images');
      expect(html).toContain(session.audienceUrl);
      expect(html).toContain('session-qr-code');
    });

    it('renders delete confirmation modal when open', () => {
      const pres = admin.createPresentation({ title: 'Confirm Me' });
      admin.requestDeletePresentation(pres.id);
      const html = renderDeleteConfirmationModalHtml(admin.getDeleteModalState());

      expect(html).toContain('Confirm Deletion');
      expect(html).toContain('Confirm Me');
      expect(html).toContain('Delete Presentation');
    });

    it('escapes user-controlled values in the delete confirmation modal', () => {
      const html = renderDeleteConfirmationModalHtml({
        isOpen: true,
        presentationId: 'id"><img src=x onerror=alert(1)>',
        presentationTitle: '<img src=x onerror=alert(1)>',
      });

      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img src=x');
    });

    it('renders workflow HTML with progress bar and retry alerts', () => {
      const html = renderSlideImageWorkflowHtml({
        presentationId: 'pres_1',
        revision: 'rev_1',
        totalSlides: 4,
        completedSlides: 2,
        inProgress: false,
        statusBySlideId: { s1: 'completed', s2: 'completed', s3: 'failed', s4: 'pending' },
        failedSlides: [{ slideId: 's3', slideTitle: 'Slide 3', error: 'Render error' }],
      });

      expect(html).toContain('50%');
      expect(html).toContain('2 of 4 slides processed');
      expect(html).toContain('Failed to render 1 slide(s)');
      expect(html).toContain('Retry Failed Slides');
    });

    it('renders asset preview HTML with slide thumbnails and pdf status', () => {
      const pres = admin.createPresentation({
        title: 'Preview HTML',
        slides: [{ title: 'Intro', horizontalIndex: 0, verticalIndex: 0, order: 0 }],
      });
      const preview = admin.getAssetPreview(pres.id);
      const html = renderAssetPreviewHtml(preview);

      expect(html).toContain('Asset Preview for "Preview HTML"');
      expect(html).toContain('Deck PDF:');
    });
  });
});
