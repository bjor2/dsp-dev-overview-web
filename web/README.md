# DSP Dev Overview — UI (Vite + React + TS)

SPA for the DSP Dev Overview (ADR-000). Talks **only** to the overview API.

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # tsc -b && vite build → dist/
```

**Proxy:** the browser calls `/api/...`; Vite forwards to `http://localhost:5090` (override with `OVERVIEW_API=http://host:port pnpm dev`). The UI never calls DSP services, Service Bus or App Insights directly.

**API down?** Every screen shows an `ErrorBanner` (code/message, Retry if retryable). It never shows fake healthy data. The "Use demo data" button (only on `API_UNREACHABLE`) switches to `src/mocks/demo.ts` behind a yellow DEMO banner, for local design work only.

## Layout
- `src/api/types.ts`: contracts (HANDOFF + ADDENDUM, locked), plus the `APPS`/`CLOUD_ROLE_NAMES` constants
- `src/api/client.ts`: fetch wrappers + `ApiError`; `src/api/useApi.ts`: load/error/retry hook
- `src/pages/`: `ProjectListPage`, `ProjectDetailLayout` (tabs), `FlowTab`, `ServiceBusTab`, `LogsTab`, `ConsoleTab`
- `src/components/`: `SampleMessagePicker` (drawer), common (ErrorBanner, Drawer, HealthDot…)
- `src/mocks/demo.ts`: demo data (ADR-003 topology, counts 21/2/23)

Routes: `/`, `/projects/:projectId` (redirects to flow), `/projects/:projectId/{flow|service-bus|logs|console}`.

## Sources of truth
- `../../architecture/HANDOFF-ui-ux-data-contracts.md`
- `../../architecture/ADDENDUM-ui-wireframe-q.md`, `ADDENDA-001.md`, `ADR-003-flow-model.md`, `ADR-000-stack.md`
- `../COMPONENTS.md`, `../IA-customerproject.md`, `../wireframes/`

Developer TODOs are marked `TODO(Developer)` in source. See `STUBS.md`.
