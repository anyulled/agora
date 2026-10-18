# SOP: Chrome DevTools & Browser Validation Loop

> Standard Operating Procedure for validating UI interactions, responsive layouts, accessibility, and visual fidelity using Chrome DevTools.

## 1. Purpose
Provides a disciplined, repeatable loop for verifying frontend components in `apps/admin`, `apps/audience`, and `apps/presenter` before declaring features complete.

## 2. Validation Procedure

```text
[Launch Dev Server]
        │
        ▼
[1. Viewport & Device Emulation] (Mobile 375x667 for Audience; 1920x1080 for Projection)
        │
        ▼
[2. Accessibility Audit] (Lighthouse / Axe / DevTools Elements inspection)
        │
        ▼
[3. Realtime Network & WebSocket Inspection] (Verify WS frames, latency, reconnection)
        │
        ▼
[4. Console & Memory Profiling] (Zero uncaught errors, no event listener leaks)
        │
        ▼
[Record Verification Evidence]
```

### Step 1: Device Emulation
1. **Audience App (`apps/audience`)**:
   - Emulate mobile viewports (iPhone SE: 375x667, Pixel 7: 412x915).
   - Verify touch targets are at least 44x44px.
   - Verify that no slide canvas or presentation slide content is visible.
2. **Presenter & Projection View (`apps/presenter`)**:
   - Emulate 16:9 1920x1080 display.
   - Verify keyboard navigation arrows (`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`).
   - Confirm presenter controls do not leak onto projection display.

### Step 2: Accessibility Inspection
1. Inspect DOM elements with Chrome DevTools Elements tree.
2. Verify all interactive controls have accessible names (`aria-label`).
3. Verify color contrast ratios meet WCAG 2.2 AA (>= 4.5:1).
4. Verify keyboard focus ring is distinctly visible.

### Step 3: Network & WebSocket Inspection
1. Open DevTools **Network** tab, filter by **WS**.
2. Select active session socket connection and inspect **Messages** pane.
3. Validate `RealtimeEvent` envelope fields (`id`, `type`, `sessionId`, `timestamp`, `payload`).
4. Toggle "Offline" in Network panel; verify Reveal.js continues keyboard navigation without crashing.
5. Re-enable network; verify WebSocket reconnects with exponential backoff and receives `session.state`.

### Step 4: Console & Performance Verification
1. Ensure the Console tab has **zero** uncaught errors or unhandled promise rejections.
2. Ensure no duplicate event listener registrations on slide transitions.
