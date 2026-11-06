// DEV / demo fixture seam (ADDENDA-011.1): byte copies of architecture/layers/<project>/*.json.
// Roots require flowRef.handlerId; children from parentLayerId; breadcrumbs root … current.
import type { ArchitectureIndex, ArchitectureLayerResponse, ArchLayer, ArchFlowRef } from "../../api/types";
import cpIndex from "./customerproject/index.json?raw";
import cpFnIngress from "./customerproject/fn.ingress.json?raw";
import cpFnSnapshot from "./customerproject/fn.snapshot.json?raw";
import cpFnDomain from "./customerproject/fn.domain.json?raw";
import cpFnCommands from "./customerproject/fn.commands.json?raw";
import cpDomainUpdate from "./customerproject/func-app.domain-update.json?raw";
import cpApi from "./customerproject/api.json?raw";
import prIndex from "./price/index.json?raw";
import prFnIngress from "./price/fn.ingress.json?raw";
import prFnSnapshot from "./price/fn.snapshot.json?raw";
import prFnCommands from "./price/fn.commands.json?raw";
import prFnDomain from "./price/fn.domain.json?raw";
import prFnDomainIngress from "./price/fn.domain-ingress.json?raw";
import prFnBlob from "./price/fn.blob-optimera.json?raw";
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
    if (layer.id === entry.id) layers.set(layer.id, layer);
  }
  return { registrationId: doc.registrationId, layers };
}

const CATALOGS: Catalog[] = [
  catalog(cpIndex, {
    "fn.ingress.json": cpFnIngress,
    "fn.snapshot.json": cpFnSnapshot,
    "fn.domain.json": cpFnDomain,
    "fn.commands.json": cpFnCommands,
    "func-app.domain-update.json": cpDomainUpdate,
    "api.json": cpApi,
  }),
  catalog(prIndex, {
    "fn.ingress.json": prFnIngress,
    "fn.snapshot.json": prFnSnapshot,
    "fn.commands.json": prFnCommands,
    "fn.domain.json": prFnDomain,
    "fn.domain-ingress.json": prFnDomainIngress,
    "fn.blob-optimera.json": prFnBlob,
    "api.json": prApi,
    "api.get-prices.json": prGetPrices,
    "api-batch.json": prApiBatch,
  }),
];
const forProject = (projectId: string) => CATALOGS.find((c) => c.registrationId === projectId);

/** ADDENDA-011.1: roots require flowRef.handlerId. */
function isRoot(l: ArchLayer): l is ArchLayer & { flowRef: ArchFlowRef & { handlerId: string } } {
  return l.parentLayerId === null && !!l.flowRef && typeof l.flowRef.containerId === "string" && typeof l.flowRef.handlerId === "string" && !!l.flowRef.handlerId;
}

export function fixtureIndex(projectId: string): ArchitectureIndex | null {
  const cat = forProject(projectId);
  if (!cat) return null;
  const roots = [...cat.layers.values()].filter(isRoot).map((l) => ({ layerId: l.id, title: l.title, flowRef: l.flowRef }));
  return { projectId, schemaVersion: 1, roots, warnings: [] };
}

export function fixtureLayer(projectId: string, layerId: string): ArchitectureLayerResponse | null {
  const cat = forProject(projectId);
  const layer = cat?.layers.get(layerId);
  if (!cat || !layer) return null;
  const chain: ArchLayer[] = [];
  for (let l: ArchLayer | undefined = layer; l && chain.length <= cat.layers.size; l = l.parentLayerId ? cat.layers.get(l.parentLayerId) : undefined)
    chain.unshift(l);
  const root = chain[0];
  if (!isRoot(root)) return null;
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
