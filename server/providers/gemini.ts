import { fail } from '../errors';
import { providerJson, type ProviderObserver } from './http';

type GeminiRequest = {
  apiKey: string;
  model: string;
  input: string;
  systemInstruction?: string;
  schema: unknown;
  purpose: 'synthesis' | 'revision-plan' | 'campaign-review';
  observe?: ProviderObserver;
};

const purposes = {
  synthesis: { label: 'Creative model', timeout: 75_000, maxOutputTokens: 10_000 },
  'revision-plan': { label: 'Research planner', timeout: 30_000, maxOutputTokens: 4096 },
  'campaign-review': { label: 'Campaign reviewer', timeout: 30_000, maxOutputTokens: 2048 },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function usableText(text: string): string {
  if (!text.trim() || text.length > 90_000) fail(502, 'MODEL_RESPONSE', 'The model did not return usable structured text. Retry this step.');
  return text;
}

function interactionText(value: unknown): string {
  const interaction = object(value);
  if (interaction.status === 'incomplete') fail(502, 'MODEL_INCOMPLETE', 'The model returned an incomplete response. Retry this step.');
  if (interaction.status !== 'completed' || !Array.isArray(interaction.steps)) fail(502, 'MODEL_RESPONSE', 'The model did not complete its response. Retry this step.');
  const outputs = interaction.steps.map(object).filter(step => step.type === 'model_output');
  if (outputs.some(step => step.status !== undefined && step.status !== 'done')) fail(502, 'MODEL_INCOMPLETE', 'The model returned an incomplete response. Retry this step.');
  return usableText(outputs.flatMap(step => Array.isArray(step.content) ? step.content : []).map(object)
    .filter(content => content.type === 'text' && content.thought !== true && typeof content.text === 'string')
    .map(content => content.text).join(''));
}

function legacyText(value: unknown): string {
  const candidates = object(value).candidates;
  const candidate = object(Array.isArray(candidates) ? candidates[0] : undefined);
  if (candidate.finishReason === 'MAX_TOKENS') fail(502, 'MODEL_OUTPUT_LIMIT', 'The model exhausted its response budget before finishing. Retry this step.');
  if (candidate.finishReason !== 'STOP') fail(502, 'MODEL_RESPONSE', 'The model did not complete its response. Retry this step.');
  const parts = object(candidate.content).parts;
  return usableText((Array.isArray(parts) ? parts : []).map(object)
    .filter(part => part.thought !== true && typeof part.text === 'string').map(part => part.text).join(''));
}

// Google documents stateless storage and the REST step timeline separately from SDK output_text.
// https://ai.google.dev/gemini-api/docs/interactions-overview
// https://ai.google.dev/api/interactions-api
// https://ai.google.dev/gemini-api/docs/structured-output
// https://ai.google.dev/gemini-api/docs/text-generation
export async function geminiStructuredText(request: GeminiRequest): Promise<string> {
  const policy = purposes[request.purpose];
  const version = /^gemini-(\d+)(?:[.-])/.exec(request.model);
  const modern = version !== null && Number(version[1]) >= 3;
  const url = modern ? 'https://generativelanguage.googleapis.com/v1beta/interactions'
    : `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;
  const body = modern ? {
    model: request.model,
    input: request.input,
    ...(request.systemInstruction ? { system_instruction: request.systemInstruction } : {}),
    store: false,
    response_format: { type: 'text', mime_type: 'application/json', schema: request.schema },
    generation_config: { max_output_tokens: policy.maxOutputTokens, thinking_level: 'low' },
  } : {
    ...(request.systemInstruction ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: request.input }] }],
    generationConfig: {
      responseMimeType: 'application/json', responseJsonSchema: request.schema,
      ...(request.purpose === 'synthesis' && request.model.startsWith('gemini-2.5-flash') ? { thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.8 } : {}),
      maxOutputTokens: policy.maxOutputTokens,
    },
  };
  const response = await providerJson(new URL(url), {
    method: 'POST', headers: { 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, policy.label, policy.timeout, false, request.observe);
  return modern ? interactionText(response) : legacyText(response);
}
