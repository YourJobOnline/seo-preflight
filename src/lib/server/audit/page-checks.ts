import { parseHTML } from 'linkedom';
import type { Check } from '$lib/types';

export interface HreflangEntry {
	lang: string;
	href: string;
}

export interface PageAnalysis {
	checks: Check[];
	title: string | null;
	description: string | null;
	internalLinks: string[];
	noindex: boolean;
	ogImage: string | null;
	canonicalUrl: string | null;
	hreflangs: HreflangEntry[];
}

/** Zelfde normalisatie als de crawler: hash weg, trailing slash weg (behalve root). */
export function normalizeUrl(url: string): string {
	const u = new URL(url);
	u.hash = '';
	if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
	return u.href;
}

/** Haalt alleen de hreflang-tags uit een HTML-document (voor de wederkerigheidscheck van de crawler). */
export function parseHreflangs(html: string, baseUrl: string): HreflangEntry[] {
	const { document } = parseHTML(html);
	const entries: HreflangEntry[] = [];
	for (const el of document.querySelectorAll('link[rel="alternate" i][hreflang]')) {
		const lang = el.getAttribute('hreflang')?.trim();
		const href = el.getAttribute('href')?.trim();
		if (!lang || !href) continue;
		try {
			entries.push({ lang, href: new URL(href, baseUrl).href });
		} catch {
			/* ongeldige URL negeren */
		}
	}
	return entries;
}

const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;
const THIN_CONTENT_WORDS = 150;

