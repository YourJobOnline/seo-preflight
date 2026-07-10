<script lang="ts">
	import type { AuditEvent, Check, CheckStatus, PageResult, SiteResult } from '$lib/types';

	let targetUrl = $state('');
	let maxPages = $state(30);
	let useAuth = $state(false);
	let authUser = $state('');
	let authPass = $state('');

	let running = $state(false);
	let error = $state<string | null>(null);
	let currentUrl = $state<string | null>(null);
	let pages = $state<PageResult[]>([]);
	let site = $state<SiteResult | null>(null);
	let expanded = $state<Record<string, boolean>>({});
	let source: EventSource | null = null;

	function start(e: SubmitEvent) {
		e.preventDefault();
		if (!targetUrl.trim() || running) return;
		running = true;
		error = null;
		pages = [];
		site = null;
		expanded = {};

		const params = new URLSearchParams({ url: targetUrl.trim(), max: String(maxPages) });
		if (useAuth && authUser) {
			params.set('user', authUser);
			params.set('pass', authPass);
		}
		source = new EventSource(`/api/audit?${params}`);
		source.onmessage = (msg) => {
			const event: AuditEvent = JSON.parse(msg.data);
			if (event.type === 'progress') currentUrl = event.url;
			else if (event.type === 'page') pages = [...pages, event.page];
			else if (event.type === 'site') {
				site = event.site;
				stop();
			} else if (event.type === 'error') {
				error = event.message;
				stop();
			}
		};
		source.onerror = () => {
			if (!site) error ??= 'Verbinding verbroken tijdens de scan.';
			stop();
		};
	}

	function stop() {
		source?.close();
		source = null;
		running = false;
		currentUrl = null;
	}

	const sortedPages = $derived([...pages].sort((a, b) => a.score - b.score));
	const failCount = $derived(
		pages.reduce((n, p) => n + p.checks.filter((c) => c.status === 'fail').length, 0) +
			(site?.siteChecks.filter((c) => c.status === 'fail').length ?? 0)
	);
	const warnCount = $derived(
		pages.reduce((n, p) => n + p.checks.filter((c) => c.status === 'warn').length, 0) +
			(site?.siteChecks.filter((c) => c.status === 'warn').length ?? 0)
	);

	function scoreColor(score: number): string {
		if (score >= 90) return 'text-green-600';
		if (score >= 70) return 'text-amber-600';
		return 'text-red-600';
	}

	function pagePath(p: PageResult): string {
		try {
			const u = new URL(p.finalUrl);
			return u.pathname + u.search || '/';
		} catch {
			return p.finalUrl;
		}
	}

	const statusStyle: Record<CheckStatus, { badge: string; symbol: string }> = {
		pass: { badge: 'bg-green-100 text-green-700', symbol: '✓' },
		warn: { badge: 'bg-amber-100 text-amber-700', symbol: '!' },
		fail: { badge: 'bg-red-100 text-red-700', symbol: '✕' },
		info: { badge: 'bg-slate-100 text-slate-500', symbol: 'i' }
	};
</script>

