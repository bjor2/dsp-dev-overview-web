import type { Crumb } from "./model";

/** `[Flow] › root › … › current   [↑ Up] [View in Flow]` — every crumb but the current one is a button. */
export default function Breadcrumbs({ crumbs, onFlow, onOpen, onUp, onViewInFlow }: {
  crumbs: Crumb[];
  onFlow: () => void;
  onOpen: (layerId: string) => void;
  onUp: () => void;
  onViewInFlow: () => void;
}) {
  return (
    <div className="architecture-crumbs">
      <nav aria-label="Architecture breadcrumbs">
        <ol>
          {crumbs.map((c, i) => {
            const current = i === crumbs.length - 1;
            const key = c.kind === "flow" ? "flow" : c.layerId;
            return (
              <li key={key} className={`arch-crumb arch-crumb-${c.kind}${current ? " current" : ""}`} data-layer={c.kind === "layer" ? c.layerId : undefined}>
                {i > 0 && <span className="arch-crumb-sep" aria-hidden="true">›</span>}
                {current ? (
                  <span aria-current="page" title={c.title}>{c.title}</span>
                ) : (
                  <button type="button" className="ghost" onClick={() => (c.kind === "flow" ? onFlow() : onOpen(c.layerId))}
                    title={c.kind === "flow" ? "Back to Flow (pan, zoom and selection unchanged)" : `${c.title}\n${c.layerId}`}>
                    {c.title}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <button type="button" className="arch-up" onClick={onUp} title="Up one layer (Backspace / Alt+↑); at the root: back to Flow">↑ Up</button>
      <button type="button" className="arch-view-in-flow" onClick={onViewInFlow} title="Back to Flow and select the container this architecture belongs to">View in Flow</button>
    </div>
  );
}
