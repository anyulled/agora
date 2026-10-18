# Agora Product Sense & Boundaries

> Progressive Disclosure document outlining the core product vision, guardrails, and explicit boundaries.

## 1. Product Vision & Mission

Agora turns passive conference audiences into active, engaged participants while keeping the speaker in complete, confident control of their presentation. 

Unlike traditional audience response systems that display the speaker's slides directly on attendee smartphones (causing attendees to look down at their devices instead of engaging with the live room), Agora provides **slide-contextual interaction**—giving attendees slide titles, numbers, question boxes, and reactions without duplicating the slide canvas on mobile screens.

---

## 2. Core Product Principles

1. **Speaker is Authoritative**:
   The speaker directs the pace and narrative. Audience reactions, votes, and suggestions inform the speaker, but never override navigation or disrupt presentation flow without explicit presenter confirmation.
2. **Room Engagement Over Screen Glare**:
   The audience app is lightweight and minimal. It avoids slide mirroring so attendees stay visually connected to the speaker and the main projector screen.
3. **Fail-Safe Live Presentations**:
   A live conference cannot stop because of Wi-Fi drops. If the edge network, Durable Object, or attendee connection fails, the Reveal.js slide deck continues operating locally with keyboard navigation without hitching.
4. **Contextual Slide Anchoring**:
   Questions, reactions, and downloads are tied to specific slides (by stable slide ID), ensuring discussions remain organized, focused, and historically clear.
5. **Frictionless Anonymous Onboarding**:
   Attendees must not be forced to register, download native apps, or provide email addresses. Joining requires only scanning a QR code or visiting a short URL to receive an anonymous, session-scoped token.

---

## 3. Explicit Boundaries & Non-Goals (MVP Scope)

To maintain sharp focus and deliver a robust MVP, the following features are explicitly out of scope:

| Feature / Capability | Status | Rationalization |
|---|---|---|
| **Audience Slide Mirroring** | **PROHIBITED** | Violates Core Principle 2. Audience should watch the stage. |
| **Server-Side Chromium PDF/PNG Export** | **PROHIBITED** | Expensive, brittle, and unnecessary. Handled via browser DOM capture and native Reveal.js print PDF. |
| **Fragment-Specific Q&A** | Post-MVP | Questions anchor to the slide as a whole; fragment granularity creates unnecessary cognitive load. |
| **Speaker Notes Sync** | Post-MVP | Speaker notes integration is deferred to maintain minimal presenter view complexity. |
| **Excluding Skipped Slides from Full PDF** | Post-MVP | MVP exported PDF includes all slides in deck order, including any branches skipped during delivery. |
| **Attendee-to-Attendee Direct Chat** | Out of Scope | Agora is a presentation interaction platform, not a general chat application. Keeps moderation overhead minimal. |
| **Speaker-Only Content Redaction** | Post-MVP | Presentations delivered on public projection are considered public to attendees; advanced DRM is out of scope. |
