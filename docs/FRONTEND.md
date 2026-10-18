# Agora Frontend Architecture & Standards

> Progressive Disclosure document detailing frontend specifications, accessibility, audience modes, and Reveal.js plugin integrations.

## 1. Accessibility (WCAG 2.2 AA)

Agora interfaces must be accessible to all attendees and presenters according to WCAG 2.2 AA standards:
1. **Perceivable**:
   - Contrast ratio >= 4.5:1 for standard body text and >= 3:1 for large text / UI icons.
   - Text scaling up to 200% without loss of content or functionality.
   - All interactive controls have semantic ARIA labels (`aria-label`, `aria-live`, `aria-expanded`).
2. **Operable**:
   - Keyboard accessible: All interactions in Audience and Presenter views can be driven solely with `Tab`, `Shift+Tab`, `Enter`, `Space`, and arrow keys.
   - Touch targets: Minimum 44x44 CSS pixels for all interactive mobile buttons (reactions, votes, navigation arrows).
   - Focus management: Visual focus rings with minimum 2px outline and 3:1 contrast against background.
3. **Understandable**:
   - Clear feedback states on question submission, upvoting, and poll completion.
   - Descriptive error states for network disconnection or rate limiting.
4. **Robust**:
   - Semantic HTML5 elements (`<main>`, `<nav>`, `<header>`, `<article>`, `<button>`).
   - Clean screen-reader announcements via `aria-live="polite"` for new questions and slide changes.

---

## 2. Audience Interaction Modes

The audience web application (`apps/audience`) operates in two mutually exclusive navigation modes:

### Follow Mode (Default)
- **Behavior**: Client view is strictly synchronized with the speaker's authoritative slide in real time.
- **Controls**:
  - Shows slide title and slide number.
  - "Ask Question" button opening a bottom-sheet modal.
  - Emoji reaction buttons (`👍`, `🤔`, `❤️`, `😴`).
  - Gated download button (enabled only if slide PNG is available).
  - "Solo Mode" switch button.
- **Resynchronization**: On WebSocket reconnection, client automatically requests the latest session snapshot and synchronizes to the speaker's current slide.

### Solo Mode (Self-Paced Browsing)
- **Behavior**: Allows attendees to navigate backward and forward through **revealed slides only**.
- **Controls**:
  - `Previous` and `Next` buttons.
  - Slide selector indicator: "Slide X of Y (Revealed)".
  - "Return to Speaker" banner button (jumps immediately back to current speaker slide and switches mode back to Follow).
- **Rules**:
  - Audience can ONLY browse slides whose IDs are present in `session.revealedSlideIds`.
  - Skipped slides are strictly inaccessible in Solo mode.
  - Solo navigation is entirely client-side; it does NOT send navigation events to the speaker deck or other attendees.
  - Audience can submit questions against the currently inspected revealed slide while in Solo mode.

---

## 3. RevealAudience Plugin Architecture

The `RevealAudience` plugin (`packages/reveal-plugin`) integrates Agora's real-time backend with Reveal.js:

```typescript
import Reveal from 'reveal.js';
import { RevealAudience } from '@agora/reveal-plugin';

Reveal.initialize({
  plugins: [RevealAudience],
  audience: {
    sessionId: 'sess_123',
    endpoint: 'https://api.agora.live',
    token: 'presenter_auth_token',
    role: 'presenter' // or 'projection'
  }
});
```

### Key Responsibilities
1. **Slide Event Hooks**: Listens to `slidechanged`, extracting stable metadata from `data-slide-id` and `data-title` attributes.
2. **Authoritative Sync**: If authenticated as `presenter`, transmits `slide.changed` events over WebSocket to the Durable Object.
3. **Passive Sync**: If running in `projection` mode, listens for `slide.changed` events and invokes `Reveal.slide(h, v)` to follow the presenter.
4. **Embedded Q&A Slide**: Detects slides with `data-component="audience-qa"` and mounts the interactive question list/detail component.
5. **Offline Fallback**: Catches network exceptions and ensures local Reveal.js keyboard navigation (`ArrowLeft`, `ArrowRight`, `Space`) continues uninterrupted if the server or WebSocket is unreachable.

---

## 4. Browser-Side PNG Generation (`SlideRenderer`)

Per SPEC-013, slide PNG generation is executed inside the browser without requiring heavy server-side headless Chromium instances.

### `SlideRenderer` Port & Adapter
Located in `packages/slide-export`:
```typescript
export interface SlideRenderer {
  renderSlideToPng(
    presentationId: string,
    slideId: string,
    element: HTMLElement,
    options?: SlideRenderOptions
  ): Promise<Blob>;
}
```

### Implementation Mechanics
1. **Isolation Container**: Clones the slide DOM node into an off-screen sandbox container with fixed dimensions (1920x1080).
2. **CSS & Asset Inlining**: Resolves computed CSS styles, transforms, and embedded fonts.
3. **Canvas Capture**: Uses standard SVG foreignObject or HTML5 Canvas capture techniques to rasterize the slide DOM in its **final visual state** (all fragments visible, matching post-transition appearance).
4. **Blob Upload**: Uploads the resulting PNG directly to the Cloudflare Worker `/api/v1/presentations/:id/assets` endpoint, where it is stored in Cloudflare R2 tied to the presentation revision.
5. **Fault Tolerance**: Renders slides sequentially with progress feedback; individual slide render failures are logged and can be retried individually without re-rendering the whole deck.