export function analyzePage(html: string, finalUrl: string, headers: Headers): PageAnalysis {
	const { document } = parseHTML(html);
	const checks: Check[] = [];
	const pageUrl = new URL(finalUrl);

	// --- Title ---
	const title = document.querySelector('title')?.textContent?.trim() || null;
	if (!title) {
		checks.push({ id: 'title', label: 'Paginatitel', status: 'fail', message: 'Geen <title> gevonden.' });
	} else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
		checks.push({
			id: 'title',
			label: 'Paginatitel',
			status: 'warn',
			message: `Titel is ${title.length} tekens (richtlijn: ${TITLE_MIN}–${TITLE_MAX}).`,
			details: [title]
		});
	} else {
		checks.push({ id: 'title', label: 'Paginatitel', status: 'pass', message: `“${title}” (${title.length} tekens).` });
	}

	// --- Meta description ---
	const description =
		document.querySelector('meta[name="description" i]')?.getAttribute('content')?.trim() || null;
	if (!description) {
		checks.push({ id: 'description', label: 'Meta description', status: 'fail', message: 'Geen meta description gevonden.' });
	} else if (description.length < DESC_MIN || description.length > DESC_MAX) {
		checks.push({
			id: 'description',
			label: 'Meta description',
			status: 'warn',
			message: `Description is ${description.length} tekens (richtlijn: ${DESC_MIN}–${DESC_MAX}).`,
			details: [description]
		});
	} else {
		checks.push({ id: 'description', label: 'Meta description', status: 'pass', message: `${description.length} tekens.` });
	}

	// --- H1 ---
	const h1s = [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim() || '');
	if (h1s.length === 0) {
		checks.push({ id: 'h1', label: 'H1', status: 'fail', message: 'Geen H1 op de pagina.' });
	} else if (h1s.length > 1) {
		checks.push({
			id: 'h1',
			label: 'H1',
			status: 'warn',
			message: `${h1s.length} H1's gevonden; gebruik er precies één.`,
			details: h1s
		});
	} else if (!h1s[0]) {
		checks.push({ id: 'h1', label: 'H1', status: 'fail', message: 'De H1 is leeg.' });
	} else {
		checks.push({ id: 'h1', label: 'H1', status: 'pass', message: `“${h1s[0]}”` });
	}

	// --- Heading-hiërarchie ---
	const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
	const skips: string[] = [];
	const empties: string[] = [];
	let prevLevel = 0;
	for (const h of headings) {
		const level = Number(h.tagName[1]);
		const text = h.textContent?.trim() || '';
		if (!text) empties.push(`<${h.tagName.toLowerCase()}> zonder tekst`);
		if (prevLevel > 0 && level > prevLevel + 1) {
			skips.push(`H${prevLevel} → H${level} (“${text.slice(0, 60)}”)`);
		}
		prevLevel = level;
	}
	if (skips.length > 0 || empties.length > 0) {
		checks.push({
			id: 'headings',
			label: 'Heading-structuur',
			status: 'warn',
			message: 'Overgeslagen niveaus of lege headings gevonden.',
			details: [...skips, ...empties]
		});
	} else if (headings.length > 0) {
		checks.push({ id: 'headings', label: 'Heading-structuur', status: 'pass', message: 'Geen overgeslagen niveaus.' });
	}

	// --- Alt-teksten ---
	const imgs = [...document.querySelectorAll('img')];
	const missingAlt = imgs.filter((img) => !img.hasAttribute('alt'));
	const emptyAlt = imgs.filter((img) => img.hasAttribute('alt') && !img.getAttribute('alt')?.trim());
	if (missingAlt.length > 0) {
		checks.push({
			id: 'img-alt',
			label: 'Alt-teksten',
			status: 'fail',
			message: `${missingAlt.length} van ${imgs.length} afbeeldingen zonder alt-attribuut.`,
			details: missingAlt.slice(0, 10).map((img) => img.getAttribute('src') || '(geen src)')
		});
	} else if (imgs.length > 0) {
		const note =
			emptyAlt.length > 0
				? ` (${emptyAlt.length} met lege alt — prima voor decoratieve afbeeldingen)`
				: '';
		checks.push({ id: 'img-alt', label: 'Alt-teksten', status: 'pass', message: `Alle ${imgs.length} afbeeldingen hebben een alt-attribuut${note}.` });
	}

	// --- Canonical ---
	const canonical = document.querySelector('link[rel="canonical" i]')?.getAttribute('href')?.trim();
	let canonicalResolved: URL | null = null;
	if (!canonical) {
		checks.push({ id: 'canonical', label: 'Canonical', status: 'warn', message: 'Geen canonical-tag gevonden.' });
	} else {
		let canonicalUrl: URL | null = null;
		try {
			canonicalUrl = new URL(canonical, finalUrl);
		} catch {
			/* ongeldig */
		}
		if (!canonicalUrl) {
			checks.push({ id: 'canonical', label: 'Canonical', status: 'fail', message: `Canonical is geen geldige URL: ${canonical}` });
		} else if (canonicalUrl.host !== pageUrl.host) {
			checks.push({
				id: 'canonical-host',
				label: 'Canonical',
				status: 'fail',
				message: `Canonical wijst naar een ander domein (${canonicalUrl.host}) — wijst deze nog naar staging of juist al naar productie?`,
				details: [canonical]
			});
		} else if (!/^https?:$/.test(canonicalUrl.protocol)) {
			checks.push({ id: 'canonical', label: 'Canonical', status: 'fail', message: `Canonical heeft een ongeldig protocol: ${canonical}` });
		} else {
			canonicalResolved = canonicalUrl;
			checks.push({ id: 'canonical', label: 'Canonical', status: 'pass', message: canonicalUrl.href });
		}
	}

	// --- Robots / noindex ---
	const metaRobots = document.querySelector('meta[name="robots" i]')?.getAttribute('content')?.toLowerCase() || '';
	const xRobots = headers.get('x-robots-tag')?.toLowerCase() || '';
	const noindex = metaRobots.includes('noindex') || xRobots.includes('noindex');
	if (noindex) {
		checks.push({
			id: 'noindex',
			label: 'Indexeerbaarheid',
			status: 'warn',
			message: 'Pagina staat op noindex. Prima tijdens de bouw, maar vergeet dit niet uit te zetten bij livegang.',
			details: [metaRobots ? `meta robots: ${metaRobots}` : `X-Robots-Tag: ${xRobots}`]
		});
	} else {
		checks.push({ id: 'noindex', label: 'Indexeerbaarheid', status: 'pass', message: 'Pagina is indexeerbaar (geen noindex).' });
	}

	// --- Canonical + noindex: tegenstrijdige signalen ---
	// Een canonical naar een andere pagina zegt "indexeer díe URL", noindex zegt "indexeer niets".
	// Google kan de noindex dan via de canonical laten doorwerken op de doelpagina.
	if (noindex && canonicalResolved && normalizeUrl(canonicalResolved.href) !== normalizeUrl(finalUrl)) {
		checks.push({
			id: 'canonical-noindex',
			label: 'Canonical + noindex',
			status: 'fail',
			message: 'Pagina heeft een canonical naar een andere URL én staat op noindex — tegenstrijdige signalen. Kies er één: óf canonical, óf noindex.',
			details: [`canonical: ${canonicalResolved.href}`]
		});
	}

	// --- Robots nofollow ---
	const nofollow = metaRobots.includes('nofollow') || xRobots.includes('nofollow');
	checks.push(
		nofollow
			? {
					id: 'nofollow',
					label: 'Robots nofollow',
					status: 'warn',
					message: 'Pagina heeft een robots-nofollow-metatag — links op deze pagina worden niet gevolgd.',
					details: [metaRobots.includes('nofollow') ? `meta robots: ${metaRobots}` : `X-Robots-Tag: ${xRobots}`]
				}
			: { id: 'nofollow', label: 'Robots nofollow', status: 'pass', message: 'Geen robots-nofollow-metatag.' }
	);

	// --- Analytics / Tag Manager ---
	const scripts = [...document.querySelectorAll('script')];
	const scriptSrcs = scripts.map((s) => s.getAttribute('src') || '');
	const inlineScripts = scripts.map((s) => s.textContent || '').join('\n');
	const hasGtm = scriptSrcs.some((src) => src.includes('googletagmanager.com/gtm.js')) || inlineScripts.includes('googletagmanager.com/gtm.js');
	const hasGa =
		hasGtm ||
		scriptSrcs.some((src) => src.includes('googletagmanager.com/gtag/js') || src.includes('google-analytics.com/analytics.js')) ||
		/gtag\s*\(\s*['"]config['"]/.test(inlineScripts);
	checks.push(
		hasGa
			? { id: 'analytics', label: 'Analytics/Tag Manager', status: 'pass', message: `${hasGtm ? 'Google Tag Manager' : 'Google Analytics'} gevonden in de broncode.` }
			: {
					id: 'analytics',
					label: 'Analytics/Tag Manager',
					status: 'warn',
					message: 'Geen Google Analytics- of Tag Manager-script gevonden in de broncode.'
				}
	);

	// --- Basis-hygiëne: lang, charset, viewport ---
	const lang = document.documentElement?.getAttribute('lang')?.trim();
	checks.push(
		lang
			? { id: 'lang', label: 'Taal (lang)', status: 'pass', message: `<html lang="${lang}">` }
			: { id: 'lang', label: 'Taal (lang)', status: 'warn', message: 'Geen lang-attribuut op <html>.' }
	);
	const hasCharset = !!document.querySelector('meta[charset]');
	if (!hasCharset) {
		checks.push({ id: 'charset', label: 'Charset', status: 'warn', message: 'Geen <meta charset> gevonden.' });
	}
	const hasViewport = !!document.querySelector('meta[name="viewport" i]');
	checks.push(
		hasViewport
			? { id: 'viewport', label: 'Viewport', status: 'pass', message: 'Viewport-meta aanwezig.' }
			: { id: 'viewport', label: 'Viewport', status: 'fail', message: 'Geen viewport-meta — pagina is niet mobielvriendelijk ingesteld.' }
	);

	// --- Open Graph / social ---
	const og = (prop: string) =>
		document.querySelector(`meta[property="og:${prop}" i]`)?.getAttribute('content')?.trim();
	const missingOg = ['title', 'description', 'image'].filter((p) => !og(p));
	if (missingOg.length === 3) {
		checks.push({ id: 'og', label: 'Open Graph', status: 'warn', message: 'Geen Open Graph-tags — links delen op social media zonder preview.' });
	} else if (missingOg.length > 0) {
		checks.push({ id: 'og', label: 'Open Graph', status: 'warn', message: `Open Graph onvolledig: og:${missingOg.join(', og:')} ontbreekt.` });
	} else {
		checks.push({ id: 'og', label: 'Open Graph', status: 'pass', message: 'og:title, og:description en og:image aanwezig.' });
	}
	const ogUrl = og('url');
	if (ogUrl) {
		try {
			const ogUrlParsed = new URL(ogUrl, finalUrl);
			if (ogUrlParsed.host !== pageUrl.host) {
				checks.push({
					id: 'og-url-host',
					label: 'Open Graph URL',
					status: 'warn',
					message: `og:url wijst naar een ander domein (${ogUrlParsed.host}) — staging-restant?`,
					details: [ogUrl]
				});
			}
		} catch {
			checks.push({ id: 'og-url-host', label: 'Open Graph URL', status: 'warn', message: `og:url is geen geldige URL: ${ogUrl}` });
		}
	}

	// --- Hreflang (meertalige sites) ---
	const hreflangs: HreflangEntry[] = [];
	const invalidHreflangs: string[] = [];
	for (const el of document.querySelectorAll('link[rel="alternate" i][hreflang]')) {
		const lang = el.getAttribute('hreflang')?.trim() || '';
		const href = el.getAttribute('href')?.trim() || '';
		if (!href) {
			invalidHreflangs.push(`hreflang="${lang}" zonder href`);
			continue;
		}
		try {
			hreflangs.push({ lang, href: new URL(href, finalUrl).href });
		} catch {
			invalidHreflangs.push(`hreflang="${lang}" met ongeldige URL: ${href}`);
		}
	}
	if (hreflangs.length > 0 || invalidHreflangs.length > 0) {
		// Taalcodes: ISO 639-1, optioneel met regio (ISO 3166-1), of x-default
		const badCodes = hreflangs
			.filter((h) => h.lang.toLowerCase() !== 'x-default' && !/^[a-z]{2}(-[a-z]{2})?$/i.test(h.lang))
			.map((h) => h.lang);
		if (badCodes.length > 0 || invalidHreflangs.length > 0) {
			checks.push({
				id: 'hreflang-valid',
				label: 'Hreflang',
				status: 'fail',
				message: 'Ongeldige hreflang-tags gevonden.',
				details: [...badCodes.map((c) => `ongeldige taalcode: "${c}" (verwacht bijv. "nl" of "nl-BE")`), ...invalidHreflangs]
			});
		}

		// Zelfverwijzing: elke pagina moet in zijn eigen hreflang-set staan
		const self = normalizeUrl(finalUrl);
		const hasSelf = hreflangs.some((h) => {
			try {
				return normalizeUrl(h.href) === self;
			} catch {
				return false;
			}
		});
		checks.push(
			hasSelf
				? { id: 'hreflang-self', label: 'Hreflang zelfverwijzing', status: 'pass', message: 'De pagina verwijst in de hreflang-set naar zichzelf.' }
				: {
						id: 'hreflang-self',
						label: 'Hreflang zelfverwijzing',
						status: 'fail',
						message: 'Geen hreflang-tag die naar deze pagina zelf verwijst — vereist, anders negeert Google de hele set.',
						details: hreflangs.slice(0, 10).map((h) => `${h.lang} → ${h.href}`)
					}
		);

		// x-default: vangnet voor talen die niet in de set zitten
		const hasXDefault = hreflangs.some((h) => h.lang.toLowerCase() === 'x-default');
		checks.push(
			hasXDefault
				? { id: 'hreflang-xdefault', label: 'Hreflang x-default', status: 'pass', message: 'x-default is ingesteld.' }
				: { id: 'hreflang-xdefault', label: 'Hreflang x-default', status: 'warn', message: 'Geen x-default in de hreflang-set — stel in welke taalversie bezoekers buiten je doeltalen krijgen.' }
		);
	}

	// --- Structured data ---
	const jsonLdScripts = [...document.querySelectorAll('script[type="application/ld+json" i]')];
	if (jsonLdScripts.length > 0) {
		const invalid: string[] = [];
		const types: string[] = [];
		const missingFields: string[] = [];
		for (const script of jsonLdScripts) {
			try {
				const data = JSON.parse(script.textContent || '');
				const items = Array.isArray(data) ? data : data?.['@graph'] ? data['@graph'] : [data];
				for (const item of items) {
					const t = item?.['@type'];
					if (!t) continue;
					types.push(String(t));
					missingFields.push(...validateSchemaFields(item));
				}
			} catch (e) {
				invalid.push(e instanceof Error ? e.message : 'ongeldige JSON');
			}
		}
		checks.push(
			invalid.length > 0
				? { id: 'json-ld', label: 'Structured data', status: 'fail', message: `${invalid.length} JSON-LD-blok(ken) met ongeldige JSON.`, details: invalid }
				: { id: 'json-ld', label: 'Structured data', status: 'pass', message: `JSON-LD aanwezig${types.length ? ` (${[...new Set(types)].join(', ')})` : ''}.` }
		);
		if (missingFields.length > 0) {
			checks.push({
				id: 'json-ld-fields',
				label: 'Structured data-velden',
				status: 'warn',
				message: 'JSON-LD mist aanbevolen velden.',
				details: [...new Set(missingFields)]
			});
		}
	} else {
		checks.push({ id: 'json-ld', label: 'Structured data', status: 'info', message: 'Geen JSON-LD gevonden. Niet verplicht, wel een kans (bijv. Organization, LocalBusiness, FAQ).' });
	}

	// --- Mixed content (http-resources op een https-pagina) ---
	if (pageUrl.protocol === 'https:') {
		const insecure: string[] = [];
		for (const el of document.querySelectorAll('img[src], script[src], iframe[src], source[src], video[src], audio[src]')) {
			const src = el.getAttribute('src') || '';
			if (src.startsWith('http://')) insecure.push(src);
		}
		for (const el of document.querySelectorAll('link[rel="stylesheet" i][href]')) {
			const href = el.getAttribute('href') || '';
			if (href.startsWith('http://')) insecure.push(href);
		}
		if (insecure.length > 0) {
			checks.push({
				id: 'mixed-content',
				label: 'Mixed content',
				status: 'fail',
				message: `${insecure.length} resource(s) laden via http:// op een https-pagina — browsers blokkeren deze.`,
				details: insecure.slice(0, 10)
			});
		}
	}

	// --- Dunne content ---
	const bodyText = document.body?.textContent || '';
	const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
	if (wordCount < THIN_CONTENT_WORDS) {
		checks.push({
			id: 'content',
			label: 'Content',
			status: 'warn',
			message: `Slechts ~${wordCount} woorden zichtbaar in de HTML. Dunne content, of de pagina rendert via JavaScript.`
		});
	} else {
		checks.push({ id: 'content', label: 'Content', status: 'pass', message: `~${wordCount} woorden.` });
	}

	// --- Interne links verzamelen (voor de crawler) ---
	const internalLinks: string[] = [];
	for (const a of document.querySelectorAll('a[href]')) {
		const href = a.getAttribute('href') || '';
		if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
		try {
			const resolved = new URL(href, finalUrl);
			if (resolved.host === pageUrl.host && /^https?:$/.test(resolved.protocol)) {
				resolved.hash = '';
				internalLinks.push(resolved.href);
			}
		} catch {
			/* ongeldige href negeren */
		}
	}

	return {
		checks,
		title,
		description,
		internalLinks,
		noindex,
		ogImage: og('image') || null,
		canonicalUrl: canonicalResolved?.href ?? null,
		hreflangs
	};
}

// Aanbevolen velden per veelgebruikt schema.org-type
const SCHEMA_REQUIRED_FIELDS: Record<string, string[]> = {
	Organization: ['name', 'url'],
	LocalBusiness: ['name', 'address', 'telephone'],
	Product: ['name', 'offers'],
	FAQPage: ['mainEntity'],
	Article: ['headline', 'datePublished'],
	BlogPosting: ['headline', 'datePublished'],
	NewsArticle: ['headline', 'datePublished'],
	BreadcrumbList: ['itemListElement'],
	Service: ['name', 'provider'],
	Event: ['name', 'startDate', 'location'],
	JobPosting: ['title', 'datePosted', 'hiringOrganization'],
	Recipe: ['name', 'image']
};

function validateSchemaFields(item: Record<string, unknown>): string[] {
	const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
	const missing: string[] = [];
	for (const type of types) {
		const required = SCHEMA_REQUIRED_FIELDS[String(type)];
		if (!required) continue;
		for (const field of required) {
			const value = item[field];
			if (value === undefined || value === null || value === '') {
				missing.push(`${type}: veld “${field}” ontbreekt`);
			}
		}
	}
	return missing;
}
