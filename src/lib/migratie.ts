// SEO-migratiechecklist — overgenomen uit de interne Excel "Migratie checklist" (Online Klik)

export interface MigratieItem {
	id: string;
	taak: string;
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
					{ id: 'nieuwe-sitemap', taak: 'Nieuwe sitemap.xml' },
					{ id: 'sitemap-root', taak: 'Uploaden/updaten van nieuwe sitemap.xml in de root van de website' },
					{ id: 'sitemap-canonical', taak: 'Gebruik alleen de canonical URL\'s in de sitemap' },
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
					{ id: 'psi-templates', taak: 'Check PageSpeed-score van Google van de verschillende templates' },
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
					{ id: 'hreflang', taak: 'Hreflang-elementen instellen (bij meertalige websites)' }
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
					{ id: 'test-redirects', taak: 'Controleren van redirects in deze fase' },
					{ id: 'test-slash', taak: 'Check URL\'s op "/" en geen "/"' },
					{ id: 'test-www', taak: 'Check URL\'s op www. en non-www.' },
					{ id: 'test-hoofdletters', taak: 'Krijgen URL\'s met een hoofdletter de juiste canonical?' },
					{ id: 'test-robots', taak: 'Check op robots.txt' },
					{ id: 'test-sitemap', taak: 'Sitemap.xml ok?' },
					{ id: 'test-dode-links', taak: 'Controle op dode links (crawl van de testomgeving)' },
					{ id: 'test-structured-data', taak: 'Structured data aanwezig?' },
					{ id: 'test-redirects-def', taak: 'Definitieve redirects opleveren' },
					{ id: 'test-robots-upload', taak: 'Robots.txt aanpassen en uploaden' },
					{ id: 'test-sitemap-opleveren', taak: 'Opleveren van (nieuwe) sitemap.xml' },
					{ id: 'test-performance', taak: 'Nogmaals check van testomgeving-URL\'s in WebPageTest en PageSpeed-score' }
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
					{ id: 'live-redirects', taak: 'Redirect-checks' },
					{ id: 'live-sitemap', taak: 'Nieuwe sitemap uploaden in de root van de website' },
					{ id: 'live-robots', taak: 'Afwijkingen in het robots.txt-bestand' },
					{ id: 'live-noindex', taak: '"robots noindex" metatags op pagina\'s' },
					{ id: 'live-nofollow', taak: '"robots nofollow" metatags in de broncode' },
					{ id: 'live-301', taak: '302-redirects in plaats van 301-redirects' },
					{ id: 'live-gsc', taak: 'Verifieer Search Console op fouten' },
					{ id: 'live-sitemap-fouten', taak: 'Verifieer XML-sitemap op fouten' },
					{ id: 'live-migratie', taak: 'Ontbrekende of verkeerd gemigreerde pagina\'s' },
					{ id: 'live-404', taak: 'Zorg ervoor dat de 404-pagina ook een 404-statuscode geeft' },
					{ id: 'live-analytics', taak: 'Zorg dat de Analytics-trackingcode op alle pagina\'s aanwezig en goed ingericht is' },
					{ id: 'live-performance', taak: 'Vergelijk de site-performance van de nieuwe site met de oude (alle typen pagina\'s)' },
					{ id: 'live-wijzigingen', taak: 'Wijzigingen doorvoeren op basis van bovenstaande checks' },
					{ id: 'live-adreswijziging', taak: 'Bij wijziging in domeinnaam of ccTLD: adreswijziging toevoegen in Search Console' }
				]
			}
		]
	}
];
