import type { RequestHandler } from './$types';
import { crawlSite } from '$lib/server/audit/crawler';
import type { AuditEvent } from '$lib/types';

const MAX_PAGES_LIMIT = 100;

export const GET: RequestHandler = async ({ url }) => {
	const target = url.searchParams.get('url')?.trim();
	const maxPages = Math.min(Number(url.searchParams.get('max')) || 30, MAX_PAGES_LIMIT);
	const user = url.searchParams.get('user') || '';
	const pass = url.searchParams.get('pass') || '';

	let startUrl: URL;
	try {
		startUrl = new URL(target?.match(/^https?:\/\//i) ? target : `https://${target}`);
	} catch {
		return new Response(JSON.stringify({ error: 'Ongeldige URL' }), { status: 400 });
	}
	if (!/^https?:$/.test(startUrl.protocol)) {
		return new Response(JSON.stringify({ error: 'Alleen http(s) wordt ondersteund' }), { status: 400 });
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: AuditEvent) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			try {
				await crawlSite(startUrl.href, {
					maxPages,
					auth: user ? { user, pass } : undefined,
					onEvent: send
				});
			} catch (e) {
				send({ type: 'error', message: e instanceof Error ? e.message : 'Onbekende fout' });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
