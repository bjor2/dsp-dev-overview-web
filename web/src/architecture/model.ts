// ADDENDA-011 architecture view: pure helpers over the layer response. No React, no storage, no network.
import type {
  ArchCrumb, ArchEdge, ArchitectureLayerResponse, ArchitectureRoot, ArchLayer, ArchNode, ArchSource, FlowContainer,
} from "../api/types";

export const ARCHITECTURE_INVALID = "ARCHITECTURE_INVALID";
export const ARCHITECTURE_LAYER_NOT_FOUND = "ARCHITECTURE_LAYER_NOT_FOUND";

/** A crumb in the strip: the Flow anchor first, then the server's root … current. */
export type Crumb = { kind: "flow"; title: string } | ({ kind: "layer" } & ArchCrumb);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const sources = (v: unknown): ArchSource[] =>
  (Array.isArray(v) ? v : []).filter((s): s is ArchSource => isObj(s) && typeof s.ref === "string" && typeof s.kind === "string");

/**
 * Defensive copy of a layer the UI can render without checks: arrays always present, nodes without an id dropped,
 * edges whose endpoint is not a node of this layer skipped (the server validates; this only prevents a crash).
 */
export function safeLayer(l: ArchLayer): ArchLayer {
  const nodes: ArchNode[] = (Array.isArray(l.nodes) ? l.nodes : [])
    .filter((n): n is ArchNode => isObj(n) && typeof n.id === "string")
    .map((n) => ({
      ...n,
      label: typeof n.label === "string" && n.label ? n.label : n.id,
      boundary: n.boundary === "inside" ? "inside" : "outside",
      sources: sources(n.sources),
      uncertainties: strs(n.uncertainties),
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ArchEdge[] = (Array.isArray(l.edges) ? l.edges : [])
    .filter((e): e is ArchEdge => isObj(e) && typeof e.id === "string" && ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ ...e, label: typeof e.label === "string" ? e.label : "", sources: sources(e.sources), uncertainties: strs(e.uncertainties) }));
  return { ...l, sources: sources(l.sources), uncertainties: strs(l.uncertainties), nodes, edges };
}

/** Flow crumb + root … current (server breadcrumbs, never the visitation stack). */
export function buildCrumbs(resp: ArchitectureLayerResponse | null): Crumb[] {
  const flow: Crumb = { kind: "flow", title: "Flow" };
  if (!resp) return [flow];
  const server = Array.isArray(resp.breadcrumbs) ? resp.breadcrumbs : [{ layerId: resp.layer.id, title: resp.layer.title }];
  return [flow, ...server.map((c): Crumb => ({ kind: "layer", ...c }))];
}

/** The layer Up goes to: the parent crumb, or null at a root (Up leaves to Flow). */
export function parentLayerId(resp: ArchitectureLayerResponse | null): string | null {
  const b = resp?.breadcrumbs ?? [];
  return b.length >= 2 ? b[b.length - 2].layerId : null;
}

export const nodeById = (l: ArchLayer) => new Map(l.nodes.map((n) => [n.id, n]));
export const incidentEdges = (l: ArchLayer, nodeId: string) => l.edges.filter((e) => e.from === nodeId || e.to === nodeId);
/** The node in `layer` that opens `childLayerId` (via the response's `children`, else the node's own opensLayerId). */
export function childOpener(resp: ArchitectureLayerResponse, childLayerId: string): ArchNode | undefined {
  const viaChildren = resp.children?.find((c) => c.layerId === childLayerId)?.openedByNodeId;
  return resp.layer.nodes.find((n) => (viaChildren ? n.id === viaChildren : n.opensLayerId === childLayerId));
}

/** `sha256:9a87f845…` → `sha256:9a87…`; `version:4` unchanged. Full value goes in the tooltip. */
export function shortRevision(rev: string): string {
  const m = /^([a-z0-9]+):([0-9a-f]{12,})$/i.exec(rev);
  return m ? `${m[1]}:${m[2].slice(0, 4)}…` : rev;
}

export const RELATIONSHIP_PREFIX: Record<ArchEdge["relationship"], string> = { message: "msg", data: "data", dependency: "dep" };
export const edgeLabel = (e: ArchEdge) => `${RELATIONSHIP_PREFIX[e.relationship] ?? e.relationship} · ${e.label}`;

export const hasInvalid = (warnings: readonly string[] | undefined) => !!warnings?.some((w) => w === ARCHITECTURE_INVALID || w.startsWith(ARCHITECTURE_INVALID + ":"));

/**
 * Fixture seam: a COPY of the containers with `opensLayerId` set for every root whose flowRef.containerId exists in
 * the graph. Containers keep any opensLayerId they already had. The input array and its objects are never mutated.
 */
export function decorateContainers(containers: readonly FlowContainer[], roots: readonly ArchitectureRoot[]): FlowContainer[] {
  const byContainer = new Map(roots.filter((r) => !r.flowRef.handlerId).map((r) => [r.flowRef.containerId, r.layerId]));
  return containers.map((c) => (byContainer.has(c.id) && !c.opensLayerId ? { ...c, opensLayerId: byContainer.get(c.id) } : c));
}