{#snippet checkRow(check: Check)}
	<li class="flex gap-3 py-2">
		<span
			class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold {statusStyle[
				check.status
			].badge}">{statusStyle[check.status].symbol}</span
		>
		<div class="min-w-0">
			<p class="text-sm">
				<span class="font-medium">{check.label}</span>
				<span class="text-slate-600"> — {check.message}</span>
			</p>
			{#if check.details?.length}
				<ul class="mt-1 space-y-0.5">
					{#each check.details as detail}
						<li class="truncate font-mono text-xs text-slate-400">{detail}</li>
					{/each}
				</ul>
			{/if}
		</div>
	</li>
{/snippet}

<main class="mx-auto max-w-4xl px-4 py-10">
	<header class="mb-8">
		<div class="flex items-center gap-3">
			<div class="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900">
				<svg viewBox="0 0 32 32" class="h-6 w-6"
					><path
						d="M9 17.5 14 22l9-11"
						fill="none"
						stroke="#4ade80"
						stroke-width="3.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			</div>
			<div class="flex-1">
				<h1 class="text-xl font-bold tracking-tight">SEO Preflight</h1>
				<p class="text-sm text-slate-500">Check je site op SEO-basics vóór livegang</p>
			</div>
			<a
				href="/migratie"
				class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400"
			>
				📋 Migratie-checklist
			</a>
		</div>
	</header>

	<form onsubmit={start} class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
		<div class="flex flex-col gap-3 sm:flex-row">
			<input
				type="text"
				bind:value={targetUrl}
				placeholder="https://staging.jouwsite.nl"
				required
				class="w-full flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none"
			/>
			<select
				bind:value={maxPages}
				class="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none"
			>
				<option value={10}>max 10 pagina's</option>
				<option value={30}>max 30 pagina's</option>
				<option value={50}>max 50 pagina's</option>
				<option value={100}>max 100 pagina's</option>
			</select>
			<button
				type="submit"
				disabled={running}
				class="rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
			>
				{running ? 'Bezig…' : 'Scan starten'}
			</button>
		</div>
		<label class="mt-3 flex items-center gap-2 text-sm text-slate-600">
			<input type="checkbox" bind:checked={useAuth} class="rounded" />
			Staging achter basic auth
		</label>
		{#if useAuth}
			<div class="mt-2 flex gap-3">
				<input
					type="text"
					bind:value={authUser}
					placeholder="Gebruikersnaam"
					class="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm"
				/>
				<input
					type="password"
					bind:value={authPass}
					placeholder="Wachtwoord"
					class="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm"
				/>
			</div>
		{/if}
	</form>

	{#if error}
		<div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
			{error}
		</div>
	{/if}

	{#if running}
		<div class="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
			<div class="flex items-center gap-3">
				<div class="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900"></div>
				<p class="text-sm text-slate-600">
					{pages.length} pagina('s) gescand{#if currentUrl}
						— <span class="font-mono text-xs">{currentUrl}</span>{/if}
				</p>
			</div>
		</div>
	{/if}

	{#if site}
		<!-- Score + samenvatting -->
		<section class="mt-6 grid gap-4 sm:grid-cols-4">
			<div class="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm">
				<p class="text-4xl font-bold {scoreColor(site.score)}">{site.score}</p>
				<p class="mt-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Score</p>
			</div>
			<div class="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm">
				<p class="text-4xl font-bold text-slate-900">{site.pages.length}</p>
				<p class="mt-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Pagina's</p>
			</div>
			<div class="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm">
				<p class="text-4xl font-bold text-red-600">{failCount}</p>
				<p class="mt-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Fouten</p>
			</div>
			<div class="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm">
				<p class="text-4xl font-bold text-amber-600">{warnCount}</p>
				<p class="mt-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Waarschuwingen</p>
			</div>
		</section>
		{#if site.truncated}
			<p class="mt-2 text-xs text-slate-400">
				Niet alle pagina's zijn gescand — het maximum van {maxPages} is bereikt.
			</p>
		{/if}

		<!-- Go-live checklist -->
		<section class="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
			<h2 class="text-base font-semibold">🚀 Go-live checklist</h2>
			<ul class="mt-2 divide-y divide-slate-100">
				{#each site.goLive as check}
					{@render checkRow(check)}
				{/each}
			</ul>
		</section>

		<!-- GEO / AI-vindbaarheid -->
		<section class="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
			<h2 class="text-base font-semibold">🤖 Vindbaarheid in AI-tools (GEO)</h2>
			<ul class="mt-2 divide-y divide-slate-100">
				{#each site.geo as check}
					{@render checkRow(check)}
				{/each}
			</ul>
		</section>

		<!-- Site-brede checks -->
		<section class="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
			<h2 class="text-base font-semibold">Site-brede checks</h2>
			<ul class="mt-2 divide-y divide-slate-100">
				{#each site.siteChecks as check}
					{@render checkRow(check)}
				{/each}
			</ul>
		</section>

		<!-- Per pagina -->
		<section class="mt-6">
			<h2 class="mb-3 text-base font-semibold">Pagina's ({sortedPages.length})</h2>
			<div class="space-y-2">
				{#each sortedPages as page (page.url)}
					{@const issues = page.checks.filter((c) => c.status === 'fail' || c.status === 'warn')}
					<div class="rounded-xl border border-slate-200 bg-white shadow-sm">
						<button
							type="button"
							class="flex w-full items-center gap-3 px-4 py-3 text-left"
							onclick={() => (expanded[page.url] = !expanded[page.url])}
						>
							<span class="w-10 shrink-0 text-sm font-bold {scoreColor(page.score)}">{page.score}</span>
							<span class="min-w-0 flex-1 truncate font-mono text-sm text-slate-700">{pagePath(page)}</span>
							{#if issues.length > 0}
								<span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
									{issues.length}
									{issues.length === 1 ? 'issue' : 'issues'}
								</span>
							{/if}
							<span class="text-slate-400">{expanded[page.url] ? '▾' : '▸'}</span>
						</button>
						{#if expanded[page.url]}
							<div class="border-t border-slate-100 px-4 py-2">
								<ul class="divide-y divide-slate-100">
									{#each page.checks as check}
										{@render checkRow(check)}
									{/each}
								</ul>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}
</main>
