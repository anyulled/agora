# Agora UI/UX Design System & Invariants

> Progressive Disclosure document detailing Agora interface boundaries and user experience invariants.

## 1. Core UX Invariants

### Invariant 1: Audience Never Sees Slide Content
The audience interface (`apps/audience`) is designed for mobile-first participation, not passive slide viewing.
- **Allowed on Audience Screen**: Current slide title, slide number / order, question submission form, emoji reaction buttons, active poll choices, word cloud inputs, and download buttons (when revealed/unlocked).
- **Prohibited on Audience Screen**: Raw slide HTML/DOM, rendered slide canvas, slide markdown, full slide images, speaker notes, or upcoming slides.
- **Rationale**: Keeps audience attention on the live speaker and the projector in the room, prevents mobile distraction, minimizes network bandwidth, and prevents slide spoilers.

### Invariant 2: Embedded Q&A Slide Projection Invariant
When the presenter navigates to the dedicated Q&A slide (`data-component="audience-qa"`):
- The slide renders a ranked list view of audience questions with upvote counts and slide association.
- Clicking a question transitions internally to a **detail view**: question text and metadata on top, with a pre-rendered high-resolution static PNG of the referenced slide displayed underneath.
- **Critical Invariant**: Clicking a question or viewing its slide image **never navigates Reveal.js away from the Q&A slide**. The projected deck remains on the Q&A slide.
- Pressing `Escape` or clicking `Back to List` returns to the ranked question list without altering Reveal.js slide position.
- If the slide PNG has not been generated or is missing, render an informative, graceful fallback message rather than a broken image link.

### Invariant 3: Presenter Controls Never Leak to Public Projection
- The presenter controller interface (`apps/presenter`) contains real-time reaction counts, participant counts, unmoderated question queues, directional navigation buttons, and administrative actions.
- The projection screen renders only the Reveal.js presentation canvas and audience-facing interaction components (e.g. Q&A list/detail, live poll bar charts, word clouds).
- Controls, navigation buttons, and administrative buttons are strictly barred from the projection viewport.

---

## 2. Visual & Interaction Design Principles

### Typography & Readability
- Large presentation typography with high-contrast ratios (WCAG 2.2 AA compliant, minimum 4.5:1 for normal text and 3:1 for large text).
- Projector view optimized for 16:9 and 16:10 aspect ratios at 1080p and 4K resolutions.
- Mobile audience view optimized for touch targets (minimum 44x44 CSS pixels).

### Transitions & Animations
- Slide transitions are smooth and performant via CSS hardware acceleration (`transform: translate3d`).
- Audience mode transitions between Follow and Solo mode provide clear visual indicators:
  - **Follow Mode**: Displays a pulsing indicator ("Following Speaker") and updates synchronously.
  - **Solo Mode**: Displays a badge ("Browsing Slide X of Y - Tap to Re-sync with Speaker") with directional chevrons.

### Responsive Breakpoints
- **Audience PWA**: Mobile portrait (320px–480px), mobile landscape / tablet (481px–1024px).
- **Presenter View**: Tablet & laptop screens (1024px+).
- **Public Projection**: Fixed aspect scaling (1920x1080 native base).
