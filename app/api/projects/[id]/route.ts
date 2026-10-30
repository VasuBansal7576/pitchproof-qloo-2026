import { api, projectId, type IdContext } from '../../../../server/api';
export async function GET(request: Request, context: IdContext) { return api(request, async ({ actor, service }) => ({ project: await service.store.read(actor.owner, await projectId(context)) })); }
