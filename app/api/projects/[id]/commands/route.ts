import { api, projectId, type IdContext } from '../../../../../server/api';
import { parseCommand } from '../../../../../server/validation';
export async function POST(request: Request, context: IdContext) { return api(request, async ({ actor, service, body }) => ({ project: await service.execute(actor.owner, await projectId(context), parseCommand(body)) })); }
