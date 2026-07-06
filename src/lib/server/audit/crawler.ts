import { env } from '$env/dynamic/private';
import type { AuditEvent, Check, PageResult, SiteResult } from '$lib/types';
import { scoreChecks } from '$lib/types';
import { analyzePage } from './page-checks';
import { fetchVitals } from './vitals';

export interface CrawlOptions {
	maxPages: number;
	auth?: { user: string; pass: string };
	onEvent: (event: AuditEvent) => void;
}

const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; SEO-Preflight/1.0)';

function normalize(url: string): string {
	const u = new URL(url);
	u.hash = '';
	if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
	return u.href;
}

function baseHeaders(auth?: { user: string; pass: string }): Record<string, string> {
	const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' };
	if (auth?.user) headers['Authorization'] = `Basic ${btoa(`${auth.user}:${auth.pass}`)}`;
	return headers;
}

export async function crawlSite(startUrl: string, opts: CrawlOptions): Promise<SiteResult> {
	const start = new URL(normalize(startUrl));
	const headers = baseHeaders(opts.auth);
	const queue: string[] = [normalize(start.href)];
	const seen = new Set<string>(queue);
	const linkedFrom = new Map<string, Set<string>>();
	const ogImages = new Map<string, Set<string>>();
	const pages: PageResult[] = [];
	let truncated = false;

	// Core Web Vitals draaien parallel aan de crawl (PSI doet er tientallen seconden over)
	const vitalsPromise = fetchVitals(start.href, env.PAGESPEED_API_KEY).catch(
		(): Check[] => [
			{ id: 'vitals-error', label: 'Core Web Vitals', status: 'info', message: 'Core Web Vitals konden niet worden opgehaald.' }
		]
	);

	async function fetchUrl(url: string, accept = 'text/html,*/*'): Promise<Response | null> {
		try {
			return await fetch(url, {
				headers: { ...headers, Accept: accept },
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
		} catch {
			return null;
		}
	}

	async function processUrl(url: string): Promise<void> {
		opts.onEvent({ type: 'progress', crawled: pages.length, queued: queue.length, url });
		const res = await fetchUrl(url);
		const from = [...(linkedFrom.get(url) ?? [])];

		if (!res) {
			const checks: Check[] = [
				{ id: 'http-status', label: 'Bereikbaarheid', status: 'fail', message: 'Pagina niet bereikbaar (timeout of netwerkfout).' }
			];
			const page: PageResult = { url, finalUrl: url, httpStatus: 0, title: null, description: null, checks, score: 0, linkedFrom: from };
			pages.push(page);
			opts.onEvent({ type: 'page', page });
			return;
		}

		const finalUrl = normalize(res.url || url);
		const checks: Check[] = [];

		if (res.status >= 400) {
			checks.push({
				id: 'http-status',
				label: 'HTTP-status',
				status: 'fail',
				message: `Pagina geeft ${res.status}${from.length ? ` — gelinkt vanaf ${from.length} pagina('s)` : ''}.`,
				details: from.slice(0, 10)
			});
			const page: PageResult = { url, finalUrl, httpStatus: res.status, title: null, description: null, checks, score: 0, linkedFrom: from };
			pages.push(page);
			opts.onEvent({ type: 'page', page });
			return;
		}

		const contentType = res.headers.get('content-type') || '';
		if (!contentType.includes('text/html')) return;

		if (new URL(finalUrl).host !== start.host) {
			checks.push({
				id: 'redirect-offsite',
				label: 'Redirect',
				status: 'warn',
				message: `Pagina redirect naar een ander domein: ${finalUrl}`
			});
			const page: PageResult = { url, finalUrl, httpStatus: res.status, title: null, description: null, checks, score: scoreChecks(checks), linkedFrom: from };
			pages.push(page);
			opts.onEvent({ type: 'page', page });
			return;
		}

		if (url !== finalUrl) {
			checks.push({ id: 'redirect', label: 'Redirect', status: 'info', message: `Redirect naar ${finalUrl}.` });
		}

		const html = await res.text();
		const analysis = analyzePage(html, finalUrl, res.headers);
		checks.push(...analysis.checks);

		if (analysis.ogImage) {
			try {
				const resolved = new URL(analysis.ogImage, finalUrl).href;
				if (!ogImages.has(resolved)) ogImages.set(resolved, new Set());
				ogImages.get(resolved)!.add(finalUrl);
			} catch {
				/* ongeldige og:image-URL — al gemeld in page checks */
			}
		}

		for (const link of analysis.internalLinks) {
			const normalized = normalize(link);
			if (!linkedFrom.has(normalized)) linkedFrom.set(normalized, new Set());
			linkedFrom.get(normalized)!.add(finalUrl);
			if (seen.has(normalized)) continue;
			if (seen.size >= opts.maxPages) {
				truncated = true;
				continue;
			}
			seen.add(normalized);
			queue.push(normalized);
		}

		const page: PageResult = {
			url,
			finalUrl,
			httpStatus: res.status,
			title: analysis.title,
			description: analysis.description,
			checks,
			score: scoreChecks(checks),
			linkedFrom: from
		};
		pages.push(page);
		opts.onEvent({ type: 'page', page });
	}

	// Eenvoudige worker-pool over een gedeelde queue
	async function worker(): Promise<void> {
		while (queue.length > 0) {
			const url = queue.shift();
			if (!url) break;
			await processUrl(url);
		}
	}
	// Workers herstarten zolang er nieuwe links bij komen
	while (queue.length > 0) {
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
	}

	const robotsRes = await fetchUrl(`${start.origin}/robots.txt`, 'text/plain,*/*');
	const robotsTxt = robotsRes?.ok ? await robotsRes.text() : null;

	const siteChecks = await runSiteChecks(start, pages, fetchUrl, robotsTxt, ogImages);
	const geo = await runGeoChecks(start, pages, fetchUrl, robotsTxt);
	const goLive = buildGoLiveChecklist(start, pages, siteChecks);
	const vitals = await vitalsPromise;
	const allChecks = [...siteChecks, ...geo, ...vitals, ...pages.flatMap((p) => p.checks)];

	const site: SiteResult = {
		startUrl: start.href,
		pages,
		siteChecks,
		goLive,
		geo,
		vitals,
		score: scoreChecks(allChecks),
		truncated
	};
	opts.onEvent({ type: 'site', site });
	return site;
}

interface RobotsGroup {
	disallowRoot: boolean;
	allowRoot: boolean;
}

/** Parseert robots.txt naar één (samengevoegde) groep regels per user-agent. */
function parseRobotsGroups(robotsTxt: string): Map<string, RobotsGroup> {
	const groups = new Map<string, RobotsGroup>();
	let agents: string[] = [];
	let inRuleSection = false;
	for (const rawLine of robotsTxt.split('\n')) {
		const line = rawLine.replace(/#.*$/, '').trim();
		const match = line.match(/^([a-z-]+):\s*(.*)$/i);
		if (!match) continue;
		const field = match[1].toLowerCase();
		const value = match[2].trim();
		if (field === 'user-agent') {
			if (inRuleSection) agents = [];
			inRuleSection = false;
			agents.push(value.toLowerCase());
		} else if (field === 'disallow' || field === 'allow') {
			inRuleSection = true;
			for (const agent of agents) {
				const group = groups.get(agent) ?? { disallowRoot: false, allowRoot: false };
				if (field === 'disallow' && value === '/') group.disallowRoot = true;
				if (field === 'allow' && value === '/') group.allowRoot = true;
				groups.set(agent, group);
			}
		}
	}
	return groups;
}

/** Is de hele site voor deze bot geblokkeerd? Exacte agent-groep wint van `*`. */
function isAgentBlocked(groups: Map<string, RobotsGroup>, agent: string): boolean {
	const group = groups.get(agent.toLowerCase()) ?? groups.get('*');
	return !!group && group.disallowRoot && !group.allowRoot;
}

function robotsBlocksEverything(robotsTxt: string): boolean {
	return isAgentBlocked(parseRobotsGroups(robotsTxt), '*');
}

async function runSiteChecks(
	start: URL,
	pages: PageResult[],
	fetchUrl: (url: string, accept?: string) => Promise<Response | null>,
	robotsTxt: string | null,
	ogImages: Map<string, Set<string>>
): Promise<Check[]> {
	const checks: Check[] = [];

	// HTTPS
	checks.push(
		start.protocol === 'https:'
			? { id: 'https', label: 'HTTPS', status: 'pass', message: 'Site draait op HTTPS.' }
			: { id: 'https', label: 'HTTPS', status: 'warn', message: 'Site draait niet op HTTPS. Voor een lokale dev-omgeving prima, live niet.' }
	);

	// robots.txt
	let sitemapUrls: string[] = [`${start.origin}/sitemap.xml`];
	if (robotsTxt !== null) {
		const fromRobots = [...robotsTxt.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
		if (fromRobots.length > 0) sitemapUrls = fromRobots;
		const blocksAll = robotsBlocksEverything(robotsTxt);
		checks.push(
			blocksAll
				? { id: 'robots', label: 'robots.txt', status: 'warn', message: 'robots.txt blokkeert de hele site (Disallow: /). Prima tijdens de bouw, maar vergeet dit niet bij livegang.' }
				: { id: 'robots', label: 'robots.txt', status: 'pass', message: `robots.txt aanwezig${fromRobots.length ? ' en verwijst naar de sitemap' : ''}.` }
		);
	} else {
		checks.push({ id: 'robots', label: 'robots.txt', status: 'warn', message: 'Geen robots.txt gevonden.' });
	}

	// Sitemap
	let sitemapFound = false;
	let sitemapLocs: string[] = [];
	for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
		const res = await fetchUrl(sitemapUrl, 'application/xml,text/xml,*/*');
		if (!res?.ok) continue;
		const xml = await res.text();
		const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
		if (locs.length === 0) continue;
		sitemapFound = true;
		sitemapLocs = locs;
		const foreignHosts = new Set(
			locs
				.map((loc) => {
					try {
						return new URL(loc).host;
					} catch {
						return null;
					}
				})
				.filter((h): h is string => !!h && h !== start.host)
		);
		if (foreignHosts.size > 0) {
			checks.push({
				id: 'sitemap-hosts',
				label: 'Sitemap',
				status: 'fail',
				message: `Sitemap bevat URL's van een ander domein (${[...foreignHosts].join(', ')}) — staging-restant?`,
				details: locs.filter((l) => !l.includes(start.host)).slice(0, 10)
			});
		} else {
			checks.push({ id: 'sitemap', label: 'Sitemap', status: 'pass', message: `Sitemap gevonden met ${locs.length} URL's (${sitemapUrl}).` });
		}
		break;
	}
	if (!sitemapFound) {
		checks.push({ id: 'sitemap', label: 'Sitemap', status: 'warn', message: 'Geen sitemap.xml gevonden. Zorg dat die er is vóór livegang.' });
	}

	// Sitemap vs noindex — tegenstrijdig signaal naar zoekmachines
	if (sitemapLocs.length > 0) {
		const noindexUrls = new Set(
			pages
				.filter((p) => p.checks.some((c) => c.id === 'noindex' && c.status === 'warn'))
				.map((p) => p.finalUrl)
		);
		const conflicts = sitemapLocs.filter((loc) => {
			try {
				const u = new URL(loc);
				u.hash = '';
				if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
				return noindexUrls.has(u.href);
			} catch {
				return false;
			}
		});
		if (conflicts.length > 0) {
			checks.push({
				id: 'sitemap-noindex',
				label: 'Sitemap vs noindex',
				status: 'fail',
				message: `${conflicts.length} pagina('s) staan in de sitemap maar ook op noindex — tegenstrijdig signaal naar Google.`,
				details: conflicts.slice(0, 10)
			});
		}
	}

	// Soft-404: geeft een niet-bestaande URL wel netjes een 404-status?
	const notFoundRes = await fetchUrl(`${start.origin}/seo-preflight-check-deze-pagina-bestaat-niet`);
	if (notFoundRes && notFoundRes.status < 400) {
		checks.push({
			id: 'soft-404',
			label: 'Soft 404',
			status: 'warn',
			message: `Een niet-bestaande URL geeft status ${notFoundRes.status} in plaats van 404. Zoekmachines kunnen zulke "soft 404's" als dunne duplicaten indexeren.`
		});
	} else if (notFoundRes) {
		checks.push({ id: 'soft-404', label: 'Soft 404', status: 'pass', message: 'Niet-bestaande URL\'s geven netjes een 404-status.' });
	}

	// og:image-URL's echt bereikbaar?
	const brokenOgImages: string[] = [];
	for (const [imageUrl, usedOn] of [...ogImages.entries()].slice(0, 15)) {
		const res = await fetchUrl(imageUrl, 'image/*,*/*');
		const contentType = res?.headers.get('content-type') || '';
		if (!res?.ok || !contentType.startsWith('image/')) {
			brokenOgImages.push(`${imageUrl} (${res ? res.status : 'timeout'}) — gebruikt op ${usedOn.size} pagina('s)`);
		}
	}
	if (ogImages.size > 0) {
		checks.push(
			brokenOgImages.length > 0
				? {
						id: 'og-images',
						label: 'Social share-afbeeldingen',
						status: 'fail',
						message: `${brokenOgImages.length} og:image-URL('s) zijn kapot — links delen zonder afbeelding.`,
						details: brokenOgImages.slice(0, 10)
					}
				: { id: 'og-images', label: 'Social share-afbeeldingen', status: 'pass', message: `Alle ${ogImages.size} og:image-URL's zijn bereikbaar.` }
		);
	}

	// Interne links die via een redirect gaan
	const redirectedPages = pages.filter((p) => p.url !== p.finalUrl && p.linkedFrom.length > 0);
	if (redirectedPages.length > 0) {
		checks.push({
			id: 'redirect-links',
			label: 'Links via redirects',
			status: 'warn',
			message: `${redirectedPages.length} interne link(s) wijzen naar een URL die redirect — link direct naar de eindbestemming.`,
			details: redirectedPages.slice(0, 10).map((p) => `${p.url} → ${p.finalUrl}`)
		});
	}

	// Favicon
	const faviconRes = await fetchUrl(`${start.origin}/favicon.ico`, '*/*');
	if (!faviconRes?.ok) {
		checks.push({ id: 'favicon', label: 'Favicon', status: 'info', message: 'Geen /favicon.ico gevonden — check of er een favicon via <link> is ingesteld.' });
	}

	// Dubbele titels en descriptions
	const okPages = pages.filter((p) => p.httpStatus > 0 && p.httpStatus < 400);
	const byTitle = new Map<string, string[]>();
	const byDesc = new Map<string, string[]>();
	for (const p of okPages) {
		if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) ?? []), p.finalUrl]);
		if (p.description) byDesc.set(p.description, [...(byDesc.get(p.description) ?? []), p.finalUrl]);
	}
	const dupTitles = [...byTitle.entries()].filter(([, urls]) => urls.length > 1);
	const dupDescs = [...byDesc.entries()].filter(([, urls]) => urls.length > 1);
	checks.push(
		dupTitles.length > 0
			? {
					id: 'dup-titles',
					label: 'Unieke titels',
					status: 'warn',
					message: `${dupTitles.length} titel(s) komen op meerdere pagina's voor.`,
					details: dupTitles.slice(0, 5).map(([t, urls]) => `“${t}” op ${urls.length} pagina's`)
				}
			: { id: 'dup-titles', label: 'Unieke titels', status: 'pass', message: 'Alle paginatitels zijn uniek.' }
	);
	checks.push(
		dupDescs.length > 0
			? {
					id: 'dup-descriptions',
					label: 'Unieke descriptions',
					status: 'warn',
					message: `${dupDescs.length} meta description(s) komen op meerdere pagina's voor.`,
					details: dupDescs.slice(0, 5).map(([d, urls]) => `“${d.slice(0, 80)}…” op ${urls.length} pagina's`)
				}
			: { id: 'dup-descriptions', label: 'Unieke descriptions', status: 'pass', message: 'Alle meta descriptions zijn uniek.' }
	);

	// Kapotte interne links
	const broken = pages.filter((p) => p.httpStatus === 0 || p.httpStatus >= 400);
	checks.push(
		broken.length > 0
			? {
					id: 'broken-links',
					label: 'Interne links',
					status: 'fail',
					message: `${broken.length} interne link(s) zijn kapot.`,
					details: broken.slice(0, 10).map((p) => `${p.url} (${p.httpStatus || 'timeout'})`)
				}
			: { id: 'broken-links', label: 'Interne links', status: 'pass', message: 'Geen kapotte interne links gevonden.' }
	);

	return checks;
}

