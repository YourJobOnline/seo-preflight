// SEO-migratiechecklist — overgenomen uit de interne Excel "Migratie checklist" (Online Klik)

import type { Check } from './types';

export interface MigratieItem {
	id: string;
	taak: string;
	/** Check-id's uit de scan die dit item automatisch kunnen aftekenen. */
	auto?: string[];
	/** Item is ook ok als geen van de auto-checks in het resultaat zit (checks die alleen bij problemen verschijnen). */
	autoAbsentOk?: boolean;
}

export interface MigratieCategorie {
	id: string;
	titel: string;
	items: MigratieItem[];
}

export interface MigratieFase {
	id: string;
	titel: string;
	categorieen: MigratieCategorie[];
}

export type Verantwoordelijke = '' | 'webbouwer' | 'onlineklik' | 'beide';

export interface ItemState {
	done: boolean;
	wie: Verantwoordelijke;
	opmerking: string;
}

export interface MigratieState {
	items: Record<string, ItemState>;
	categorieOpmerkingen: Record<string, string>;
}

export const STORAGE_PREFIX = 'seo-preflight:migratie:';
export const AUTO_NOTE_PREFIX = '🤖 ';

export function emptyItem(): ItemState {
	return { done: false, wie: '', opmerking: '' };
}

/** Lege state met alle items en categorie-opmerkingen vooraf geïnitialiseerd. */
export function emptyState(): MigratieState {
	const state: MigratieState = { items: {}, categorieOpmerkingen: {} };
	for (const fase of MIGRATIE_CHECKLIST) {
		for (const cat of fase.categorieen) {
			state.categorieOpmerkingen[`${fase.id}:${cat.id}`] = '';
			for (const it of cat.items) state.items[it.id] = emptyItem();
		}
	}
	return state;
}

/** Laadt de checklist van een project uit localStorage (alleen in de browser aanroepen). */
export function loadChecklist(project: string): MigratieState {
	const state = emptyState();
	const raw = localStorage.getItem(STORAGE_PREFIX + project);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as MigratieState;
			for (const [id, s] of Object.entries(parsed.items ?? {})) {
				if (state.items[id]) state.items[id] = { ...emptyItem(), ...s };
			}
			for (const [key, note] of Object.entries(parsed.categorieOpmerkingen ?? {})) {
				if (key in state.categorieOpmerkingen) state.categorieOpmerkingen[key] = note;
			}
		} catch {
			/* corrupte opslag — begin opnieuw */
		}
	}
	return state;
}

export function saveChecklist(project: string, state: MigratieState): void {
	localStorage.setItem(STORAGE_PREFIX + project, JSON.stringify(state));
}

export function listProjects(): string[] {
	return Object.keys(localStorage)
		.filter((k) => k.startsWith(STORAGE_PREFIX))
		.map((k) => k.slice(STORAGE_PREFIX.length))
		.sort();
}

export interface ApplyResult {
	afgevinkt: string[];
	openstaand: string[];
}

/**
 * Past scanresultaten toe op de checklist: items waarvan alle gekoppelde checks slagen
 * worden afgevinkt; bij problemen wordt het vinkje weggehaald en de bevinding als
 * opmerking gezet. Handmatige opmerkingen van de gebruiker blijven staan.
 */
export function applyAuditToChecklist(allChecks: Check[], state: MigratieState): ApplyResult {
	const datum = new Date().toLocaleDateString('nl-NL');
	const result: ApplyResult = { afgevinkt: [], openstaand: [] };

	const setNote = (item: ItemState, note: string) => {
		// Alleen lege of eerder automatisch gezette opmerkingen overschrijven
		if (!item.opmerking || item.opmerking.startsWith(AUTO_NOTE_PREFIX)) {
			item.opmerking = `${AUTO_NOTE_PREFIX}${note}`;
		}
	};

	for (const fase of MIGRATIE_CHECKLIST) {
		for (const cat of fase.categorieen) {
			for (const def of cat.items) {
				if (!def.auto) continue;
				const item = state.items[def.id];
				if (!item) continue;

				const relevant = allChecks.filter((c) => def.auto!.includes(c.id));
				if (relevant.length === 0) {
					if (def.autoAbsentOk) {
						item.done = true;
						setNote(item, `Scan ${datum}: geen problemen gevonden.`);
						result.afgevinkt.push(def.id);
					}
					// Anders: check niet uitgevoerd (bijv. hreflang op eentalige site) — handmatig laten
					continue;
				}

				const problemen = relevant.filter((c) => c.status === 'fail' || c.status === 'warn');
				if (problemen.length === 0) {
					item.done = true;
					setNote(item, `Scan ${datum}: in orde.`);
					result.afgevinkt.push(def.id);
				} else {
					item.done = false;
					setNote(item, `Scan ${datum}: ${problemen.map((p) => p.message).join(' | ').slice(0, 300)}`);
					result.openstaand.push(def.id);
				}
			}
		}
	}
	return result;
}

