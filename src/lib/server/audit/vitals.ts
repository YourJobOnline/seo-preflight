import type { Check } from '$lib/types';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_TIMEOUT_MS = 75_000;

function isPubliclyReachable(url: URL): boolean {
	const host = url.hostname;
	return !(
		host === 'localhost' ||
		host.endsWith('.local') ||
		host.endsWith('.test') ||
		/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
	);
}

/** Haalt Core Web Vitals op via de PageSpeed Insights API (alleen voor de start-URL). */
export async function fetchVitals(startUrl: string, apiKey?: string): Promise<Check[]> {
	const url = new URL(startUrl);
	if (!isPubliclyReachable(url)) {
		return [
			{
				id: 'vitals-skipped',
				label: 'Core Web Vitals',
				status: 'info',
				message: 'Overgeslagen: PageSpeed Insights kan alleen publiek bereikbare sites meten (geen localhost of interne omgevingen).'
			}
		];
	}

	const params = new URLSearchParams({ url: url.href, strategy: 'mobile', category: 'performance' });
	if (apiKey) params.set('key', apiKey);

	let data: Record<string, unknown>;
	try {
		const res = await fetch(`${PSI_ENDPOINT}?${params}`, {
			signal: AbortSignal.timeout(PSI_TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`PSI gaf status ${res.status}`);
		data = await res.json();
	} catch (e) {
		return [
			{
				id: 'vitals-error',
				label: 'Core Web Vitals',
				status: 'info',
				message: `Core Web Vitals konden niet worden opgehaald (${e instanceof Error ? e.message : 'onbekende fout'}). Zonder API-key is de limiet van Google snel bereikt — voeg PAGESPEED_API_KEY toe aan .env.`
			}
		];
	}

	const checks: Check[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const lighthouse = data.lighthouseResult as any;
	const audits = lighthouse?.audits ?? {};

	const perfScore = Math.round((lighthouse?.categories?.performance?.score ?? 0) * 100);
	checks.push({
		id: 'vitals-performance',
		label: 'Performance-score (mobiel)',
		status: perfScore >= 90 ? 'pass' : perfScore >= 50 ? 'warn' : 'fail',
		message: `Lighthouse performance-score: ${perfScore}/100.`
	});

	const lcpMs = audits['largest-contentful-paint']?.numericValue;
	if (typeof lcpMs === 'number') {
		checks.push({
			id: 'vitals-lcp',
			label: 'LCP',
			status: lcpMs <= 2500 ? 'pass' : lcpMs <= 4000 ? 'warn' : 'fail',
			message: `Largest Contentful Paint: ${(lcpMs / 1000).toFixed(1)}s (richtlijn: ≤ 2,5s).`
		});
	}

	const cls = audits['cumulative-layout-shift']?.numericValue;
	if (typeof cls === 'number') {
		checks.push({
			id: 'vitals-cls',
			label: 'CLS',
			status: cls <= 0.1 ? 'pass' : cls <= 0.25 ? 'warn' : 'fail',
			message: `Cumulative Layout Shift: ${cls.toFixed(3)} (richtlijn: ≤ 0,1).`
		});
	}

	const tbtMs = audits['total-blocking-time']?.numericValue;
	if (typeof tbtMs === 'number') {
		checks.push({
			id: 'vitals-tbt',
			label: 'TBT',
			status: tbtMs <= 200 ? 'pass' : tbtMs <= 600 ? 'warn' : 'fail',
			message: `Total Blocking Time: ${Math.round(tbtMs)}ms (richtlijn: ≤ 200ms).`
		});
	}

	// INP komt uit velddata (CrUX) en is er alleen voor sites met genoeg echt verkeer
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const inp = (data.loadingExperience as any)?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;
	if (typeof inp === 'number') {
		checks.push({
			id: 'vitals-inp',
			label: 'INP (velddata)',
			status: inp <= 200 ? 'pass' : inp <= 500 ? 'warn' : 'fail',
			message: `Interaction to Next Paint: ${inp}ms bij echte bezoekers (richtlijn: ≤ 200ms).`
		});
	} else {
		checks.push({
			id: 'vitals-inp',
			label: 'INP (velddata)',
			status: 'info',
			message: 'Geen velddata beschikbaar — normaal voor nieuwe sites of sites met weinig verkeer.'
		});
	}

	return checks;
}
