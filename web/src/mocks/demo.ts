// DEMO DATA — local design only, shown only when "Use demo data" is on (banner says so). Never used as a fallback.
// Topology per ADR-003 / ADDENDA-001; counts 21 / 2 / 23.
import type { EntityStatus, FlowEdge, FlowGraph, FlowNode, LogEvent, ProjectSummary, SampleMessageCatalog, DlqMessage } from "../api/types";
import { CLOUD_ROLE_NAMES } from "../api/types";

export const demoProjects: ProjectSummary[] = [{
  id: "customerproject.dev", project: "customerproject", env: "dev", health: "amber",
  healthDetail: { appsUp: 2, appsTotal: 3, sbReachable: true, aiQueryOk: true },
  appCount: 3, queueCount: 6, dlqTotal: 2, registrationGeneratedAt: "2026-11-02T12:45:00+01:00",
  traceItUrl: "https://traceit-dev.sgdn.no",
}];

const sb = (a: number, d: number, owner: "project" | "shared" = "project", maxDeliveryCount: number | null = 10) => ({ activeCount: a, deadLetterCount: d, dlqHot: d > 0, owner, maxDeliveryCount });
const nodes: FlowNode[] = [
  { id: "ext:seed-messages", kind: "external", label: "seed-messages kit", scope: "local" },
  { id: "app:api", kind: "app", label: "Api :5011", scope: "both", app: { appKind: "web", port: 5011, cloudRoleName: CLOUD_ROLE_NAMES["app:api"], attached: false } },
  { id: "q:customerproject", kind: "queue", label: "customerproject", scope: "both", sb: sb(0, 0) },
  { id: "q:customerproject-ingress", kind: "queue", label: "customerproject-ingress", scope: "both", sb: sb(0, 2) },
  { id: "app:ingress", kind: "app", label: "Ingress :7240", scope: "both", app: { appKind: "func-ingress", port: 7240, cloudRoleName: CLOUD_ROLE_NAMES["app:ingress"], attached: true } },
  { id: "q:customerproject-snapshot", kind: "queue", label: "customerproject-snapshot", scope: "both", sb: sb(0, 0) },
  { id: "q:customerproject-domain", kind: "queue", label: "customerproject-domain", scope: "both", sb: sb(0, 0) },
  { id: "app:functions", kind: "app", label: "Functions :7239", scope: "both", app: { appKind: "func", port: 7239, cloudRoleName: CLOUD_ROLE_NAMES["app:functions"], attached: true } },
  { id: "t:customerproject-topic", kind: "topic", label: "customerproject-topic", scope: "both", sb: { activeCount: null, deadLetterCount: null, dlqHot: false, owner: "project", maxDeliveryCount: null } },
  { id: "q:communication", kind: "queue", label: "communication", scope: "both", sb: sb(0, 0, "shared") },
  { id: "s:customerproject-topic/local-inspect", kind: "subscription", label: "local-inspect", scope: "local", sb: sb(0, 0) },
  { id: "q:customerproject-topic-inspect", kind: "queue", label: "customerproject-topic-inspect", scope: "local", sb: sb(0, 0) },
];
let n = 0;
const ed = (from: string, to: string, kind: FlowEdge["kind"], label?: string, confidence: FlowEdge["confidence"] = "code"): FlowEdge =>
  ({ id: `e${++n}`, from, to, kind, label, scope: "both", confidence });
const inf = "inferred-from-settings" as const;
const edges: FlowEdge[] = [
  ed("ext:seed-messages", "q:customerproject-ingress", "inject", "21 ingress", "manual"),
  ed("ext:seed-messages", "q:customerproject", "inject", "2 commands", "manual"),
  ed("q:customerproject", "app:functions", "trigger", "CustomerProjectQueueHandler"),
  ed("q:customerproject-domain", "app:functions", "trigger", "CustomerProjectDomainQueueHandler"),
  ed("q:customerproject-ingress", "app:ingress", "trigger", "IngressQueueHandler"),
  ed("q:customerproject-snapshot", "app:ingress", "trigger", "SnapshotQueueHandler"),
  ed("app:api", "q:customerproject", "publish", "commands", inf),
  ed("app:api", "t:customerproject-topic", "publish", undefined, inf),
  ed("app:ingress", "q:customerproject-snapshot", "publish", undefined, inf),
  ed("app:ingress", "q:customerproject-domain", "publish", undefined, inf),
  ed("app:functions", "t:customerproject-topic", "publish", undefined, inf),
  ed("app:functions", "q:communication", "publish", undefined, inf),
  ed("t:customerproject-topic", "s:customerproject-topic/local-inspect", "subscription"),
  ed("s:customerproject-topic/local-inspect", "q:customerproject-topic-inspect", "forward"),
].map((x) => (x.from.includes("local-inspect") || x.to.includes("local-inspect") || x.from.startsWith("ext:") ? { ...x, scope: "local" as const } : x));

