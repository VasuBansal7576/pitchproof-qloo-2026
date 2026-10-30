import type { Direction, Entity, Evidence, Reference } from "./pitchproof-types";

export type VisualReference = {
  name: string;
  image: string | null;
  url: string | null;
  type: string;
  provenance: "confirmed-reference" | "retrieved-evidence";
};

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function typeLabel(value: string): string {
  const label = value.replace(/^urn:entity:/, "").replace(/[_-]/g, " ");
  return label ? label[0].toUpperCase() + label.slice(1) : "Entity";
}

export function visualReferences(direction: Direction, evidence: Evidence[], references: Reference[]): VisualReference[] {
  const sources = new Map<string, { entity: Entity; provenance: VisualReference["provenance"]; category: string }>();
  for (const reference of references) {
    if (reference.entity && !sources.has(reference.entity.name)) {
      sources.set(reference.entity.name, { entity: reference.entity, provenance: "confirmed-reference", category: "brand" });
    }
  }
  for (const item of evidence) {
    if (!sources.has(item.entity.name)) {
      sources.set(item.entity.name, { entity: item.entity, provenance: "retrieved-evidence", category: item.category });
    }
  }
  for (const item of evidence) {
    item.context.referenceNames.forEach((name, index) => {
      if (!sources.has(name)) sources.set(name, { entity: { id: item.context.referenceIds[index] ?? name, name, type: "urn:entity:brand", description: "", image: null, url: null }, provenance: "confirmed-reference", category: "brand" });
    });
  }
  const seen = new Set<string>();
  const result: VisualReference[] = [];
  for (const requestedName of direction.visuals.references) {
    const name = requestedName.trim();
    const source = sources.get(name);
    if (!source || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name: source.entity.name,
      image: httpUrl(source.entity.image),
      url: httpUrl(source.entity.url),
      type: typeLabel(source.category),
      provenance: source.provenance,
    });
  }
  return result;
}
