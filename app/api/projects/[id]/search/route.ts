import { api, projectId, type IdContext } from '../../../../../server/api';
import { parseSearch } from '../../../../../server/validation';
export async function POST(request: Request, context: IdContext) { return api(request, async ({ actor, service, body }) => { const input = parseSearch(body); return { candidates: await service.search(actor.owner, await projectId(context), input.slot, input.query) }; }); }
