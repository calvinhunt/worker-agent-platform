# Agent + API efficiency and stability review

Date: 2026-03-22

## Scope reviewed

- `lib/agents.ts`
- `lib/task-runtime.ts`
- `lib/tasks.ts`
- `lib/store.ts`
- `lib/task-session.ts`
- `lib/resources.ts`
- `app/api/**/*.ts`

## Highest-impact opportunities

### 1) Eliminate store race conditions with atomic, serialized updates
**Why it matters:** most API handlers follow a read/modify/write pattern against a single JSON store file. Concurrent requests can silently overwrite each other (lost updates), especially for task/runs state.

**Where this shows up:**
- `readStore()` + `writeStore()` are used independently in multiple routes and task helpers.
- Examples: `app/api/agents/route.ts`, `app/api/tasks/route.ts`, `lib/tasks.ts` (`startTaskRun`, `updateTaskAfterRun`, `syncTaskArtifacts`, `setTaskStatus`), `app/api/skills/route.ts`, `app/api/context-sets/route.ts`.

**Recommendation:**
- Move all mutations to `updateStore()` and ensure it uses an in-process async mutex/queue.
- Write to a temp file + rename for atomic persistence.
- Add optimistic versioning (`store.version`) to detect stale write attempts.

---

### 2) Avoid expensive artifact recovery in global state reads
**Why it matters:** `GET /api/state` performs artifact recovery work by iterating tasks and calling `syncTaskArtifacts`, which can trigger network calls and file downloads. This can make a routine dashboard poll unexpectedly slow and variable.

**Where this shows up:**
- `app/api/state/route.ts`

**Recommendation:**
- Make `/api/state` pure and fast (metadata only).
- Move recovery into an explicit endpoint/action (`POST /api/tasks/:id/recover-artifacts`) or background job.
- If auto-recovery is required, gate it by a strict time budget and max task count.

---

### 3) Add request-level limits and stricter input validation
**Why it matters:** upload handlers accept arbitrary form payload sizes and file counts. Large submissions can degrade memory usage and increase failure rates.

**Where this shows up:**
- `app/api/agents/route.ts`, `app/api/context-sets/route.ts`, `app/api/skills/route.ts`
- `lib/resources.ts` writes full file buffers from `arrayBuffer()`.

**Recommendation:**
- Enforce limits (max files, per-file size, total size).
- Reject unsupported mimetypes/extensions early.
- Return structured validation errors for client UX and observability.

---

### 4) Parallelize independent OpenAI uploads during task readiness
**Why it matters:** context files and skills are uploaded sequentially in `ensureTaskReady`, increasing startup latency for tasks with many files.

**Where this shows up:**
- `lib/tasks.ts` (`ensureTaskReady`)

**Recommendation:**
- Use bounded concurrency (e.g., 3–5 workers) for context file uploads and skill creation.
- Persist partial progress after each successful upload to avoid repeating work after mid-flight failures.

---

### 5) Strengthen streaming lifecycle handling (abort/cancel/timeouts)
**Why it matters:** the messages stream starts long-running work but does not explicitly stop on client disconnect. This can waste tokens/compute and leave run state transitions inconsistent under abrupt network drops.

**Where this shows up:**
- `app/api/tasks/[taskId]/messages/route.ts`
- `lib/task-runtime.ts`

**Recommendation:**
- Wire request abort signals into run cancellation.
- Add explicit per-run timeout and fail-fast path.
- Ensure run status transitions are idempotent and resilient when cancellation races with completion.

---

### 6) Reduce redundant artifact I/O paths
**Why it matters:** artifact sizing and caching can trigger repeated full-content downloads.

**Where this shows up:**
- `listTaskArtifacts()` in `lib/tasks.ts` fetches content when bytes are null.
- `syncTaskArtifacts()` may then call `cacheTaskArtifacts()` and download again.

**Recommendation:**
- Prefer metadata-only listing and lazy byte computation (only when needed by UI).
- When download is needed, share a single retrieval pass for both size + cache writes.

---

## Medium-impact opportunities

### 7) Reuse lightweight sessions for title suggestions
`lib/agents.ts` creates a new `MemorySession` for every title generation. For short deterministic prompts, this may be unnecessary overhead.

**Recommendation:**
- Use stateless calls when possible, or a tiny pooled session strategy.
- Add fallback truncation/sanitization to enforce output policy (`< 6 words`) robustly.

### 8) Improve error taxonomy and response consistency
Routes currently mix generic 500/400/404 responses and inspect string messages for status mapping (e.g., expired container check by substring).

**Recommendation:**
- Introduce a shared error mapper for OpenAI/API/storage errors.
- Standardize error response format (`code`, `message`, optional `details`).

### 9) Add structured observability around critical phases
Current code has partial trace support and `console.error`, but lacks consistent metrics.

**Recommendation:**
- Emit duration + outcome metrics for: task readiness, uploads, stream runtime, artifact sync.
- Track queue depth and write duration for store/session persistence.

---

## Quick wins (low effort)

1. Replace mutable route-level read/modify/write with `updateStore()` wrappers.
2. Add configurable hard limits for uploads via env vars.
3. Make `/api/state` recovery opt-in via query flag during migration (`?recover=1`).
4. Cap shell output summaries in stream events to avoid oversized NDJSON chunks.
5. Add small retry/backoff for transient OpenAI file operations.

## Suggested implementation order

1. **Data integrity first:** serialized atomic store updates.
2. **Latency next:** remove heavy work from `/api/state`; parallelize readiness uploads.
3. **Resilience:** abort/cancel + timeout handling for run streams.
4. **Scale guardrails:** upload limits and better artifact I/O strategy.
5. **Operability:** standardized errors + metrics.
