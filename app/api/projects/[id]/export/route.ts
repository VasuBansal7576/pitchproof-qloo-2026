import { api, projectId, type IdContext } from '../../../../../server/api';
import { fail } from '../../../../../server/errors';
import { renderBriefHtml, renderBriefMarkdown } from '../../../../../lib/export';
export async function GET(request: Request, context: IdContext) {
  return api(request, async ({ actor, service }) => {
    const project = await service.store.read(actor.owner, await projectId(context));
    if (!project.generations.length) fail(409, 'EXPORT_NOT_READY', 'Generate campaign directions before exporting a client brief.');
    const format = new URL(request.url).searchParams.get('format') || 'html';
    if (format !== 'html' && format !== 'markdown') fail(400, 'INVALID_FORMAT', 'Choose html or markdown export.');
    return new Response(format === 'html' ? renderBriefHtml(project) : renderBriefMarkdown(project), { headers: { 'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8', 'Content-Disposition': `${format === 'html' ? 'inline' : 'attachment'}; filename="pitchproof-${project.id}.${format === 'html' ? 'html' : 'md'}"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'" } });
  });
}