export const demoFlow: FlowGraph = { projectId: "customerproject.dev", layout: "auto", direction: "LR", nodes, edges, warnings: [] };

const EVENTS = ["CustomerChanged", "CustomerEmailChanged", "CustomerAddressChanged", "CustomerAgreementHeadChanged", "QuotationOrderHeadChanged", "HeaderFileChanged"];
export const demoSamples: SampleMessageCatalog = {
  projectId: "customerproject.dev", source: "local-dev/customerproject/seed-messages/Program.cs", mirroredAt: "2026-11-02T12:45:00+01:00",
  sampleProjects: [
    { index: 1, customerId: "10045871", name: "Bygg og Montasje Nordre Aker AS", orderNumber: "1000231871", active: true },
  ],
  presets: [
    { id: "ingress-all", mode: "ingress", label: "Ingress batch", targetEntityId: "q:customerproject-ingress", messageCount: 21, destructive: false },
    { id: "one", mode: "one", label: "Single ingress event", targetEntityId: "q:customerproject-ingress", messageCount: 1, params: { event: EVENTS, dataVersion: 1, projectIndex: [1, 2, 3] }, destructive: false },
    { id: "commands", mode: "commands", label: "Commands (Optimera)", targetEntityId: "q:customerproject", messageCount: 2, destructive: false },
    { id: "all", mode: "all", label: "Everything", targetEntityId: null, messageCount: 23, destructive: false },
    { id: "purge", mode: "purge", label: "Purge all customerproject queues + DLQs", targetEntityId: null, messageCount: 0, destructive: true },
  ],
  messages: [
    { presetId: "commands", subject: "SyncProjectDates", targetEntityId: "q:customerproject", applicationProperties: { TenantOptimera: true, Dsp_IsM3Cloud: true, DataSource: "M3Cloud" }, body: { Tenant: "Optimera" } },
    { presetId: "one", subject: "CustomerChanged", targetEntityId: "q:customerproject-ingress", applicationProperties: { DataSource: "M3Cloud", DataVersion: 1 }, body: { CustomerId: "10045871" } },
  ],
};

export const demoEntities: EntityStatus[] = [
  { entityId: "q:customerproject", kind: "queue", label: "customerproject", activeCount: 0, deadLetterCount: 0, dlqHot: false, owner: "project" },
  { entityId: "q:customerproject-ingress", kind: "queue", label: "customerproject-ingress", activeCount: 0, deadLetterCount: 2, dlqHot: true, owner: "project" },
  { entityId: "q:customerproject-snapshot", kind: "queue", label: "customerproject-snapshot", activeCount: 0, deadLetterCount: 0, dlqHot: false, owner: "project" },
  { entityId: "q:customerproject-domain", kind: "queue", label: "customerproject-domain", activeCount: 0, deadLetterCount: 0, dlqHot: false, owner: "project" },
  { entityId: "q:communication", kind: "queue", label: "communication", activeCount: 0, deadLetterCount: 0, dlqHot: false, owner: "shared" },
  { entityId: "t:customerproject-topic", kind: "topic", label: "customerproject-topic", activeCount: null, deadLetterCount: null, dlqHot: false, owner: "project" },
  { entityId: "s:customerproject-topic/local-inspect", kind: "subscription", label: "local-inspect", activeCount: 0, deadLetterCount: 0, dlqHot: false, owner: "project", parentEntityId: "t:customerproject-topic" },
];
export const demoDlq: DlqMessage[] = [
  { sequenceNumber: 42, messageId: "b1f0", subject: "CustomerChanged", enqueuedTime: "2026-11-02T11:40:12Z", deliveryCount: 10, applicationProperties: { DataVersion: 1 }, body: { CustomerId: "10045871" }, bodyTruncated: false, deadLetterReason: "MaxDeliveryCountExceeded", deadLetterErrorDescription: "Message could not be consumed after 10 delivery attempts." },
];
export const demoLogs: LogEvent[] = [
  { timestamp: "2026-11-02T11:41:00Z", table: "exceptions", cloudRoleName: CLOUD_ROLE_NAMES["app:ingress"], severity: 3, message: "SqlException: ...", operationId: "4bf9" },
];
