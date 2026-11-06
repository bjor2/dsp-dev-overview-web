// Contracts from architecture/HANDOFF-ui-ux-data-contracts.md + ADDENDUM-ui-wireframe-q.md (locked).
export type Health = "green" | "amber" | "red" | "unknown";
export interface ProjectSummary {
  id: string; project: string; env: "dev"; health: Health;
  healthDetail: { appsUp: number; appsTotal: number; sbReachable: boolean; aiQueryOk: boolean };
  appCount: number; queueCount: number; dlqTotal: number | null; registrationGeneratedAt: string;
  /** Slice 7 — open TraceIt externally when present. */
  traceItUrl?: string;
  /** ADDENDA-009: hint only when there is something to say. severity is info|warn, never error (render amber/neutral, not red). */
  notice?: ProjectNotice;
}
export interface ProjectNotice { code: string; severity: "info" | "warn"; message: string; missing?: number; checked?: number }
export type Scope = "local" | "cloud" | "both";
/** v2 (ADDENDA-008): `handler` replaces `app`; `app` is kept so v1 payloads/demo data still type-check. */
/** ADDENDA-009: `blobContainer` = standalone storage source (no `sb`, not peekable). */
export type NodeKind = "handler" | "queue" | "topic" | "subscription" | "blobContainer" | "external" | "app";
export interface FlowAppInfo { appKind?: string; port?: number; cloudRoleName?: string; attached?: boolean }
/** v2: apps are containers; resource containers carry `app`. `position` is ABSOLUTE and only present when stored. */
export interface FlowContainer {
  id: string; label: string; kind: "resource" | "logical";
  resourceRefs: string[];
  app?: FlowAppInfo;
  scope?: Scope;
  position?: { x: number; y: number };
  /** Option C: where `position` came from — the checked-in registration defaults or this env's runtime store. */
  positionSource?: "default" | "stored";
  /** Hint only; the UI recomputes from children + padding. Never sent by the API. */
  size?: { w: number; h: number };
  /** @deprecated ADDENDA-011.1: containers never carry opensLayerId; ignored if present. */
  opensLayerId?: string;
}
/** OQ-1: self-requeue is a badge on the handler, not an edge. */
export interface SelfRequeue { entityId: string; messages?: string[]; sources?: string[] }
/** ADDENDA-009: one entry per function. timer → `schedule` (or `setting` when the cron is an app setting); blob → `path`. */
export interface HandlerTrigger {
  kind: "servicebus" | "http" | "timer" | "blob";
  function?: string; entityId?: string; schedule?: string; setting?: string; path?: string;
}
export interface HandlerInfo {
  /** §11: singular; omitted for `*.http`. `functions[]` (§6 draft) is accepted as a fallback. */
  function?: string;
  functions?: string[];
  triggerEntityIds?: string[];
  selfRequeue: SelfRequeue[];
  /** ADDENDA-009: every handler; timer-only handlers have no inbound edge and empty triggerEntityIds. */
  triggers?: HandlerTrigger[];
  /** ADDENDA-011.1: handler-rooted architecture layer; Explore affordance when present. */
  opensLayerId?: string;
}
export interface FlowNode {
  id: string; kind: NodeKind; label: string; scope: Scope;
  /** v1 only (`kind: "app"`). v2 puts apps in `FlowGraph.containers[].app`. */
  app?: { appKind: "web" | "func" | "func-ingress"; port?: number; cloudRoleName?: string; attached: boolean };
  /** dlqHot = deadLetterCount !== null && deadLetterCount > 0 only (ADDENDA-003). Never derive from near-maxDeliveryCount. */
  /** ADDENDA-009: `state: "missing"` = not provisioned on the namespace (null counts, never dlqHot). Absent for normal entities. */
  sb?: { activeCount: number | null; deadLetterCount: number | null; dlqHot: boolean; owner: "project" | "shared"; maxDeliveryCount?: number | null; state?: "missing" };
  /** Handlers only. Absent when the container is hidden in the current scope. */
  containerId?: string;
  handler?: HandlerInfo;
  /** Handlers: RELATIVE to the container origin. Containers/standalone nodes: absolute. Only when stored. */
  position?: { x: number; y: number };
  /** Option C: where `position` came from — the checked-in registration defaults or this env's runtime store. */
  positionSource?: "default" | "stored";
}
export type EdgeKind = "trigger" | "publish" | "subscription" | "forward" | "inject";
export interface FlowEdge {
  id: string; from: string; to: string; kind: EdgeKind; label?: string; scope: Scope;
  confidence: "code" | "terraform" | "inferred-from-settings" | "manual";
  /** v2: code locations (`file:line`) the edge was derived from. */
  sources?: string[];
}
export interface LayoutHints { containerPadding: number; innerDirection: "LR" | "TB" }
export interface FlowGraph {
  projectId: string;
  /** Absent on v1 payloads (upgraded in memory by the API, which then adds a REGISTRATION_V1_UPGRADED warning). */
  schemaVersion?: number;
  /** auto = nothing stored · partial = some stored (pin those) · stored = every visible node + container stored. Informational. */
  layout: "auto" | "partial" | "stored";
  direction: "LR" | "TB";
  layoutHints?: LayoutHints;
  /** v2 only; empty/absent on v1. */
  containers?: FlowContainer[];
  nodes: FlowNode[]; edges: FlowEdge[];
  /** Non-fatal notes (e.g. SB_UNREACHABLE, FLOW_POSITIONS_UNREADABLE, REGISTRATION_V1_UPGRADED). Graph still returns. */
  warnings?: string[];
}

