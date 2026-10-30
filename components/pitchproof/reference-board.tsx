"use client";

import { useState } from "react";
import type { VisualReference } from "@/lib/visual-references";

function ReferenceTile({ reference }: { reference: VisualReference }) {
  const [imageFailed, setImageFailed] = useState(false);
  return <article className="reference-tile">
    <div className="reference-image">
      {reference.image && !imageFailed ? (
        // Qloo supplies remote image hosts per entity, so render its original URL directly.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={reference.image} alt={`${reference.name}, visual reference supplied by Qloo`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
      ) : <div className="reference-image-fallback"><span>{reference.type}</span><p>{imageFailed ? "Reference image unavailable" : "No image supplied by Qloo"}</p></div>}
    </div>
    <div className="reference-tile-caption">
      <span className="reference-type">{reference.type}</span>
      <h5>{reference.name}</h5>
      <p className="reference-provenance">{reference.provenance === "confirmed-reference" ? "Confirmed Qloo reference" : "Retrieved Qloo evidence"}</p>
      {reference.url ? <a className="reference-source" href={reference.url} target="_blank" rel="noopener noreferrer">Open entity source <span aria-hidden="true">↗</span></a> : <span className="reference-source-unavailable">No source link supplied</span>}
    </div>
  </article>;
}

export function ReferenceBoard({ references }: { references: VisualReference[] }) {
  return <section className="reference-board" aria-label="Qloo visual references">
    <div className="reference-board-heading"><h4>Visual references</h4><span>From Qloo entities</span></div>
    {references.length ? <div className="reference-board-grid">{references.map(reference => <ReferenceTile key={`${reference.name}-${reference.image ?? "no-image"}`} reference={reference} />)}</div> : <p className="reference-board-empty">No confirmed Qloo entities match this direction&apos;s visual references.</p>}
    <p className="reference-board-notice">Images are references for inspiration. Their inclusion conveys no asset-use rights or endorsement.</p>
  </section>;
}
