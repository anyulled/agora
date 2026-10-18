# SOP: Layered Clean Domain Architecture

> Standard Operating Procedure for creating and maintaining pure domain entities, use cases, ports, and infrastructure adapters (Practice 3 & 10).

## 1. Architectural Boundaries

Agora enforces Clean Architecture across three distinct architectural layers:

```
┌────────────────────────────────────────────────────────┐
│ 1. Enterprise Domain Rules (packages/domain)           │
│    - Pure business entities, value objects             │
│    - ZERO dependencies on external frameworks          │
├────────────────────────────────────────────────────────┤
│ 2. Application Use Cases (packages/application)        │
│    - Orchestration, commands, queries, ports           │
│    - Depends ONLY on packages/domain and contracts     │
├────────────────────────────────────────────────────────┤
│ 3. Adapters & Infrastructure (apps/*, packages/*)      │
│    - Cloudflare Workers, Durable Objects, D1, R2       │
│    - React components, Reveal.js plugin, DOM capture   │
└────────────────────────────────────────────────────────┘
```

## 2. Invariant Rules
1. **Zero Framework Pollution in Core**:
   `packages/domain` and `packages/application` MUST NEVER import:
   - `cloudflare:workers`
   - `@cloudflare/workers-types`
   - `react`, `react-dom`
   - `reveal.js`
   - Any app under `apps/`
2. **Ports & Inversion of Control**:
   When application logic needs database persistence or WebSocket dispatch, declare an interface (port) in `packages/application/src/ports/`:
   ```typescript
   // packages/application/src/ports/session-repository.port.ts
   export interface SessionRepository {
     findById(id: string): Promise<PresentationSession | null>;
     save(session: PresentationSession): Promise<void>;
   }
   ```
   The concrete adapter (e.g. `DurableObjectSessionRepository`) is implemented in `apps/worker` and injected at runtime.
3. **Mechanical Verification**:
   Before every commit, run:
   ```bash
   node harness/verify-architecture.mjs
   ```
   If any prohibited import is detected, the script terminates with exit code 1 and specifies the offending file and line.
