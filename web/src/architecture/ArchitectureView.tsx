// ADDENDA-011 architecture mode (DESIGN-flow-drilldown §3.2–3.6). Own SVG (svg.architecture) with its own pan / wheel
// zoom / Fit, reset on every entry. Static and conceptual: no activity classes, no animation. Nodes can be dragged
// (alone or as a shift-selection); positions are this browser's own, per layer (localPositions.ts,
// dsp-arch-pos:v1:…), overlaid on the auto-layout. Flow state and Flow positions live in FlowTab and are never
// touched from here.
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ApiError } from "../api/client";
import type { ArchFlowRef, ArchitectureLayerResponse, ArchNode } from "../api/types";
import { ErrorBanner } from "../components/common";
import { NODE_FONT, fitSvgLabel } from "../pages/flow/labels";
import Breadcrumbs from "./Breadcrumbs";
import CaveatPanel, { type ArchSelection } from "./CaveatPanel";
import { FRAME_TAB, NH, NW, archEdgePath, layerBounds, layerFrame, layoutLayer, type Box, type XY } from "./layout";
import { archPosKey, archPosRange, clampArchPos, clearArchPositions, loadArchPositions, mergeArchPositions, type ArchPosMap } from "./localPositions";
import { ARCHITECTURE_INVALID, ARCHITECTURE_LAYER_NOT_FOUND, buildCrumbs, edgeLabel, parentLayerId, safeLayer, type Crumb } from "./model";

export type LeaveFocus = { focus?: "origin" | string };
export interface ArchViewState { layerId: string; breadcrumbs: Crumb[]; rootFlowRef: ArchFlowRef | null; loading: boolean; error: string | null }

interface Props {
  /** "project.env"; scopes this browser's saved node positions. */
  projectId: string;
  layerId: string;
  loadLayer: (layerId: string) => Promise<ArchitectureLayerResponse>;
  onOpen: (layerId: string) => void;
  /** Back to Flow. `focus: "origin"` selects rootFlowRef; any other string selects that Flow entity. */
  onLeave: (opts?: LeaveFocus & { rootFlowRef?: ArchFlowRef }) => void;
  /** Whether a Flow entity id exists in the current Flow graph (scope). */
  canFocus: (id: string) => boolean;
  fixtures: boolean;
  onState?: (s: ArchViewState) => void;
}

