// ADDENDA-011: architecture index + layer loading for FlowTab. Optional subsystem: every failure here degrades to
// "no roots" so Flow keeps working. Never writes positions (no FlowPositionStore, no dsp-flow-pos:*, no apos:*).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { ArchitectureIndex, ArchitectureLayerResponse, ArchitectureRoot, FlowContainer } from "../api/types";
import { ARCHITECTURE_INVALID, ARCHITECTURE_LAYER_NOT_FOUND, decorateContainers, hasInvalid } from "./model";

export const FIXTURE_FLAG = "dsp-arch-fixtures";
const FIXTURE_EVENT = "dsp:arch-fixtures";

/** DEV + localStorage flag, or demo mode. Outside DEV the localStorage branch is compiled out. */
export const archFixturesEnabled = (demoMode: boolean) =>
  demoMode || (import.meta.env.DEV && localStorage.getItem(FIXTURE_FLAG) === "1");

/** DEV only: flip the fixture flag and let mounted hooks re-evaluate (window.__archTest.enable / disable). */
export function setArchFixtures(on: boolean) {
  if (!import.meta.env.DEV) return;
  if (on) localStorage.setItem(FIXTURE_FLAG, "1");
  else localStorage.removeItem(FIXTURE_FLAG);
  window.dispatchEvent(new Event(FIXTURE_EVENT));
}

export type ArchSource = "api" | "fixtures" | "none";
export interface ArchRootLink { layerId: string; title: string }

const EMPTY: ArchitectureIndex = { projectId: "", schemaVersion: 1, roots: [], warnings: [] };
const normIndex = (ix: ArchitectureIndex | null | undefined, projectId: string): ArchitectureIndex => ({
  projectId,
  schemaVersion: 1,
  roots: (Array.isArray(ix?.roots) ? ix.roots : []).filter(
    (r): r is ArchitectureRoot => !!r && typeof r.layerId === "string" && !!r.flowRef && typeof r.flowRef.containerId === "string",
  ),
  warnings: Array.isArray(ix?.warnings) ? ix.warnings.filter((w): w is string => typeof w === "string") : [],
  ...(typeof ix?.catalogHash === "string" && ix.catalogHash ? { catalogHash: ix.catalogHash } : {}),
});

/**
 * `containers` is the Flow graph's container list (never mutated). Returns, per container id, the root layer the
 * Explore affordance opens — from the Flow DTO's `opensLayerId` (real API) or from the fixture index (seam).
 */
export function useArchitecture(projectId: string, containers: readonly FlowContainer[] | undefined, flowWarnings: readonly string[] | undefined, demoMode: boolean) {
  const [index, setIndex] = useState<ArchitectureIndex>(EMPTY);
  const [source, setSource] = useState<ArchSource>("none");
  /** Set by an index warning or a 503 on a layer: affordances are removed for this session. */
  const [invalidSeen, setInvalidSeen] = useState(false);
  const [flag, setFlag] = useState(0);
  const cache = useRef(new Map<string, ArchitectureLayerResponse>());

  useEffect(() => {
    const on = () => setFlag((f) => f + 1);
    window.addEventListener(FIXTURE_EVENT, on);
    return () => window.removeEventListener(FIXTURE_EVENT, on);
  }, []);

  useEffect(() => {
    let alive = true;
    cache.current = new Map();
    setInvalidSeen(false);
    const fixtures = archFixturesEnabled(demoMode);
    const real: Promise<ArchitectureIndex> = demoMode ? Promise.resolve(EMPTY) : api.architecture(projectId).catch(() => EMPTY);
    real
      .then(async (raw) => {
        const ix = normIndex(raw, projectId);
        // A real invalid verdict always wins over the fixtures: the seam never hides ARCHITECTURE_INVALID.
        if (ix.roots.length || hasInvalid(ix.warnings) || !fixtures) return { ix, src: (ix.roots.length ? "api" : "none") as ArchSource };
        const fx = (await import("./fixtures")).fixtureIndex(projectId);
        return fx ? { ix: normIndex(fx, projectId), src: "fixtures" as ArchSource } : { ix, src: "none" as ArchSource };
      })
      .catch(() => ({ ix: normIndex(EMPTY, projectId), src: "none" as ArchSource }))
      .then(({ ix, src }) => {
        if (!alive) return;
        setIndex(ix);
        setSource(src);
      });
    return () => { alive = false; };
  }, [projectId, demoMode, flag]);

  const invalid = invalidSeen || hasInvalid(index.warnings) || hasInvalid(flowWarnings);

  const roots = useMemo(() => {
    const m = new Map<string, ArchRootLink>();
    if (invalid || !containers) return m;
    const title = new Map(index.roots.map((r) => [r.layerId, r.title]));
    const list = source === "fixtures" ? decorateContainers(containers, index.roots) : containers;
    for (const c of list)
      if (typeof c.opensLayerId === "string" && c.opensLayerId) m.set(c.id, { layerId: c.opensLayerId, title: title.get(c.opensLayerId) ?? c.opensLayerId });
    return m;
  }, [containers, index, source, invalid]);

  /** Layer lookup (fixtures or API), cached for this trip. 404 / 503 come back as ApiError. */
  const loadLayer = useCallback(async (layerId: string): Promise<ArchitectureLayerResponse> => {
    const hit = cache.current.get(layerId);
    if (hit) return hit;
    let resp: ArchitectureLayerResponse;
    if (source === "fixtures") {
      const fx = (await import("./fixtures")).fixtureLayer(projectId, layerId);
      if (!fx) throw new ApiError(404, ARCHITECTURE_LAYER_NOT_FOUND, "This layer is not in the catalog", false);
      resp = fx;
    } else {
      try {
        resp = await api.architectureLayer(projectId, layerId);
      } catch (e) {
        if (e instanceof ApiError && e.code === ARCHITECTURE_INVALID) setInvalidSeen(true);
        throw e;
      }
    }
    if (!resp || !resp.layer) throw new ApiError(404, ARCHITECTURE_LAYER_NOT_FOUND, "This layer is not in the catalog", false);
    cache.current.set(layerId, resp);
    return resp;
  }, [projectId, source]);

  const clearCache = useCallback(() => { cache.current = new Map(); }, []);

  return { roots, source, invalid, warnings: index.warnings, loadLayer, clearCache };
}