// Bron: AI user-agent landscape, april 2026 (nohacks.co)
const AI_SEARCH_BOTS = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Bingbot', 'DuckAssistBot', 'Google-CloudVertexBot'];
const AI_FETCHER_BOTS = ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'MistralAI-User'];
const AI_TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'Amazonbot', 'Bytespider'];

async function runGeoChecks(
	start: URL,
	pages: PageResult[],
	fetchUrl: (url: string, accept?: string) => Promise<Response | null>,
	robotsTxt: string | null
): Promise<Check[]> {
	const checks: Check[] = [];
	const groups = robotsTxt !== null ? parseRobotsGroups(robotsTxt) : new Map<string, RobotsGroup>();

	// AI-zoekbots: bepalen of de site vindbaar is in ChatGPT Search, Claude, Perplexity, Copilot enz.
	const blockedSearch = AI_SEARCH_BOTS.filter((bot) => isAgentBlocked(groups, bot));
	checks.push(
		blockedSearch.length > 0
			? {
					id: 'geo-search-bots',
					label: 'AI-zoekbots',
					status: 'fail',
					message: `${blockedSearch.length} AI-zoekbot(s) geblokkeerd in robots.txt — de site is onzichtbaar in die AI-zoekmachines (ChatGPT Search, Claude, Perplexity, Copilot).`,
					details: blockedSearch
				}
			: { id: 'geo-search-bots', label: 'AI-zoekbots', status: 'pass', message: 'Alle AI-zoekbots mogen de site indexeren.' }
	);

	// User-fetchers: halen een pagina op als een gebruiker er in ChatGPT/Claude/Perplexity om vraagt
	const blockedFetchers = AI_FETCHER_BOTS.filter((bot) => isAgentBlocked(groups, bot));
	checks.push(
		blockedFetchers.length > 0
			? {
					id: 'geo-fetchers',
					label: 'AI-assistenten',
					status: 'warn',
					message: `${blockedFetchers.length} user-fetcher(s) geblokkeerd — AI-assistenten kunnen de site niet openen als een gebruiker ernaar vraagt.`,
					details: blockedFetchers
				}
			: { id: 'geo-fetchers', label: 'AI-assistenten', status: 'pass', message: 'AI-assistenten (ChatGPT, Claude, Perplexity) kunnen pagina’s ophalen voor gebruikers.' }
	);

	// Trainingbots: blokkeren is een legitieme keuze, dus alleen informatief
	const blockedTraining = AI_TRAINING_BOTS.filter((bot) => isAgentBlocked(groups, bot));
	checks.push({
		id: 'geo-training-bots',
		label: 'AI-trainingbots',
		status: 'info',
		message:
			blockedTraining.length > 0
				? `${blockedTraining.length} van ${AI_TRAINING_BOTS.length} trainingbots geblokkeerd. Prima als dat een bewuste keuze is; dit beïnvloedt de zichtbaarheid in AI-zoekmachines niet.`
				: 'Geen trainingbots geblokkeerd — de content mag gebruikt worden voor het trainen van AI-modellen.',
		details: blockedTraining
	});

	// llms.txt — opkomende standaard, nog door geen grote AI-partij aantoonbaar gebruikt (per april 2026)
	const llmsRes = await fetchUrl(`${start.origin}/llms.txt`, 'text/plain,*/*');
	const llmsBody = llmsRes?.ok ? await llmsRes.text() : '';
	const looksLikeLlms =
		!!llmsRes?.ok &&
		!(llmsRes.headers.get('content-type') || '').includes('text/html') &&
		llmsBody.trim().length > 0;
	checks.push({
		id: 'geo-llms-txt',
		label: 'llms.txt',
		status: 'info',
		message: looksLikeLlms
			? 'llms.txt aanwezig. Let op: nog geen enkele grote AI-partij gebruikt dit bestand aantoonbaar — zie het als een pre.'
			: 'Geen llms.txt. Lage prioriteit: nog geen enkele grote AI-partij gebruikt dit bestand aantoonbaar.'
	});

	// Structured data helpt AI-systemen entiteiten begrijpen
	const okPages = pages.filter((p) => p.httpStatus > 0 && p.httpStatus < 400 && p.checks.some((c) => c.id === 'json-ld'));
	const withSchema = okPages.filter((p) => p.checks.some((c) => c.id === 'json-ld' && c.status === 'pass'));
	checks.push(
		okPages.length > 0 && withSchema.length === 0
			? {
					id: 'geo-structured-data',
					label: 'Structured data',
					status: 'warn',
					message: 'Geen enkele pagina heeft structured data — schema.org (Organization, LocalBusiness, FAQ, Service) helpt AI-systemen je content begrijpen en citeren.'
				}
			: {
					id: 'geo-structured-data',
					label: 'Structured data',
					status: 'pass',
					message: `${withSchema.length} van ${okPages.length} pagina's hebben structured data (JSON-LD).`
				}
	);

	// AI-crawlers renderen doorgaans geen JavaScript
	const jsThinPages = pages.filter((p) => p.checks.some((c) => c.id === 'content' && c.status === 'warn'));
	if (jsThinPages.length > 0) {
		checks.push({
			id: 'geo-js-content',
			label: 'Content zonder JavaScript',
			status: 'warn',
			message: `${jsThinPages.length} pagina('s) hebben nauwelijks content in de kale HTML. AI-crawlers renderen doorgaans geen JavaScript en zien deze pagina's dus als leeg.`,
			details: jsThinPages.slice(0, 10).map((p) => p.finalUrl)
		});
	}

	return checks;
}

