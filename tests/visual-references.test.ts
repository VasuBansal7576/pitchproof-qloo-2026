import test from "node:test";
import assert from "node:assert/strict";
import type { Direction, Entity, Evidence, Reference } from "../lib/pitchproof-types";
import { visualReferences } from "../lib/visual-references";

const direction: Direction = {
  id: "test-direction", title: "Test direction", hook: "Test hook", audienceHypothesis: "Test audience", strategy: "Test strategy",
  visuals: { description: "Test visual world", palette: [], references: [] }, channels: [], claims: [],
  testPlan: { hypothesis: "Test hypothesis", variants: [], metric: "Test metric", successCriterion: "Test criterion" }, limitations: [],
};

function entity(name: string, values: Partial<Entity> = {}): Entity {
  return { id: name, name, type: "urn:entity:movie", description: "", image: "https://images.example.test/reference.jpg", url: "https://example.test/entity", ...values };
}

function evidence(value: Entity): Evidence {
  return { id: `evidence-${value.id}`, runId: "test-run", category: "movie", entity: value, rank: 1, score: null, observation: "Test observation", collectedAt: "2026-10-24T00:00:00Z",
    context: { referenceNames: [], referenceIds: [], referenceRoles: [], market: "London", geographyApplied: false, parameters: {}, endpoint: "/v2/insights" } };
}

function reference(value: Entity | null, query = value?.name ?? "Unconfirmed"): Reference {
  return { query, role: "aesthetic", entity: value };
}

function withNames(...names: string[]): Direction {
  return { ...direction, visuals: { ...direction.visuals, references: names } };
}

test("visual references preserve supplied order, deduplicate, and retain actual Qloo fields", () => {
  const film = entity("Retrieved film");
  const brand = entity("Confirmed brand", { type: "urn:entity:brand", image: "https://images.example.test/brand.jpg" });
  const result = visualReferences(withNames(brand.name, film.name, brand.name), [evidence(film)], [reference(brand)]);
  assert.deepEqual(result, [
    { name: brand.name, image: brand.image, url: brand.url, type: "Brand", provenance: "confirmed-reference" },
    { name: film.name, image: film.image, url: film.url, type: "Movie", provenance: "retrieved-evidence" },
  ]);
});

test("entity names match after whitespace normalization, excluding query text and unrequested entities", () => {
  const film = entity("Exact film");
  const result = visualReferences(withNames("exact film", " Exact film", "Unknown", "Typed query", "Unconfirmed"), [evidence(film), evidence(entity("Not requested"))], [reference(entity("Resolved brand"), "Typed query"), reference(null)]);
  assert.deepEqual(result.map(item => item.name), ["Exact film"]);
});

test("confirmed entities take precedence over retrieved entities with the same name", () => {
  const confirmed = entity("Shared name", { image: null, url: "https://example.test/confirmed" });
  const result = visualReferences(withNames(confirmed.name), [evidence(entity(confirmed.name))], [reference(confirmed)]);
  assert.equal(result[0].provenance, "confirmed-reference");
  assert.equal(result[0].image, null);
  assert.equal(result[0].url, confirmed.url);
});

test("missing images and URLs remain absent without fabricated replacement assets", () => {
  const value = entity("No assets", { image: null, url: null });
  assert.deepEqual(visualReferences(withNames(value.name), [evidence(value)], []), [
    { name: value.name, image: null, url: null, type: "Movie", provenance: "retrieved-evidence" },
  ]);
});

test("unsafe, relative, and credential-bearing asset URLs cannot reach the board", () => {
  const unsafe = ["javascript:alert(1)", "data:image/png;base64,aGVsbG8=", "file:///tmp/reference.png", "//example.test/image.jpg", "/image.jpg", "not a URL", "https://user:secret@example.test/image.jpg"];
  for (const url of unsafe) {
    const value = entity("Unsafe assets", { image: url, url });
    const [result] = visualReferences(withNames(value.name), [evidence(value)], []);
    assert.equal(result.image, null, url);
    assert.equal(result.url, null, url);
  }
  const value = entity("HTTP assets", { image: "http://images.example.test/a.jpg", url: "https://example.test/a?source=qloo" });
  const [result] = visualReferences(withNames(value.name), [evidence(value)], []);
  assert.equal(result.image, value.image);
  assert.equal(result.url, value.url);
});

test("names outside the supplied generation evidence cannot appear", () => {
  assert.deepEqual(visualReferences(withNames("Historical film"), [evidence(entity("Current film"))], []), []);
});


test("validated names with surrounding whitespace retain their actual source", () => {
  const film = entity("Retrieved film");
  assert.equal(visualReferences(withNames("  Retrieved film  "), [evidence(film)], [])[0].name, film.name);
});

test("legacy confirmed seeds remain named when the current brief changes", () => {
  const record = evidence(entity("Retrieved film"));
  record.context.referenceNames = ["Original seed"];
  record.context.referenceIds = ["original-seed-id"];
  const result = visualReferences(withNames("Original seed"), [record], [reference(null, "New seed")]);
  assert.deepEqual(result, [{ name: "Original seed", image: null, url: null, type: "Brand", provenance: "confirmed-reference" }]);
});


test("visual labels use the known research category when entity type is generic", () => {
  const artist = evidence(entity("Observed artist", { type: "urn:entity" }));
  artist.category = "artist";
  assert.equal(visualReferences(withNames("Observed artist"), [artist], [])[0].type, "Artist");
});
