import { configuration } from '../../../server/api';
export async function GET() { return Response.json(configuration(), { headers: { 'Cache-Control': 'private, no-store' } }); }
