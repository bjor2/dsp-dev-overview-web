// Normalised view of the v2 FlowGraph contract (ADDENDA-008 §6 + §11). src/api/types carries the wire shapes;
// this module fills in the optional v2 fields so the layout/render code never has to check for them.
import type { FlowContainer, FlowEdge, FlowGraph, FlowNode, HandlerInfo, LayoutHints, SelfRequeue } from "../../api/types";

export type { FlowAppInfo, FlowContainer, HandlerInfo, LayoutHints, SelfRequeue } from "../../api/types";

export type XY = { x: number; y: number };
export type PosMap = Record<string, XY>;
/** Axis-aligned box in graph coordinates, tagged with the graph id it belongs to. */
export type Rect = { id: string; x: number; y: number; w: number; h: number };

/** Kept as the name the flow code uses; identical to the wire FlowNode now that types.ts is v2. */
export type V2Node = FlowNode;
/** FlowGraph with the optional v2 fields guaranteed present (see normalizeGraph). */
export type V2Graph = FlowGraph & { containers: FlowContainer[]; layoutHints: LayoutHints };

export const DEFAULT_PADDING = 16;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Normalise a raw /flow payload (v1 or v2) into V2Graph:
 * - containers[] (empty on v1), containerId only kept when the container exists,
 * - handler.selfRequeue always an array,
 * - edges dropped when from===to, when an endpoint is `container:*`, or when an endpoint is not a node
 *   (covers `app:*` on v2, where apps are no longer nodes; v1 app nodes keep their edges).
 */
export function normalizeGraph(g: FlowGraph): V2Graph {
  const containers: FlowContainer[] = (Array.isArray(g.containers) ? g.containers : [])
    .filter((c): c is FlowContainer => isObj(c) && typeof c.id === "string")
    .map((c) => ({
      ...c,
      label: typeof c.label === "string" && c.label ? c.label : c.id.replace(/^container:/, ""),
      kind: c.kind === "logical" ? "logical" : "resource",
      resourceRefs: Array.isArray(c.resourceRefs) ? c.resourceRefs.filter((r) => typeof r === "string") : [],
      position: isObj(c.position) && typeof c.position.x === "number" && typeof c.position.y === "number" ? { x: c.position.x, y: c.position.y } : undefined,
    }));
  const cids = new Set(containers.map((c) => c.id));
  const nodes: FlowNode[] = (Array.isArray(g.nodes) ? g.nodes : []).map((n) => {
    const containerId = typeof n.containerId === "string" && cids.has(n.containerId) ? n.containerId : undefined;
    const h = isObj(n.handler) ? n.handler : undefined;
    const handler: HandlerInfo | undefined = h
      ? {
          ...h,
          selfRequeue: (Array.isArray(h.selfRequeue) ? h.selfRequeue : []).filter((r): r is SelfRequeue => isObj(r) && typeof r.entityId === "string"),
        }
      : undefined;
    return { ...n, containerId, handler };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: FlowEdge[] = (Array.isArray(g.edges) ? g.edges : []).filter(
    (e) => e.from !== e.to && !e.from.startsWith("container:") && !e.to.startsWith("container:") && nodeIds.has(e.from) && nodeIds.has(e.to),
  );
  const hints: Partial<LayoutHints> = isObj(g.layoutHints) ? g.layoutHints : {};
  const rawLayout: string = g.layout;
  const layout: FlowGraph["layout"] = rawLayout === "stored" || rawLayout === "partial" ? rawLayout : "auto";
  return {
    ...g,
    schemaVersion: typeof g.schemaVersion === "number" ? g.schemaVersion : undefined,
    layout,
    nodes,
    edges,
    containers,
    layoutHints: {
      containerPadding: typeof hints.containerPadding === "number" && hints.containerPadding >= 0 ? hints.containerPadding : DEFAULT_PADDING,
      innerDirection: hints.innerDirection === "TB" ? "TB" : "LR",
    },
  };
}

export const selfRequeue = (n: FlowNode): SelfRequeue[] => n.handler?.selfRequeue ?? [];
export const handlerFunction = (n: FlowNode): string | undefined => n.handler?.function ?? n.handler?.functions?.[0];
