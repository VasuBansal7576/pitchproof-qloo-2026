import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Generation } from '../lib/pitchproof-types';
import { generateBaseline } from '../server/providers/baseline';

const env = { MODEL_PROVIDER: 'openai', MODEL_NAME: 'test-model', MODEL_API_KEY: 'test-key' };
const generation: Generation = {
  id: 'generation', createdAt: '2026-01-01', model: 'test-model', directions: [], evidenceIds: ['private-evidence'], parentDirectionId: null, feedback: 'private-feedback',
  brief: { product: 'Shoe', description: 'A shoe', category: 'Footwear', market: 'London', audience: 'Residents', objective: 'Introduction', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'It is a shoe.', source: 'user_supplied', sourceUrl: null }] },
  references: [{ query: 'Atlas', role: 'aesthetic', entity: { id: 'private-entity', name: 'Resolved name', type: 'brand', description: 'Private observation', image: null, url: null } }],
};
const output = { title: 'A proposal', hook: 'A simple introduction', audienceHypothesis: 'Residents may notice it.', proposition: 'A shoe for an ordinary day.', mechanism: 'Show a shoe in a scene.', limitations: ['Audience interest is unverified.'] };

test('baseline sends the saved brief and entered references without research or generated directions', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input, { brief: generation.brief, references: [{ query: 'Atlas', role: 'aesthetic' }] });
    assert.doesNotMatch(JSON.stringify(input), /private-evidence|private-entity|private-feedback|Private observation/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  try { assert.deepEqual(await generateBaseline(env, generation), output); } finally { globalThis.fetch = original; }
});

test('baseline rejects malformed model output and missing configuration', async () => {
  await assert.rejects(generateBaseline({}, generation), /not connected/);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"title":"incomplete"}' } }] });
  try { await assert.rejects(generateBaseline(env, generation), /incomplete response/); } finally { globalThis.fetch = original; }
});

test('OpenCode Go baseline uses its session header and strict structured output', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.match(headers.get('x-opencode-session') ?? '', /^ses_[0-9a-f-]{36}$/);
    assert.equal(headers.get('authorization'), 'Bearer opencode-key');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.name, 'campaign_baseline');
    assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
    assert.deepEqual(request.response_format.json_schema.schema.required, ['title', 'hook', 'audienceHypothesis', 'proposition', 'mechanism', 'limitations']);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  try { assert.deepEqual(await generateBaseline({ MODEL_PROVIDER: 'opencode', MODEL_API_KEY: 'gemini-key', OPENCODE_API_KEY: 'opencode-key' }, generation), output); }
  finally { globalThis.fetch = original; }
});

test('OpenCode gpt-6-luna baseline requests no reasoning without affecting other models', async () => {
  const original = globalThis.fetch;
  const efforts: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    efforts.push(JSON.parse(String(init?.body)).reasoning_effort);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  try {
    await generateBaseline({ MODEL_PROVIDER: 'opencode', MODEL_NAME: 'gpt-6-luna', OPENCODE_API_KEY: 'test-key' }, generation);
    await generateBaseline({ MODEL_PROVIDER: 'opencode', MODEL_NAME: 'glm-5.3-flash', OPENCODE_API_KEY: 'test-key' }, generation);
    assert.deepEqual(efforts, ['none', undefined]);
  } finally { globalThis.fetch = original; }
});
