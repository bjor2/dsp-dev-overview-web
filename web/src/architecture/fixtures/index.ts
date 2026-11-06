// DEV / demo fixture seam (DESIGN-flow-drilldown §5): the real v1.1 catalogs, byte copies of
// architecture/layers/<project>/*.json (parity checked with `cmp`, never generated). Loaded as raw text so the files
// stay byte-identical; only imported lazily by useArchitecture when the seam is on.
// Responses are derived the way the API proposes: roots from flowRef, children from parentLayerId (with the opener
// node), breadcrumbs root … current, rootFlowRef inherited from the root.
import type { ArchitectureIndex, ArchitectureLayerResponse, ArchLayer, ArchFlowRef } from "../../api/types";
import cpIndex from "./customerproject/index.json?raw";
import cpIngress from "./customerproject/ingress-app.json?raw";
import cpFunc from "./customerproject/func-app.json?raw";
import cpDomainUpdate from "./customerproject/func-app.domain-update.json?raw";
import cpApi from "./customerproject/api.json?raw";
import prIndex from "./price/index.json?raw";
import prFunc from "./price/func-app.json?raw";
import prIngress from "./price/ingress-app.json?raw";
import prApi from "./price/api.json?raw";
import prGetPrices from "./price/api.get-prices.json?raw";
import prApiBatch from "./price/api-batch.json?raw";

interface CatalogDoc { documentType: "architecture-catalog"; project: string; registrationId: string; layers: { id: string; path: string }[] }
interface Catalog { registrationId: string; layers: Map<string, ArchLayer> }

function catalog(indexRaw: string, files: Record<string, string>): Catalog {
  const doc = JSON.parse(indexRaw) as CatalogDoc;
  const layers = new Map<string, ArchLayer>();
  for (const entry of doc.layers) {
    const raw = files[entry.path];
    if (!raw) continue;
    const { $schema: _schema, ...layer } = JSON.parse(raw) as ArchLayer & { $schema?: string };
    if (layer.id === entry.id) layers.set(layer.id, layer); // entry.id must equal the loaded document id
  }
  return { registrationId: doc.registrationId, layers };
}

const CATALOGS: Catalog[] = [
  catalog(cpIndex, { "ingress-app.json": cpIngress, "func-app.json": cpFunc, "func-app.domain-update.json": cpDomainUpdate, "api.json": cpApi }),
  catalog(prIndex, { "func-app.json": prFunc, "ingress-app.json": prIngress, "api.json": prApi, "api.get-prices.json": prGetPrices, "api-batch.json": prApiBatch }),
];
const forProject = (projectId: string) => CATALOGS.find((c) => c.registrationId === projectId);

/** Same shape as GET /architecture; null when there is no fixture catalog for the project. */
export function fixtureIndex(projectId: string): ArchitectureIndex | null {
  const cat = forProject(projectId);
  if (!cat) return null;
  const roots = [...cat.layers.values()]
    .filter((l): l is ArchLayer & { flowRef: ArchFlowRef } => l.parentLayerId === null && !!l.flowRef)
    .map((l) => ({ layerId: l.id, title: l.title, flowRef: l.flowRef }));
  return { projectId, schemaVersion: 1, roots, warnings: [] };
}

/** Same shape as GET /architecture/layer; null = 404 (unknown project or layer). */
export function fixtureLayer(projectId: string, layerId: string): ArchitectureLayerResponse | null {
  const cat = forProject(projectId);
  const layer = cat?.layers.get(layerId);
  if (!cat || !layer) return null;
  const chain: ArchLayer[] = [];
  for (let l: ArchLayer | undefined = layer; l && chain.length <= cat.layers.size; l = l.parentLayerId ? cat.layers.get(l.parentLayerId) : undefined)
    chain.unshift(l);
  const root = chain[0];
  if (!root.flowRef || root.parentLayerId !== null) return null; // broken chain: treat like the API's validation reject
  const children = [...cat.layers.values()]
    .filter((c) => c.parentLayerId === layer.id)
    .map((c) => ({ layerId: c.id, title: c.title, openedByNodeId: layer.nodes.find((n) => n.opensLayerId === c.id)?.id ?? "" }))
    .sort((a, b) => (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0));
  return {
    projectId, schemaVersion: 1, layer, rootFlowRef: root.flowRef,
    breadcrumbs: chain.map((l) => ({ layerId: l.id, title: l.title })),
    children, warnings: [],
  };
}
