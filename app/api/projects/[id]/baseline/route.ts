import { env } from 'cloudflare:workers';
import { api, projectId, type IdContext } from '../../../../../server/api';
import { fail } from '../../../../../server/errors';
import { modelConfiguration } from '../../../../../server/providers/synthesis';
import { generateBaseline } from '../../../../../server/providers/baseline';
import { suppliedFacts } from '../../../../../lib/product-contract';

export async function POST(request: Request, context: IdContext) {
  return api(request, async ({ actor, service, body }) => {
    const generationId = body && typeof body === 'object' && 'generationId' in body ? body.generationId : null;
    if (typeof generationId !== 'string' || generationId.length > 100) fail(400, 'INVALID_REQUEST', 'Choose a generation to compare.');
    const project = await service.store.read(actor.owner, await projectId(context));
    const generation = project.generations.find(item => item.id === generationId);
    if (!generation) fail(404, 'NOT_FOUND', 'Generation not found.');
    const model = modelConfiguration(env);
    if (!model.configured) fail(503, 'MODEL_NOT_CONFIGURED', 'Campaign writing is not connected yet.');
    suppliedFacts(generation.brief);
    await service.store.budget(actor.owner, 1, undefined, env.DEMO_UNLIMITED_DAILY_CAP === 'true');
    return { baseline: await generateBaseline(env, generation), model: `${model.provider}/${model.model}` };
  });
}
