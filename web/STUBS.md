# Stubs & assumptions (UI-0)

## Resolved by addendum (`architecture/ADDENDUM-ui-wireframe-q.md`). These are locked, not stubs.
- **EntityStatus**: the exact interface from §1, including subscriptions (`parentEntityId`). Topic counts may be `null`.
- **Console Restart**: `POST /api/projects/{id}/console/{appId}/restart` (`api.consoleRestart`). There is no client-side stop→start.
- **bodyOverride**: body only. Optional `applicationPropertiesOverride` merges over the kit props. "Reset to kit" clears both. v1 has no props editor.
- **cloudRoleNames**: Api=`web-870-dev-euw-dahl-customerproject`, Functions=`func-870-dev-euw-dahl-customerproject`, Ingress=`func-870-dev-euw-dahl-customerproject-ingress` (`APPS` in types.ts). The addendum still says to confirm these with one AI query in slice 2+.

## Remaining stubs / assumptions
- **Flow layout** is a naive longest-path layering in SVG. It should be replaced with dagre/ELK (HANDOFF Q4). Drag, `PUT /flow/positions` and "Reset layout" are not implemented yet (the button is disabled).
- **Error detection when the API is down**: Vite proxy 5xx/network failures map to `ApiError{code:"API_UNREACHABLE", retryable:true}`.
- **Console SSE**: this assumes each SSE `message` event's `data` is one JSON `ConsoleChunk` (no named event types). There is no Last-Event-ID resume yet.
- **Logs `since`**: the UI sends ISO-8601 durations (`PT15M`/`PT1H`/`PT24H`) and roles comma-joined. The backend needs to confirm the format.
- **samples/send** for `mode:"one"` sends `event`, `projectIndex` and `dataVersion`. `ingress` sends `dataVersion`. `bodyOverride` is sent only if the JSON was edited.
- **Demo data** (`src/mocks/demo.ts`) follows ADR-003/ADDENDA-001: snapshot→Ingress trigger, no Ingress→ingress-queue edge, seed inject → ingress + commands queues, local-inspect forwards to topic-inspect, counts 21/2/23. It only shows when the user opts in.

## Slice 3 Flow extras (locked)
- `FlowGraph.warnings?: string[]` — non-fatal; show banner, graph still renders.
- `FlowNode.sb.maxDeliveryCount?: number | null` — tooltip / side panel only.
- `dlqHot` = deadLetterCount > 0 only (ADDENDA-003). Never treat near-MaxDeliveryCount as hot.