function buildGoLiveChecklist(start: URL, pages: PageResult[], siteChecks: Check[]): Check[] {
	const goLive: Check[] = [];
	const find = (id: string) => siteChecks.find((c) => c.id === id);

	const noindexPages = pages.filter((p) => p.checks.some((c) => c.id === 'noindex' && c.status === 'warn'));
	goLive.push(
		noindexPages.length > 0
			? {
					id: 'golive-noindex',
					label: 'noindex uitzetten',
					status: 'warn',
					message: `${noindexPages.length} pagina('s) staan op noindex.`,
					details: noindexPages.slice(0, 10).map((p) => p.finalUrl)
				}
			: { id: 'golive-noindex', label: 'Indexeerbaar', status: 'pass', message: 'Geen pagina’s op noindex.' }
	);

	const robots = find('robots');
	if (robots) goLive.push({ ...robots, id: 'golive-robots' });

	const sitemap = find('sitemap-hosts') ?? find('sitemap');
	if (sitemap) goLive.push({ ...sitemap, id: 'golive-sitemap' });

	const https = find('https');
	if (https) goLive.push({ ...https, id: 'golive-https' });

	const stagingCanonicals = pages.filter((p) => p.checks.some((c) => c.id === 'canonical-host'));
	goLive.push(
		stagingCanonicals.length > 0
			? {
					id: 'golive-canonical',
					label: 'Canonicals naar juist domein',
					status: 'fail',
					message: `${stagingCanonicals.length} pagina('s) hebben een canonical naar een ander domein.`,
					details: stagingCanonicals.slice(0, 10).map((p) => p.finalUrl)
				}
			: { id: 'golive-canonical', label: 'Canonicals', status: 'pass', message: 'Alle canonicals wijzen naar dit domein.' }
	);

	const brokenLinks = find('broken-links');
	if (brokenLinks) goLive.push({ ...brokenLinks, id: 'golive-broken-links' });

	return goLive;
}