export type SampleMode = "all" | "ingress" | "commands" | "one" | "purge";
export interface SamplePreset {
  id: string; mode: SampleMode; label: string; targetEntityId: string | null; messageCount: number;
  params?: { event?: string[]; dataVersion?: number; projectIndex?: (1 | 2 | 3)[] }; destructive: boolean;
}
export interface SampleMessage {
  presetId: string; subject: string; targetEntityId: string;
  applicationProperties: Record<string, string | number | boolean>; body: unknown;
}
export interface SampleMessageCatalog {
  projectId: string; source: string; mirroredAt: string;
  sampleProjects: { index: 1 | 2 | 3; customerId: string; name: string; orderNumber: string; active: boolean }[];
  presets: SamplePreset[]; messages: SampleMessage[];
  /** ADDENDA-009: false = no sample kit for this project (empty catalog, send/purge return 404 SAMPLES_NOT_AVAILABLE). */
  available?: boolean; reason?: string;
}
/** ADDENDUM §3: bodyOverride = body only; applicationPropertiesOverride merges over kit props. "Reset to kit" clears both. */
export interface SampleSendRequest {
  mode: SampleMode; event?: string; dataVersion?: number; projectIndex?: 1 | 2 | 3;
  bodyOverride?: unknown;
  applicationPropertiesOverride?: Record<string, string | number | boolean>;
  targetEntityId?: string;
}
export interface SampleSendResult { sent: number; entity: string }

/** ADDENDUM §1 (locked). Includes subscriptions. */
export type SbEntityKind = "queue" | "topic" | "subscription";
export interface EntityStatus {
  entityId: string; kind: SbEntityKind; label: string;
  activeCount: number | null; deadLetterCount: number | null; dlqHot: boolean;
  owner: "project" | "shared"; parentEntityId?: string;
  /** ADDENDA-009: not provisioned on the namespace. */
  state?: "missing";
}
export interface PeekedMessage {
  sequenceNumber: number; messageId: string; subject?: string; contentType?: string; correlationId?: string;
  enqueuedTime: string; deliveryCount: number; applicationProperties: Record<string, unknown>; body: unknown; bodyTruncated: boolean;
}
export interface QueuePeek { entityId: string; activeCount: number | null; deadLetterCount: number | null; messages: PeekedMessage[] }
export interface DlqMessage extends PeekedMessage { deadLetterReason?: string; deadLetterErrorDescription?: string; deadLetterSource?: string }