export const MIGRATIE_CHECKLIST: MigratieFase[] = [
	{
		id: 'voorbereiding',
		titel: 'Voorbereidingsfase',
		categorieen: [
			{
				id: 'algemeen',
				titel: 'Algemeen',
				items: [
					{ id: 'stakeholders', taak: 'Inventarisatie stakeholders: wie zijn er betrokken en wat is ieders rol?' },
					{ id: 'doelen', taak: "Doelen en KPI's afstemmen: wanneer is de migratie succesvol?" },
					{ id: 'planning', taak: 'Migratiemoment realistisch plannen (minimaal 3 maanden, anders no-go)' },
					{ id: 'redirectplan', taak: 'Redirectplan opmaken' },
					{ id: 'inplannen', taak: 'Inplannen + opzetten migratie' },
					{ id: 'top500', taak: 'Top 500 URL\'s check (indicatief — ga voor 80–90% van traffic/best converterend)' }
				]
			},
			{
				id: 'sitemap',
				titel: 'Sitemap.xml',
				items: [
					{ id: 'nieuwe-sitemap', taak: 'Nieuwe sitemap.xml', auto: ['sitemap'] },
					{ id: 'sitemap-root', taak: 'Uploaden/updaten van nieuwe sitemap.xml in de root van de website', auto: ['sitemap'] },
					{ id: 'sitemap-canonical', taak: 'Gebruik alleen de canonical URL\'s in de sitemap', auto: ['sitemap', 'sitemap-noindex'] },
					{ id: 'sitemap-opbouw', taak: 'Gebruik dezelfde opbouw als de website' },
					{ id: 'sitemap-top500', taak: 'Controle of top 500 pagina\'s in sitemap.xml zijn opgenomen' },
					{ id: 'sitemap-gsc', taak: 'Controle of de sitemap goed wordt opgepakt binnen Google Search Console' },
					{ id: 'sitemap-structuur', taak: 'Check structuur binnen de sitemap' }
				]
			},
			{
				id: '404',
				titel: '404-meldingen in kaart brengen',
				items: [
					{ id: '404-huidig', taak: 'Belangrijkste huidige 404-meldingen in kaart brengen' },
					{ id: '404-redirect', taak: 'Redirecten van de belangrijkste foutmeldingen en meenemen in URL-mapping' },
					{ id: '404-nieuw', taak: 'Nieuwe 404\'s die ontstaan op korte termijn oppakken en redirecten' }
				]
			},
			{
				id: 'performance',
				titel: 'Performance check',
				items: [
					{ id: 'psi-templates', taak: 'Check PageSpeed-score van Google van de verschillende templates', auto: ['vitals-performance'] },
					{ id: 'nulmeting', taak: 'Maak een nulmeting van performance van verschillende templates met WebPageTest' },
					{ id: 'verbeterpunten', taak: 'Toelichting + controle van technische verbeterpunten om mee te nemen in de nieuwe website' }
				]
			},
			{
				id: 'rankings',
				titel: 'Rankings',
				items: [
					{ id: 'rankings-focus', taak: 'Rankings checken van focuszoekwoorden (Search Console)' },
					{ id: 'rankings-alle', taak: 'Rankings checken van alle zoekwoorden (Search Console)' }
				]
			},
			{
				id: 'techniek',
				titel: 'Technische elementen',
				items: [
					{ id: 'urlstructuur', taak: 'Inzichtelijk maken van nieuwe URL-structuur' },
					{ id: 'structuur-klant', taak: 'Nieuwe websitestructuur gezamenlijk met klant bespreken' },
					{ id: 'url-top500', taak: 'Check URL-structuur van belangrijkste top 500 pagina\'s' },
					{ id: 'indexatie-webbouwer', taak: 'In samenspraak met webbouwers passende oplossingen bespreken voor goede indexatie' },
					{ id: 'template-elementen', taak: 'Voorstel doen voor passende elementen van de verschillende templates' },
					{ id: 'content-structuur', taak: 'Inzichtelijk maken of voor de top 500 pagina\'s iets verandert aan de contentstructuur' },
					{ id: 'content-templates', taak: 'Contentmogelijkheden checken bij verschillende templates' },
					{
						id: 'hreflang',
						taak: 'Hreflang-elementen instellen (bij meertalige websites)',
						auto: ['hreflang-valid', 'hreflang-self', 'hreflang-xdefault', 'hreflang-reciprocal']
					}
				]
			},
			{
				id: 'redirectmapping',
				titel: 'Redirectmapping',
				items: [
					{ id: 'redirects-top500', taak: 'Controleren van alle redirects met focus op de 500 belangrijkste pagina\'s' },
					{ id: 'redirects-overzicht', taak: 'In kaart brengen van alle huidige en nieuwe redirects' },
					{ id: 'redirect-chains', taak: 'Controleren of er redirect chains zijn en deze gelijk oplossen bij migratie' }
				]
			},
			{
				id: 'mapping',
				titel: 'Mapping-proces',
				items: [
					{ id: 'mapping-meedenken', taak: 'Meedenken met praktische redirect-oplossingen' },
					{ id: 'mapping-controle', taak: 'Controleren van redirects' },
					{ id: 'mapping-testen', taak: 'Uitvoer + testen van redirects' },
					{ id: 'redirect-script', taak: 'Eventueel ontwikkelen van een redirect-script (voor duizenden URL\'s in één keer)' }
				]
			},
			{
				id: 'testen',
				titel: 'Testen',
				items: [
					{ id: 'testomgeving', taak: 'Testomgeving beschikbaar en op noindex?' },
					{ id: 'test-redirects', taak: 'Controleren van redirects in deze fase', auto: ['redirect-links'], autoAbsentOk: true },
					{ id: 'test-slash', taak: 'Check URL\'s op "/" en geen "/"', auto: ['duplicate-urls'] },
					{ id: 'test-www', taak: 'Check URL\'s op www. en non-www.', auto: ['duplicate-urls'] },
					{ id: 'test-hoofdletters', taak: 'Krijgen URL\'s met een hoofdletter de juiste canonical?', auto: ['duplicate-urls'] },
					{ id: 'test-robots', taak: 'Check op robots.txt', auto: ['robots'] },
					{ id: 'test-sitemap', taak: 'Sitemap.xml ok?', auto: ['sitemap', 'sitemap-hosts'] },
					{ id: 'test-dode-links', taak: 'Controle op dode links (crawl van de testomgeving)', auto: ['broken-links'] },
					{ id: 'test-structured-data', taak: 'Structured data aanwezig?', auto: ['geo-structured-data'] },
					{ id: 'test-redirects-def', taak: 'Definitieve redirects opleveren' },
					{ id: 'test-robots-upload', taak: 'Robots.txt aanpassen en uploaden' },
					{ id: 'test-sitemap-opleveren', taak: 'Opleveren van (nieuwe) sitemap.xml' },
					{ id: 'test-performance', taak: 'Nogmaals check van testomgeving-URL\'s in WebPageTest en PageSpeed-score', auto: ['vitals-performance'] }
				]
			}
		]
	},
	{
		id: 'livegang',
		titel: 'Livegang',
		categorieen: [
			{
				id: 'livegang-checks',
				titel: 'Checks bij livegang',
				items: [
					{ id: 'live-redirects', taak: 'Redirect-checks', auto: ['redirect-links'], autoAbsentOk: true },
					{ id: 'live-sitemap', taak: 'Nieuwe sitemap uploaden in de root van de website', auto: ['sitemap', 'sitemap-hosts'] },
					{ id: 'live-robots', taak: 'Afwijkingen in het robots.txt-bestand', auto: ['robots'] },
					{ id: 'live-noindex', taak: '"robots noindex" metatags op pagina\'s', auto: ['golive-noindex'] },
					{ id: 'live-nofollow', taak: '"robots nofollow" metatags in de broncode' },
					{ id: 'live-301', taak: '302-redirects in plaats van 301-redirects' },
					{ id: 'live-gsc', taak: 'Verifieer Search Console op fouten' },
					{ id: 'live-sitemap-fouten', taak: 'Verifieer XML-sitemap op fouten', auto: ['sitemap', 'sitemap-hosts', 'sitemap-noindex'] },
					{ id: 'live-migratie', taak: 'Ontbrekende of verkeerd gemigreerde pagina\'s' },
					{ id: 'live-404', taak: 'Zorg ervoor dat de 404-pagina ook een 404-statuscode geeft', auto: ['soft-404'] },
					{ id: 'live-analytics', taak: 'Zorg dat de Analytics-trackingcode op alle pagina\'s aanwezig en goed ingericht is' },
					{ id: 'live-performance', taak: 'Vergelijk de site-performance van de nieuwe site met de oude (alle typen pagina\'s)' },
					{ id: 'live-wijzigingen', taak: 'Wijzigingen doorvoeren op basis van bovenstaande checks' },
					{ id: 'live-adreswijziging', taak: 'Bij wijziging in domeinnaam of ccTLD: adreswijziging toevoegen in Search Console' }
				]
			}
		]
	}
];
