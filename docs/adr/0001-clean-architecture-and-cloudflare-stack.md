# ADR 0001: Clean Architecture and Cloudflare Edge Stack

## Status
Accepted

## Date
2026-10-18

## Context
Agora requires high-throughput real-time coordination for 500–1,000 concurrent participants, ultra-low latency slide synchronization (<500ms p95), robust persistence for sessions and interaction data, and long-term maintainability. 

Traditional centralized server architectures (e.g. Node.js with Redis and PostgreSQL) incur high idle infrastructure costs, connection multiplexing overhead, and geographic latency penalties. Conversely, binding application domain logic directly to vendor-specific serverless APIs leads to brittle vendor lock-in and difficult local testing.

## Decision
1. **Clean / Hexagonal Architecture**:
   - `packages/domain` contains pure enterprise business rules with zero external dependencies.
   - `packages/application` contains use cases and ports (interfaces), depending only on `domain` and `contracts`.
   - All external infrastructure (Cloudflare Workers, Durable Objects, D1, R2, Reveal.js, React) are implemented as adapters outside `domain` and `application`.
   - Mechanical enforcement: A linter script (`harness/verify-architecture.mjs`) scans all imports in `domain` and `application` on every commit and fails if Cloudflare, React, Reveal.js, or UI libraries are referenced.

2. **Cloudflare Edge Runtime Stack**:
   - **Cloudflare Workers**: High-performance, low-latency edge routing and authentication.
   - **Durable Objects with Embedded SQLite**: Single-writer authoritative state per presentation session, managing WebSockets via the WebSocket Hibernation API and handling questions, votes, and reactions atomically in SQLite.
   - **Cloudflare D1**: Distributed relational database for administrative persistence (presentations, slides, revisions, user accounts).
   - **Cloudflare R2**: S3-compatible private object storage for slide PNGs, compiled PDFs, and media assets.

## Consequences
### Positive
- Domain and application business logic can be tested in pure Vitest unit tests in milliseconds without Cloudflare emulators or mocks.
- Durable Object SQLite provides atomic ACID transactions per presentation session without external database roundtrips.
- Cloudflare WebSocket hibernation allows 1,000 concurrent connections to idle with minimal CPU billing.
- Clear separation of concerns enables parallel development across frontend, backend, and domain packages.

### Negative / Trade-offs
- Requires strict discipline in maintaining ports and dependency inversion.
- Developers must use Cloudflare Miniflare/Wrangler for integration testing.
