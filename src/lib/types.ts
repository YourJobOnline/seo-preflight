export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface Check {
	id: string;
	label: string;
	status: CheckStatus;
	message: string;
	details?: string[];
}

export interface PageResult {
	url: string;
	finalUrl: string;
	httpStatus: number;
	title: string | null;
	description: string | null;
	checks: Check[];
	score: number;
	linkedFrom: string[];
}

export interface SiteResult {
	startUrl: string;
	pages: PageResult[];
	siteChecks: Check[];
	score: number;
	goLive: Check[];
	geo: Check[];
	vitals: Check[];
	truncated: boolean;
}

export interface AiPriority {
	prioriteit: 'kritiek' | 'hoog' | 'middel' | 'laag';
	titel: string;
	uitleg: string;
	oplossing: string;
	paginas: string[];
}

export interface AiPriorityList {
	samenvatting: string;
	items: AiPriority[];
}

export type AuditEvent =
	| { type: 'progress'; crawled: number; queued: number; url: string }
	| { type: 'page'; page: PageResult }
	| { type: 'site'; site: SiteResult }
	| { type: 'error'; message: string };

export function scoreChecks(checks: Check[]): number {
	const scored = checks.filter((c) => c.status !== 'info');
	if (scored.length === 0) return 100;
	const points = scored.reduce(
		(sum, c) => sum + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0),
		0
	);
	return Math.round((points / scored.length) * 100);
}