const ZMIN = 0.15, ZMAX = 3;
const LABEL_FONT = { font: "10.5px system-ui, sans-serif", letterSpacing: 0 };
const KIND_LINE: Record<ArchNode["kind"], string> = { component: "component", store: "store", contract: "contract", external: "external" };
type View = { x: number; y: number; k: number };
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
/** A pointerdown→up that moved less than this (px) is a click, not a drag (same as Flow). */
const CLICK_SLOP = 3;
const isClick = (sx: number, sy: number, ev: PointerEvent) => Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_SLOP;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
/** Window listeners for one pointer until it is released or cancelled. */
function trackPointer(pointerId: number, onMove: ((ev: PointerEvent) => void) | null, onEnd: (ev: PointerEvent) => void) {
  const move = (ev: PointerEvent) => { if (ev.pointerId === pointerId) onMove?.(ev); };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    onEnd(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
/** One node drag: start positions of every dragged id (same delta for all), last target once past CLICK_SLOP. */
type Drag = { key: string; known: ReadonlySet<string>; origin: ArchPosMap; sx: number; sy: number; k: number; last: ArchPosMap | null };

/** Kind-specific shape cue drawn under the label (no `.node` class anywhere). */
function NodeShape({ n }: { n: ArchNode }) {
  switch (n.kind) {
    case "store":
      return (
        <>
          <rect className="arch-shape" width={NW} height={NH} rx={8} />
          <path className="arch-cue" d={`M8,7 Q${NW / 2},15 ${NW - 8},7 M8,11 Q${NW / 2},19 ${NW - 8},11`} />
        </>
      );
    case "contract":
      return (
        <>
          <path className="arch-shape" d={`M0,0 H${NW - 14} L${NW},14 V${NH} H0 Z`} />
          <path className="arch-cue" d={`M${NW - 14},0 V14 H${NW}`} />
        </>
      );
    case "external":
      return <rect className="arch-shape" width={NW} height={NH} rx={3} />;
    default:
      return <rect className="arch-shape" width={NW} height={NH} rx={8} />;
  }
}

function ArchitectureLegend({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(true);
  const box = (cls: string) => <svg width="22" height="12" className="architecture-legend-swatch"><rect className={cls} x="1" y="1" width="20" height="10" rx="2" /></svg>;
  return (
    <div ref={rootRef} className="architecture-legend" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="ghost legend-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "▾ Legend" : "▸ Legend"}</button>
      {open && (
        <div className="architecture-legend-body">
          <div>{box("sw-component")} inside component</div>
          <div>{box("sw-store")} store</div>
          <div>{box("sw-contract")} contract</div>
          <div>{box("sw-external")} external</div>
          <div>{box("sw-boundary")} boundary frame (this container's responsibility)</div>
          <div><svg width="26" height="10"><line className="sw-edge" x1="1" y1="5" x2="25" y2="5" /></svg> dashed grey = conceptual relationship (message / data / dependency), not execution or observed traffic</div>
          <div><span className="arch-explore-chip-legend">▸ Explore</span> opens a deeper layer · <span className="arch-warn">⚠</span> caveats recorded (see panel)</div>
          <div className="muted">outside = outside this compute boundary, not necessarily another team</div>
        </div>
      )}
    </div>
  );
}

function ArchitectureCanvas({ projectId, layerId, loadLayer, onOpen, onLeave, canFocus, fixtures, onState }: Props) {
  const [resp, setResp] = useState<ArchitectureLayerResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<ArchSelection>(null);
  /** Multi-selection (node ids): shift+click toggles, shift+drag marquee adds, dragging a member moves all of it. */
  const [multi, setMulti] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [marquee, setMarquee] = useState<Box | null>(null);
  /** Positions dragged during this visit, for the layer whose storage key is `key` (the source of truth until reload). */
  const [moved, setMoved] = useState<{ key: string; pos: ArchPosMap }>({ key: "", pos: {} });
  /** Bumped by Reset so the stored map is read again (now empty). */
  const [storeNonce, setStoreNonce] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  /** Set when a pointer gesture on a node was a drag, so the click that follows it neither opens nor selects. */
  const suppressClick = useRef(false);

  /** Clears multi-selection AND the focus (outline + panel section). Esc, empty-canvas click, Reset. */
  const clearSelection = useCallback(() => {
    setMulti((m) => (m.size ? EMPTY_SELECTION : m));
    setSelection(null);
  }, []);
  const toggleMulti = (id: string) =>
    setMulti((m) => {
      const next = new Set(m);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSelection(null);
    setMulti(EMPTY_SELECTION);
    setMarquee(null);
    setConfirmReset(false);
    drag.current = null;
    loadLayer(layerId)
      .then((r) => { if (alive) setResp({ ...r, layer: safeLayer(r.layer) }); })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", String(e), true)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [layerId, loadLayer, attempt]);

  /** Only the response for the requested layer is drawn; the previous one only keeps the crumbs clickable. */
  const current = resp && resp.layer.id === layerId && !error ? resp : null;
  const auto = useMemo(() => (current ? layoutLayer(current.layer.nodes, current.layer.edges) : null), [current]);
  const crumbs = useMemo(() => buildCrumbs(resp), [resp]);
  const posKey = archPosKey(projectId, layerId);
  const known = useMemo<ReadonlySet<string>>(() => new Set(current?.layer.nodes.map((n) => n.id) ?? []), [current]);
  // Re-read on every (re-)entry: `current` is a fresh object per load. Stale ids / bad coordinates are dropped here.
  /** Safe drag/storage range: auto-layout AABB + ARCH_POS_MARGIN (see localPositions.ts). */
  const posRange = useMemo(() => (auto ? archPosRange(auto.bounds) : null), [auto]);
  const stored = useMemo(
    () => (current && posRange ? loadArchPositions(posKey, known, posRange) : {}),
    [current, posKey, known, storeNonce, posRange],
  );
  /** Auto-layout, then saved positions, then this visit's drags. Absolute in the layer: frame and edges derive from it. */
  const layout = useMemo(() => {
    if (!current || !auto) return null;
    const pos: Record<string, XY> = { ...auto.pos, ...stored, ...(moved.key === posKey ? moved.pos : {}) };
    const frame = layerFrame(current.layer.nodes, pos);
    return { pos, frame, bounds: layerBounds(pos, frame) };
  }, [current, auto, stored, moved, posKey]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    onState?.({ layerId, breadcrumbs: current ? crumbs : [], rootFlowRef: current?.rootFlowRef ?? null, loading, error: error?.code ?? null });
  }, [onState, layerId, current, crumbs, loading, error]);

  const fit = useCallback(() => {
    const svg = svgRef.current, layout = layoutRef.current;
    if (!svg || !layout) return;
    const r = svg.getBoundingClientRect();
    const b = layout.bounds, pad = 32, gap = 8;
    // Same idea as Flow's fit: the legend overlays the bottom-left corner, so reserve it as a bottom or a left inset,
    // whichever leaves the layer larger.
    const lg = legendRef.current?.getBoundingClientRect();
    const insets = lg && lg.width > 0 && lg.height > 0
      ? [{ left: 0, bottom: r.bottom - lg.top + gap }, { left: lg.right - r.left + gap, bottom: 0 }]
      : [{ left: 0, bottom: 0 }];
    const fitFor = ({ left, bottom }: { left: number; bottom: number }) => {
      const aw = Math.max(1, r.width - left - pad * 2), ah = Math.max(1, r.height - bottom - pad * 2);
      const k = Math.min(ZMAX, Math.max(ZMIN, Math.min(aw / b.w, ah / b.h, 1.4)));
      return { k, x: left + (r.width - left - b.w * k) / 2 - b.x * k, y: (r.height - bottom - b.h * k) / 2 - b.y * k };
    };
    setView(insets.map(fitFor).reduce((best, v) => (v.k > best.k ? v : best)));
  }, []);
  // Fit on entry only (each load gives a new auto-layout), never while nodes are dragged.
  useEffect(() => { if (auto) requestAnimationFrame(fit); }, [auto, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    setView((v) => {
      const k = Math.min(ZMAX, Math.max(ZMIN, v.k * factor));
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });
  }, []);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const up = useCallback(() => {
    const parent = parentLayerId(current ?? resp);
    // In an error state the last good layer is the way back (it is the one that linked here).
    if (!current && resp && resp.layer.id !== layerId) return onOpen(resp.layer.id);
    if (parent) onOpen(parent);
    else onLeave();
  }, [current, resp, layerId, onOpen, onLeave]);
  const viewInFlow = useCallback(() => onLeave({ focus: "origin", rootFlowRef: (current ?? resp)?.rootFlowRef }), [onLeave, current, resp]);

  // Backspace / Alt+↑ go up, Esc clears multi-selection and focus (Flow's own Esc handler is off in this mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); up(); }
      else if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [up, clearSelection]);

  // Background pointerdown: shift → marquee; otherwise pan. A plain click on the empty canvas clears multi + focus.
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || drag.current) return;
    if (e.shiftKey) return beginMarquee(e);
    const sx = e.clientX, sy = e.clientY, v0 = view;
    trackPointer(
      e.pointerId,
      (ev) => setView((v) => ({ ...v, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy })),
      (ev) => { if (ev.type === "pointerup" && isClick(sx, sy, ev)) clearSelection(); },
    );
  };

  /** Shift+drag on the empty canvas: on release every node whose box intersects the marquee is ADDED to the selection. */
  const beginMarquee = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const v = view;
    const toLayer = (cx: number, cy: number): XY => ({ x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k });
    const a = toLayer(e.clientX, e.clientY);
    const boxTo = (ev: PointerEvent): Box => {
      const b = toLayer(ev.clientX, ev.clientY);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    };
    trackPointer(
      e.pointerId,
      (ev) => setMarquee(boxTo(ev)),
      (ev) => {
        setMarquee(null);
        if (ev.type !== "pointerup" || isClick(e.clientX, e.clientY, ev)) return; // shift+click on empty canvas: no-op
        const m = boxTo(ev);
        const hits = Object.entries(layoutRef.current?.pos ?? {}).filter(([, p]) => overlaps(m, { x: p.x, y: p.y, w: NW, h: NH })).map(([id]) => id);
        if (hits.length) setMulti((s) => new Set([...s, ...hits]));
      },
    );
  };

  /**
   * Node pointerdown. Shift: nothing moves (the click toggles the multi-selection). Otherwise a drag once the pointer
   * passes CLICK_SLOP: a member of the multi-selection moves all of it by the same delta, any other node clears the
   * multi-selection and moves alone. A drag never opens or selects through the click that follows; on release the
   * dragged positions are merged into this layer's localStorage key.
   */
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation(); // no background pan
    if (e.button !== 0 || drag.current || !layout || !posRange) return;
    suppressClick.current = false;
    const sx = e.clientX, sy = e.clientY;
    if (e.shiftKey) {
      trackPointer(e.pointerId, null, (ev) => { if (!isClick(sx, sy, ev)) suppressClick.current = true; });
      return;
    }
    const group = multi.has(id);
    if (!group) setMulti((m) => (m.size ? EMPTY_SELECTION : m));
    const ids = group ? [...multi] : [id];
    const origin: ArchPosMap = Object.fromEntries(ids.filter((i) => layout.pos[i]).map((i) => [i, layout.pos[i]]));
    const d: Drag = { key: posKey, known, origin, sx, sy, k: view.k, last: null };
    drag.current = d;
    const el = e.currentTarget as Element;
    try { el.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
    const range = posRange!;
    const targets = (ev: PointerEvent): ArchPosMap =>
      Object.fromEntries(Object.entries(d.origin).map(([i, p]) => [i, clampArchPos({ x: p.x + (ev.clientX - d.sx) / d.k, y: p.y + (ev.clientY - d.sy) / d.k }, range)]));
    const apply = (p: ArchPosMap) => setMoved((m) => ({ key: d.key, pos: { ...(m.key === d.key ? m.pos : {}), ...p } }));
    trackPointer(
      e.pointerId,
      (ev) => {
        if (drag.current !== d) return;
        if (!d.last && isClick(sx, sy, ev)) return;
        d.last = targets(ev);
        apply(d.last);
      },
      (ev) => {
        try { el.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
        if (drag.current !== d) return;
        drag.current = null;
        if (!d.last) return; // a click: onClick opens / selects
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (ev.type === "pointerup") d.last = targets(ev);
        apply(d.last);
        mergeArchPositions(d.key, d.last, d.known, range);
        setSelection({ kind: "node", id });
      },
    );
  };
  /** Click (no drag): shift toggles the multi-selection, alt selects, otherwise an opener drills and any other node selects. */
  const onNodeClick = (ev: React.MouseEvent, n: ArchNode) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (ev.shiftKey) toggleMulti(n.id);
    else if (ev.altKey || !n.opensLayerId) setSelection({ kind: "node", id: n.id });
    else onOpen(n.opensLayerId);
  };

  /** Reset = this layer's auto-layout: only this layer's key is removed (other layers / projects / Flow untouched). */
  const resetLayout = () => {
    setConfirmReset(false);
    drag.current = null;
    clearArchPositions(posKey);
    setMoved({ key: posKey, pos: {} });
    setStoreNonce((n) => n + 1);
    clearSelection();
    requestAnimationFrame(fit);
  };

  const layer = current?.layer;
  const edgeText = useMemo(
    () => new Map((current?.layer.edges ?? []).map((e) => [e.id, {
      tip: `${edgeLabel(e)}\n${e.description}${e.uncertainties.length ? "\n⚠ " + e.uncertainties.join("\n⚠ ") : ""}`,
      text: fitSvgLabel(edgeLabel(e), 160, LABEL_FONT).text,
    }])),
    [current],
  );
  const edgeGeo = useMemo(() => {
    if (!current || !layout) return [];
    return current.layer.edges.flatMap((e) => {
      const a = layout.pos[e.from], b = layout.pos[e.to], t = edgeText.get(e.id);
      if (!a || !b || !t) return [];
      const { d, mid } = archEdgePath(a, b);
      return [{ e, d, mid, tip: t.tip, text: t.text, isSel: false }];
    });
  }, [current, layout, edgeText]).map((g) => ({ ...g, isSel: selection?.kind === "edge" && selection.id === g.e.id }));
  const targetTitle = resp?.children.find((c) => c.layerId === layerId)?.title ?? resp?.breadcrumbs.find((c) => c.layerId === layerId)?.title ?? "layer";
  const title = layer ? `${layer.title} · scope ${layer.scope}` : "";
  const notFound = error && (error.status === 404 || error.code === ARCHITECTURE_LAYER_NOT_FOUND);
  const invalid = error && error.code === ARCHITECTURE_INVALID;

  return (
    <div className="architecture-mode" data-layer={layerId} data-depth={current?.breadcrumbs.length ?? 0}>
      <div className="toolbar architecture-toolbar">
        <Breadcrumbs crumbs={crumbs} onFlow={() => onLeave()} onOpen={onOpen} onUp={up} onViewInFlow={viewInFlow} />
        <span className="spacer" />
        <button type="button" onClick={fit} title="Fit this layer in view">Fit</button>
        <button type="button" onClick={() => zoomAt(1 / 1.2)} title="Zoom out">−</button>
        <button type="button" onClick={() => zoomAt(1.2)} title="Zoom in">+</button>
        <span className="muted zoom-pct">{Math.round(view.k * 100)}%</span>
        {multi.size > 0 && <span className="muted selection-count">{multi.size} selected</span>}
        {confirmReset ? (
          <span className="inline-confirm" role="alertdialog" aria-label="Reset this layer's positions?">
            Reset this layer?
            <button type="button" className="danger arch-reset-yes" onClick={resetLayout}>Yes</button>
            <button type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="arch-reset" onClick={() => setConfirmReset(true)} disabled={!current}
            title="Asks first; forgets the node positions saved in this browser for this layer only and returns to the auto-layout">
            Reset layout
          </button>
        )}
        {fixtures && <span className="muted arch-fixtures-note" title="Served from the SPA's copy of architecture/layers (DEV fixture seam), not from the API">architecture: fixtures</span>}
      </div>
      <div className="architecture-wrap">
        <div className="architecture-canvas">
          <svg ref={svgRef} className="architecture" onPointerDown={onBgPointerDown} role="img" aria-label={layer ? `Architecture: ${layer.title}` : "Architecture"}>
            <defs>
              <marker id="arrArch" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0L10,5L0,10z" className="arch-arrow" />
              </marker>
              <pattern id="archDots" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#e2e8f0" />
              </pattern>
            </defs>
            <rect className="arch-bg" width="100%" height="100%" fill="url(#archDots)" />
            {layer && layout && (
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {layout.frame && (
                  <g className="arch-boundary-group">
                    <rect className="arch-boundary" x={layout.frame.x} y={layout.frame.y} width={layout.frame.w} height={layout.frame.h} rx={12} />
                    <text className="arch-boundary-title" x={layout.frame.x + 14} y={layout.frame.y + FRAME_TAB - 6}>
                      {fitSvgLabel(title, layout.frame.w - 28, NODE_FONT).text}
                      <title>{title}</title>
                    </text>
                  </g>
                )}
                {edgeGeo.map(({ e, d, tip, isSel }) => (
                  <g key={e.id} className={`arch-edge-group${isSel ? " arch-selected" : ""}`} data-id={e.id} data-relationship={e.relationship}
                    onPointerDown={(ev) => ev.stopPropagation()} onClick={() => setSelection({ kind: "edge", id: e.id })}>
                    <path className="arch-edge" d={d} markerEnd="url(#arrArch)" data-kind="conceptual"><title>{tip}</title></path>
                  </g>
                ))}
                {layer.nodes.map((n) => {
                  const p = layout.pos[n.id];
                  if (!p) return null;
                  const isSel = selection?.kind === "node" && selection.id === n.id;
                  const inMulti = multi.has(n.id);
                  const opener = !!n.opensLayerId;
                  const label = fitSvgLabel(n.label, NW - 16 - (opener ? 64 : 0) - (n.uncertainties.length ? 14 : 0), NODE_FONT);
                  return (
                    <g key={n.id}
                      className={`arch-node arch-kind-${n.kind} arch-${n.boundary}${isSel ? " arch-selected" : ""}${inMulti ? " arch-multi" : ""}${opener ? " arch-opener" : ""}`}
                      data-id={n.id} data-kind={n.kind} data-boundary={n.boundary} data-opens={n.opensLayerId}
                      data-selected={inMulti ? "true" : undefined}
                      transform={`translate(${p.x},${p.y})`}
                      onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
                      onClick={(ev) => onNodeClick(ev, n)}
                      {...(opener ? {
                        tabIndex: 0, role: "button", "aria-label": `Explore ${n.label}`,
                        onKeyDown: (ev: React.KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpen(n.opensLayerId!); } },
                        onFocus: () => setSelection({ kind: "node", id: n.id }),
                      } : {})}
                    >
                      <title>{`${n.label} (${n.kind}, ${n.boundary})\n${n.responsibility}${opener ? "\nClick to explore the deeper layer (alt+click selects)" : ""}\nDrag to move · shift+click adds to the selection`}</title>
                      <NodeShape n={n} />
                      <text className="arch-t1" x={10} y={n.kind === "store" ? 30 : 22}>{label.text}</text>
                      <text className="arch-t2" x={10} y={n.kind === "store" ? 44 : 38}>{KIND_LINE[n.kind] ?? n.kind}{n.boundary === "outside" ? " · outside" : ""}</text>
                      {n.uncertainties.length > 0 && (
                        <text className="arch-warn arch-node-warn" x={NW - (opener ? 76 : 16)} y={18}><title>{n.uncertainties.join("\n")}</title>⚠</text>
                      )}
                      {opener && (
                        <g className="arch-explore-chip" transform={`translate(${NW - 66},-9)`}>
                          <rect width={62} height={18} rx={9} />
                          <text x={31} y={12.5} textAnchor="middle">▸ Explore</text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
                {/* Labels last so a node never hides one; white halo keeps them readable over edges. */}
                <g className="arch-edge-labels">
                  {edgeGeo.map(({ e, mid, tip, isSel, text }) => (
                    <text key={e.id} className={`arch-edge-label${isSel ? " arch-selected" : ""}`} data-edge={e.id} x={mid.x} y={mid.y + 3.5} textAnchor="middle"
                      onPointerDown={(ev) => ev.stopPropagation()} onClick={() => setSelection({ kind: "edge", id: e.id })}>
                      {e.uncertainties.length > 0 && <tspan className="arch-warn">⚠ </tspan>}{text}
                      <title>{tip}</title>
                    </text>
                  ))}
                </g>
              </g>
            )}
          </svg>
          {loading && <div className="architecture-overlay">Loading {targetTitle}…</div>}
          {!loading && notFound && (
            <div className="architecture-overlay arch-error" role="alert">
              This layer is not in the catalog. <button type="button" onClick={up}>↑ Up</button> <button type="button" onClick={() => onLeave()}>Flow</button>
            </div>
          )}
          {!loading && invalid && (
            <div className="architecture-overlay arch-error" role="alert">
              Architecture catalog is invalid; Flow is unaffected. <button type="button" onClick={() => onLeave()}>Flow</button>
            </div>
          )}
          {!loading && error && !notFound && !invalid && (
            <div className="architecture-overlay"><ErrorBanner error={error} onRetry={() => setAttempt((a) => a + 1)} /> <button type="button" onClick={() => onLeave()}>Flow</button></div>
          )}
          <ArchitectureLegend rootRef={legendRef} />
        </div>
        {current ? (
          <CaveatPanel
            resp={current}
            selection={selection}
            onSelect={setSelection}
            onOpen={onOpen}
            onFlowEntity={(id) => onLeave({ focus: id })}
            canFocus={canFocus}
          />
        ) : (
          <aside className="side-panel architecture-panel"><p className="muted">{loading ? "Loading…" : "No layer loaded."}</p></aside>
        )}
      </div>
    </div>
  );
}

/** Any exception inside the architecture view stays here; Flow state lives in FlowTab and is untouched. */
class ArchitectureBoundary extends Component<{ onLeave: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error("Architecture view failed", e, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="banner error" role="alert">
        Architecture view failed. <button type="button" onClick={this.props.onLeave}>Flow</button>
      </div>
    );
  }
}

export default function ArchitectureView(props: Props) {
  return (
    <ArchitectureBoundary onLeave={() => props.onLeave()}>
      <ArchitectureCanvas {...props} />
    </ArchitectureBoundary>
  );
}
