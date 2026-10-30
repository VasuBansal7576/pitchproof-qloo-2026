import { api } from '../../../server/api';
import { parseProjectInput } from '../../../server/validation';
export async function GET(request: Request) { return api(request, async ({ actor, service }) => ({ projects: await service.store.list(actor.owner) })); }
export async function POST(request: Request) { return api(request, async ({ actor, service, body }) => ({ project: await service.create(actor.owner, parseProjectInput(body)) })); }
