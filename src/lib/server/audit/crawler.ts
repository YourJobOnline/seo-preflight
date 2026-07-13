import { env } from '$env/dynamic/private';
import type { AuditEvent, Check, PageResult, SiteResult } from '$lib/types';
import { scoreChecks } from '$lib/types';
import { analyzePage, parseHreflangs, type HreflangEntry } from './page-checks';
import { fetchVitals } from './vitals';

export interface CrawlOptions {
	maxPages: number;
	auth?: { user: string; pass: string };
	onEvent: (event: AuditEvent) => void;
}

const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 10;
const USER_AGENT = 'Mozilla/5.0 (compatible; SEO-Preflight/1.0)';

function normalize(url: string): string {
	const u = new URL(url);
	u.hash = '';
	if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
	return u.href;
}

function safeNormalize(url: string): string | null {
	try {
		return normalize(url);
	} catch {
		return null;
	}
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
	const hreflangMap = new Map<string, HreflangEntry[]>();
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

	/** Volgt redirects handmatig (i.p.v. auto-follow) om chains en statuscodes (301 vs 302) te kunnen zien. */
	async function walkRedirects(startUrl: string): Promise<{ hops: { url: string; status: number }[]; error: boolean }> {
		const hops: { url: string; status: number }[] = [];
		let current = startUrl;
		for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
			let res: Response;
			try {
				res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			} catch {
				return { hops, error: true };
			}
			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get('location');
				if (!location) return { hops, error: true };
				hops.push({ url: current, status: res.status });
				try {
					current = new URL(location, current).href;
				} catch {
					return { hops, error: true };
				}
				continue;
			}
			return { hops, error: false };
		}
		return { hops, error: true };
	}

	async function processUrl(url: string): Promise<void> {
		opts.onEvent({ type: 'progress', crawled: pages.length, queued: queue.length, url });
		const res = await fetchUrl(url);
		const from = [...(linkedFrom.get(url) ?? [])];

		if (!res) {
			const checks: Check[] = [
				{ id: 'http-status', label: 'Bereikbaarheid', status: 'fail', message: 'Pagina niet bereikbaar (timeout of netwerkfout).' }
			];
			const page: PageResult = { url, finalUrl: url, httpStatus: 0, title: null, description: null, checks, score: 0, linkedFrom: from, canonicalUrl: null };
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
			const page: PageResult = { url, finalUrl, httpStatus: res.status, title: null, description: null, checks, score: 0, linkedFrom: from, canonicalUrl: null };
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
			const page: PageResult = { url, finalUrl, httpStatus: res.status, title: null, description: null, checks, score: scoreChecks(checks), linkedFrom: from, canonicalUrl: null };
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

		if (analysis.hreflangs.length > 0) hreflangMap.set(normalize(finalUrl), analysis.hreflangs);

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
			linkedFrom: from,
			canonicalUrl: analysis.canonicalUrl
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

	const siteChecks = [
		...(await runSiteChecks(start, pages, fetchUrl, robotsTxt, ogImages)),
		...(await runHreflangChecks(hreflangMap, fetchUrl)),
		...(await runDuplicateUrlChecks(start, pages, fetchUrl)),
		...(await runRedirectChainChecks(pages, walkRedirects)),
		...runTestEnvNoindexCheck(pages),
		...runNofollowCheck(pages),
		...runAnalyticsChecks(pages)
	];
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

		// Sitemap: alleen canonieke URL's — en dekking t.o.v. de gecrawlde pagina's
		const sitemapSet = new Set(sitemapLocs.map(safeNormalize).filter((u): u is string => u !== null));
		const nonCanonical: string[] = [];
		const missingFromSitemap: string[] = [];
		for (const p of pages) {
			if (p.httpStatus < 200 || p.httpStatus >= 300) continue;
			const norm = safeNormalize(p.finalUrl);
			if (!norm) continue;
			const inSitemap = sitemapSet.has(norm);
			if (inSitemap && p.canonicalUrl) {
				const canonNorm = safeNormalize(p.canonicalUrl);
				if (canonNorm && canonNorm !== norm) {
					nonCanonical.push(`${p.finalUrl} staat in de sitemap, maar canonical wijst naar ${p.canonicalUrl}`);
				}
			}
			if (!inSitemap) missingFromSitemap.push(p.finalUrl);
		}
		checks.push(
			nonCanonical.length > 0
				? {
						id: 'sitemap-canonical-mismatch',
						label: "Sitemap: alleen canonical URL's",
						status: 'fail',
						message: `${nonCanonical.length} sitemap-URL('s) zijn niet de canonical versie van die pagina.`,
						details: nonCanonical.slice(0, 10)
					}
				: { id: 'sitemap-canonical-mismatch', label: "Sitemap: alleen canonical URL's", status: 'pass', message: 'Alle gecontroleerde sitemap-URL\'s zijn canoniek.' }
		);
		if (missingFromSitemap.length > 0) {
			checks.push({
				id: 'sitemap-coverage',
				label: "Sitemap-dekking (gecrawlde pagina's)",
				status: 'warn',
				message: `${missingFromSitemap.length} gecrawlde pagina('s) staan niet in de sitemap. Let op: dit is gebaseerd op de crawl, niet op trafficdata — controleer de écht belangrijkste pagina's altijd met Search Console/Analytics.`,
				details: missingFromSitemap.slice(0, 10)
			});
		} else {
			checks.push({
				id: 'sitemap-coverage',
				label: "Sitemap-dekking (gecrawlde pagina's)",
				status: 'pass',
				message: 'Alle gecrawlde pagina\'s staan in de sitemap (gebaseerd op de crawl, niet op trafficdata).'
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

/**
 * Wederkerigheid van hreflang: als pagina A naar taalvariant B verwijst,
 * moet B ook terugverwijzen naar A — anders negeert Google beide tags.
 */
async function runHreflangChecks(
	hreflangMap: Map<string, HreflangEntry[]>,
	fetchUrl: (url: string, accept?: string) => Promise<Response | null>
): Promise<Check[]> {
	if (hreflangMap.size === 0) return [];

	// Taalvarianten kunnen op een ander (sub)domein staan en zijn dan niet meegecrawld — beperkt bijhalen
	const MAX_EXTERNAL_FETCHES = 15;
	const externalCache = new Map<string, HreflangEntry[] | null>();
	let externalFetches = 0;
	let limitReached = false;

	async function getHreflangs(url: string): Promise<HreflangEntry[] | null> {
		const key = normalize(url);
		const crawled = hreflangMap.get(key);
		if (crawled) return crawled;
		if (externalCache.has(key)) return externalCache.get(key)!;
		if (externalFetches >= MAX_EXTERNAL_FETCHES) {
			limitReached = true;
			return null;
		}
		externalFetches++;
		const res = await fetchUrl(url);
		const contentType = res?.headers.get('content-type') || '';
		if (!res?.ok || !contentType.includes('text/html')) {
			externalCache.set(key, null);
			return null;
		}
		const entries = parseHreflangs(await res.text(), res.url || url);
		externalCache.set(key, entries);
		return entries;
	}

	const missing: string[] = [];
	const unreachable: string[] = [];
	const checkedPairs = new Set<string>();
	for (const [sourceUrl, entries] of hreflangMap) {
		for (const entry of entries) {
			let target: string;
			try {
				target = normalize(entry.href);
			} catch {
				continue;
			}
			if (target === sourceUrl) continue;
			const pairKey = `${sourceUrl}→${target}`;
			if (checkedPairs.has(pairKey)) continue;
			checkedPairs.add(pairKey);

			const targetEntries = await getHreflangs(entry.href);
			if (targetEntries === null) {
				if (!limitReached) unreachable.push(`${entry.href} (${entry.lang}) — niet bereikbaar of geen HTML`);
				continue;
			}
			const pointsBack = targetEntries.some((t) => {
				try {
					return normalize(t.href) === sourceUrl;
				} catch {
					return false;
				}
			});
			if (!pointsBack) missing.push(`${target} verwijst niet terug naar ${sourceUrl} (${entry.lang})`);
		}
	}

	const checks: Check[] = [];
	checks.push(
		missing.length > 0
			? {
					id: 'hreflang-reciprocal',
					label: 'Hreflang wederkerigheid',
					status: 'fail',
					message: `${missing.length} hreflang-verwijzing(en) zonder terugverwijzing — Google negeert niet-wederkerige hreflang-paren.`,
					details: missing.slice(0, 10)
				}
			: {
					id: 'hreflang-reciprocal',
					label: 'Hreflang wederkerigheid',
					status: 'pass',
					message: `Alle hreflang-verwijzingen zijn wederkerig (${hreflangMap.size} pagina's met hreflang gecheckt${limitReached ? `, externe varianten beperkt tot ${MAX_EXTERNAL_FETCHES}` : ''}).`
				}
	);
	if (unreachable.length > 0) {
		checks.push({
			id: 'hreflang-unreachable',
			label: 'Hreflang doelen',
			status: 'warn',
			message: `${unreachable.length} hreflang-doel(en) niet bereikbaar — controleer of deze taalvarianten bestaan.`,
			details: unreachable.slice(0, 10)
		});
	}
	return checks;
}

/**
 * Duplicate content: iedere pagina hoort precies één indexeerbare URL te hebben.
 * Test of varianten (www/non-www, trailing slash, hoofdletters) netjes redirecten of canonicaliseren.
 */
async function runDuplicateUrlChecks(
	start: URL,
	pages: PageResult[],
	fetchUrl: (url: string, accept?: string) => Promise<Response | null>
): Promise<Check[]> {
	const stripHash = (url: string) => {
		const u = new URL(url);
		u.hash = '';
		return u.href;
	};

	async function landsOn(url: string): Promise<{ finalUrl: string; status: number; canonical: string | null } | null> {
		const res = await fetchUrl(url);
		if (!res) return null;
		let canonical: string | null = null;
		if (res.status < 400 && (res.headers.get('content-type') || '').includes('text/html')) {
			const html = await res.text();
			const m =
				html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
				html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
			if (m) {
				try {
					canonical = stripHash(new URL(m[1], res.url || url).href);
				} catch {
					/* ongeldige canonical — al gemeld in page checks */
				}
			}
		}
		return { finalUrl: stripHash(res.url || url), status: res.status, canonical };
	}

	const okDetails: string[] = [];
	const warnDetails: string[] = [];
	const failDetails: string[] = [];

	async function testVariant(label: string, original: string, variant: string): Promise<void> {
		const [a, b] = [await landsOn(original), await landsOn(variant)];
		if (!a) return;
		if (!b) {
			warnDetails.push(`${label}: ${variant} is niet bereikbaar — stel een redirect naar ${a.finalUrl} in.`);
			return;
		}
		if (b.status >= 400) {
			okDetails.push(`${label}: variant geeft ${b.status} — geen duplicate.`);
			return;
		}
		if (b.finalUrl === a.finalUrl) {
			okDetails.push(`${label}: redirect naar dezelfde URL.`);
			return;
		}
		if (b.canonical && (b.canonical === a.finalUrl || b.canonical === a.canonical)) {
			warnDetails.push(`${label}: ${variant} geeft 200 maar canonicaliseert naar de juiste URL — een 301-redirect is sterker.`);
			return;
		}
		failDetails.push(`${label}: ${variant} is apart indexeerbaar (status ${b.status}, geen redirect of canonical naar ${a.finalUrl}).`);
	}

	// 1. www vs non-www (op de homepage)
	const wwwVariant = new URL(start.href);
	wwwVariant.host = start.host.startsWith('www.') ? start.host.slice(4) : `www.${start.host}`;
	await testVariant('www/non-www', start.href, wwwVariant.href);

	// 2 + 3. Trailing slash en hoofdletters (op een diepere pagina)
	const samplePage = pages.find((p) => {
		if (p.httpStatus < 200 || p.httpStatus >= 300) return false;
		try {
			const u = new URL(p.finalUrl);
			return u.host === start.host && u.pathname.length > 1 && !u.search;
		} catch {
			return false;
		}
	});
	if (samplePage) {
		const base = new URL(samplePage.finalUrl);
		const withSlash = new URL(base.href);
		withSlash.pathname = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : `${base.pathname}/`;
		await testVariant('trailing slash', base.href, withSlash.href);

		const upper = new URL(base.href);
		upper.pathname = base.pathname.toUpperCase();
		if (upper.pathname !== base.pathname) {
			await testVariant('hoofdletters', base.href, upper.href);
		}
	}

	const checks: Check[] = [];
	if (failDetails.length > 0) {
		checks.push({
			id: 'duplicate-urls',
			label: 'Eén indexeerbare URL',
			status: 'fail',
			message: `${failDetails.length} URL-variant(en) zijn apart indexeerbaar — duplicate content. Redirect alle varianten (301) naar één voorkeurs-URL.`,
			details: [...failDetails, ...warnDetails]
		});
	} else if (warnDetails.length > 0) {
		checks.push({
			id: 'duplicate-urls',
			label: 'Eén indexeerbare URL',
			status: 'warn',
			message: 'URL-varianten zijn grotendeels op orde, met aandachtspunten.',
			details: [...warnDetails, ...okDetails]
		});
	} else if (okDetails.length > 0) {
		checks.push({
			id: 'duplicate-urls',
			label: 'Eén indexeerbare URL',
			status: 'pass',
			message: 'www/non-www, trailing slash en hoofdletter-varianten verwijzen allemaal naar één URL.',
			details: okDetails
		});
	}
	return checks;
}

/**
 * Redirect chains en tijdelijke (302/307) i.p.v. permanente (301/308) redirects.
 * Volgt een steekproef van interne redirects handmatig om tussenliggende hops te zien
 * (de reguliere crawler gebruikt redirect:'follow' en verliest die informatie).
 */
async function runRedirectChainChecks(
	pages: PageResult[],
	walkRedirects: (url: string) => Promise<{ hops: { url: string; status: number }[]; error: boolean }>
): Promise<Check[]> {
	const MAX_SAMPLE = 20;
	const redirected = pages.filter((p) => p.url !== p.finalUrl).slice(0, MAX_SAMPLE);
	if (redirected.length === 0) return [];

	const chains: string[] = [];
	const nonPermanent: string[] = [];
	for (const p of redirected) {
		const { hops } = await walkRedirects(p.url);
		if (hops.length > 1) {
			chains.push(`${p.url} → ${hops.length} stappen → ${p.finalUrl}`);
		}
		const temporary = hops.filter((h) => h.status !== 301 && h.status !== 308);
		if (temporary.length > 0) {
			nonPermanent.push(`${p.url}: ${temporary.map((h) => h.status).join(', ')} (in plaats van 301)`);
		}
	}

	const checks: Check[] = [];
	checks.push(
		chains.length > 0
			? {
					id: 'redirect-chains',
					label: 'Redirect chains',
					status: 'warn',
					message: `${chains.length} redirect(s) gaan via meerdere stappen — los dit op tot één directe redirect.`,
					details: chains.slice(0, 10)
				}
			: {
					id: 'redirect-chains',
					label: 'Redirect chains',
					status: 'pass',
					message: `Geen redirect chains gevonden (${redirected.length} redirect(s) gecheckt).`
				}
	);
	checks.push(
		nonPermanent.length > 0
			? {
					id: 'redirect-type',
					label: 'Redirect-type (301 vs 302)',
					status: 'warn',
					message: `${nonPermanent.length} redirect(s) zijn tijdelijk (302/307) in plaats van permanent (301/308) — zoekmachines dragen ranking-signalen dan niet volledig over.`,
					details: nonPermanent.slice(0, 10)
				}
			: {
					id: 'redirect-type',
					label: 'Redirect-type (301 vs 302)',
					status: 'pass',
					message: 'Alle gecontroleerde redirects zijn permanent (301/308).'
				}
	);
	return checks;
}

/** Test-omgevingen horen volledig op noindex te staan; een live site juist niet. */
function runTestEnvNoindexCheck(pages: PageResult[]): Check[] {
	const okPages = pages.filter((p) => p.httpStatus > 0 && p.httpStatus < 400);
	if (okPages.length === 0) return [];
	const noindexCount = okPages.filter((p) => p.checks.some((c) => c.id === 'noindex' && c.status === 'warn')).length;
	if (noindexCount === okPages.length) {
		return [
			{
				id: 'testomgeving-noindex',
				label: 'Testomgeving op noindex',
				status: 'pass',
				message: `Alle ${okPages.length} gescande pagina's staan op noindex — geschikt als afgeschermde testomgeving.`
			}
		];
	}
	if (noindexCount === 0) {
		return [
			{
				id: 'testomgeving-noindex',
				label: 'Testomgeving op noindex',
				status: 'info',
				message: "Geen enkele pagina staat op noindex — dit lijkt een publieke/live omgeving, geen (afgeschermde) testomgeving."
			}
		];
	}
	return [
		{
			id: 'testomgeving-noindex',
			label: 'Testomgeving op noindex',
			status: 'warn',
			message: `${noindexCount} van ${okPages.length} pagina's staan op noindex — inconsistent voor een testomgeving.`
		}
	];
}

/** Dekking van robots-nofollow-metatags over de hele site. */
function runNofollowCheck(pages: PageResult[]): Check[] {
	const okPages = pages.filter((p) => p.httpStatus > 0 && p.httpStatus < 400);
	const withNofollow = okPages.filter((p) => p.checks.some((c) => c.id === 'nofollow' && c.status === 'warn'));
	if (okPages.length === 0) return [];
	return [
		withNofollow.length > 0
			? {
					id: 'nofollow-coverage',
					label: 'Robots nofollow-meta',
					status: 'warn',
					message: `${withNofollow.length} pagina('s) hebben een robots-nofollow-metatag — controleer of dat bedoeld is.`,
					details: withNofollow.slice(0, 10).map((p) => p.finalUrl)
				}
			: { id: 'nofollow-coverage', label: 'Robots nofollow-meta', status: 'pass', message: 'Geen enkele pagina heeft een robots-nofollow-metatag.' }
	];
}

/** Dekking van Analytics/Tag Manager over de hele site. */
function runAnalyticsChecks(pages: PageResult[]): Check[] {
	const okPages = pages.filter((p) => p.httpStatus > 0 && p.httpStatus < 400 && p.checks.some((c) => c.id === 'analytics'));
	if (okPages.length === 0) return [];
	const missing = okPages.filter((p) => p.checks.some((c) => c.id === 'analytics' && c.status === 'warn'));
	return [
		missing.length > 0
			? {
					id: 'analytics-coverage',
					label: 'Analytics-dekking',
					status: 'fail',
					message: `${missing.length} van ${okPages.length} pagina's missen Google Analytics of Tag Manager.`,
					details: missing.slice(0, 10).map((p) => p.finalUrl)
				}
			: { id: 'analytics-coverage', label: 'Analytics-dekking', status: 'pass', message: `Alle ${okPages.length} pagina's hebben Google Analytics of Tag Manager.` }
	];
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

	// Niet automatisch te checken — vaste reminder
	goLive.push({
		id: 'golive-search-console',
		label: 'Google Search Console',
		status: 'info',
		message:
			'Reminder: voeg de site toe in Search Console, verifieer het domein en dien de sitemap in. Check na livegang de dekking op indexatiefouten.'
	});

	return goLive;
}