export interface LogEvent {
  timestamp: string; table: "requests" | "traces" | "exceptions" | "dependencies";
  cloudRoleName: string; severity?: 0 | 1 | 2 | 3 | 4; message: string; operationId?: string; name?: string;
  durationMs?: number; success?: boolean; details?: Record<string, unknown>; traceItUrl?: string;
}
export interface ConsoleChunk { appId: string; seq: number; timestamp: string; stream: "stdout" | "stderr" | "system"; lines: string[]; attached: boolean }

/** ADDENDA-011: architecture catalog, separate from registration schema (schemaVersion 1 ≠ registration v2/v3). */
export type ArchSourceKind = "repo" | "confluence" | "registration" | "inferred";
export type ArchConfidence = "confirmed" | "inferred" | "uncertain";
export interface ArchSource { kind: ArchSourceKind; ref: string; note?: string; confidence: ArchConfidence; revision?: string }
export type ArchNodeKind = "component" | "store" | "contract" | "external";
export interface ArchNode {
  /** comp:<project>.<path> */
  id: string;
  label: string; kind: ArchNodeKind; responsibility: string;
  /** outside = outside this compute boundary, NOT "another team". */
  boundary: "inside" | "outside";
  /** Explanatory only. */
  owner?: string;
  /** Inside components only; drill one layer deeper. */
  opensLayerId?: string;
  /** Reference to an existing Flow entity; enables "View in Flow". Not a second runtime entity. */
  flowEntityId?: string;
  sources: ArchSource[]; uncertainties: string[];
}
export interface ArchEdge {
  /** aedge:<project>.<path> */
  id: string;
  from: string; to: string; kind: "conceptual";
  relationship: "message" | "data" | "dependency";
  label: string; description: string;
  sources: ArchSource[]; uncertainties: string[];
}
/** ADDENDA-011.1: roots require handlerId (must belong to containerId). */
export interface ArchFlowRef { containerId: string; handlerId?: string }
export interface ArchLayer {
  schemaVersion: 1; documentType: "architecture-layer";
  id: string; project: string; title: string; summary: string;
  /** flowRef only on roots. */
  parentLayerId: string | null; flowRef?: ArchFlowRef;
  scope: Scope; reviewedAt: string;
  sources: ArchSource[]; uncertainties: string[];
  nodes: ArchNode[]; edges: ArchEdge[];
}
export interface ArchitectureRoot { layerId: string; title: string; flowRef: ArchFlowRef }
export interface ArchitectureIndex { projectId: string; schemaVersion: 1; roots: ArchitectureRoot[]; warnings: string[]; /** Optional content fingerprint of the packaged catalog (sha256:…). */ catalogHash?: string }
export interface ArchCrumb { layerId: string; title: string }
export interface ArchChild { layerId: string; title: string; openedByNodeId: string }
export interface ArchitectureLayerResponse {
  projectId: string; schemaVersion: 1; layer: ArchLayer; rootFlowRef: ArchFlowRef;
  /** Root … current, inclusive; the UI prepends the Flow crumb. */
  breadcrumbs: ArchCrumb[];
  /** Direct children, sorted by layerId. */
  children: ArchChild[];
  warnings: string[];
}

export interface ApiErrorBody { error: { code: string; message: string; retryable: boolean } }

/** ADDENDUM §4 (locked). Logs filter chips + FlowNode.app.cloudRoleName. */
export const APPS = [
  { appId: "app:api", label: "Api", cloudRoleName: "web-870-dev-euw-dahl-customerproject" },
  { appId: "app:functions", label: "Functions", cloudRoleName: "func-870-dev-euw-dahl-customerproject" },
  { appId: "app:ingress", label: "Ingress", cloudRoleName: "func-870-dev-euw-dahl-customerproject-ingress" },
] as const;
export const CLOUD_ROLE_NAMES = Object.fromEntries(APPS.map((a) => [a.appId, a.cloudRoleName])) as Record<string, string>;
