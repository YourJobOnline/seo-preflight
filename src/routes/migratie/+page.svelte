<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		AUTO_NOTE_PREFIX,
		MANUAL_REASON_ICON,
		MANUAL_REASON_LABEL,
		MIGRATIE_CHECKLIST,
		STORAGE_PREFIX,
		emptyItem,
		getActionItems,
		listProjects,
		loadChecklist,
		saveChecklist,
		type ActionItem,
		type ItemState,
		type MigratieState,
		type Verantwoordelijke
	} from '$lib/migratie';

	let project = $state('');
	let projecten = $state<string[]>([]);
	let migratie = $state<MigratieState | null>(null);
	let collapsed = $state<Record<string, boolean>>({});

	onMount(() => {
		projecten = listProjects();
		// Direct openen als we vanaf de scanpagina komen (?project=domein.nl)
		const fromQuery = page.url.searchParams.get('project');
		if (fromQuery) openProject(fromQuery);
	});

	function openProject(name: string) {
		const trimmed = name.trim().toLowerCase();
		if (!trimmed) return;
		project = trimmed;
		migratie = loadChecklist(trimmed);
	}

	// Automatisch opslaan bij elke wijziging
	$effect(() => {
		if (!migratie || !project) return;
		JSON.stringify(migratie); // dependencies registreren op de hele state
		saveChecklist(project, migratie);
		if (!projecten.includes(project)) projecten = [...projecten, project].sort();
	});

	function item(id: string): ItemState {
		return migratie?.items[id] ?? emptyItem();
	}

	function verwijderProject() {
		if (!project) return;
		if (!confirm(`Checklist voor "${project}" verwijderen?`)) return;
		localStorage.removeItem(STORAGE_PREFIX + project);
		projecten = projecten.filter((p) => p !== project);
		project = '';
		migratie = null;
	}

	function categorieVoortgang(itemIds: string[]): { done: number; total: number } {
		const done = itemIds.filter((id) => migratie?.items[id]?.done).length;
		return { done, total: itemIds.length };
	}

	const faseVoortgang = $derived(
		MIGRATIE_CHECKLIST.map((fase) => {
			const ids = fase.categorieen.flatMap((c) => c.items.map((i) => i.id));
			return { id: fase.id, ...categorieVoortgang(ids) };
		})
	);

	const actionItems = $derived(migratie ? getActionItems(migratie) : []);
	const actionGroups = $derived.by(() => {
		const map = new Map<string, ActionItem[]>();
		for (const it of actionItems) {
			if (!map.has(it.faseTitel)) map.set(it.faseTitel, []);
			map.get(it.faseTitel)!.push(it);
		}
		return [...map.entries()];
	});
	const autoActionCount = $derived(actionItems.filter((a) => a.isAuto).length);
	let showActiepunten = $state(true);

	const wieOpties: { value: Verantwoordelijke; label: string }[] = [
		{ value: '', label: 'Wie?' },
		{ value: 'webbouwer', label: 'Webbouwer/Klant' },
		{ value: 'onlineklik', label: 'Online Klik' },
		{ value: 'beide', label: 'Beide' }
	];

	const wieBadge: Record<string, string> = {
		webbouwer: 'bg-blue-100 text-blue-700',
		onlineklik: 'bg-purple-100 text-purple-700',
		beide: 'bg-slate-200 text-slate-700'
	};

	let nieuwProject = $state('');
</script>

<svelte:head>
	<title>Migratie-checklist — SEO Preflight</title>
</svelte:head>

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
			<div>
				<h1 class="text-xl font-bold tracking-tight">SEO Migratie-checklist</h1>
				<p class="text-sm text-slate-500">Vink af per fase, met verantwoordelijke en opmerkingen — automatisch opgeslagen per project</p>
			</div>
		</div>
		<nav class="mt-4 flex gap-2 text-sm">
			<a href="/" class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-slate-600 hover:border-slate-400">← Site-audit</a>
		</nav>
	</header>

	<!-- Projectkeuze -->
	<section class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
			<form
				class="flex flex-1 gap-2"
				onsubmit={(e) => {
					e.preventDefault();
					openProject(nieuwProject);
					nieuwProject = '';
				}}
			>
				<input
					type="text"
					bind:value={nieuwProject}
					placeholder="Projectnaam of domein (bijv. klantnaam.nl)"
					class="w-full flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none"
				/>
				<button
					type="submit"
					class="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
				>
					Openen
				</button>
			</form>
			{#if projecten.length > 0}
				<select
					value={project}
					onchange={(e) => openProject(e.currentTarget.value)}
					class="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none"
				>
					<option value="" disabled>Bestaand project…</option>
					{#each projecten as p}
						<option value={p}>{p}</option>
					{/each}
				</select>
			{/if}
		</div>
	</section>

	{#if migratie && project}
		<!-- Voortgang per fase -->
		<section class="mt-6 grid gap-4 sm:grid-cols-2">
			{#each MIGRATIE_CHECKLIST as fase, i}
				{@const voortgang = faseVoortgang[i]}
				<div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
					<div class="flex items-baseline justify-between">
						<p class="text-sm font-semibold">{fase.titel}</p>
						<p class="text-sm text-slate-500">{voortgang.done}/{voortgang.total}</p>
					</div>
					<div class="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
						<div
							class="h-full rounded-full bg-green-500 transition-all"
							style="width: {voortgang.total ? (voortgang.done / voortgang.total) * 100 : 0}%"
						></div>
					</div>
				</div>
			{/each}
		</section>

		<!-- Actiepunten: wat staat er nog open, en waarom -->
		{#if actionItems.length > 0}
			<section class="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
				<button type="button" class="flex w-full items-center justify-between text-left" onclick={() => (showActiepunten = !showActiepunten)}>
					<h2 class="text-base font-semibold text-amber-900">📌 Actiepunten ({actionItems.length} openstaand)</h2>
					<span class="text-xs text-amber-700">
						{autoActionCount} uit scan · {actionItems.length - autoActionCount} handmatig
						<span class="ml-1 text-amber-400">{showActiepunten ? '▾' : '▸'}</span>
					</span>
				</button>
				{#if showActiepunten}
					<div class="mt-3 space-y-4">
						{#each actionGroups as [faseTitel, items]}
							<div>
								<p class="text-xs font-semibold tracking-wide text-amber-800 uppercase">{faseTitel}</p>
								<ul class="mt-1.5 space-y-1.5">
									{#each items as it}
										<li class="rounded-lg bg-white/70 px-3 py-2 text-sm">
											<div class="flex items-start justify-between gap-2">
												<span class="text-slate-800">{it.taak}</span>
												{#if it.isAuto}
													{#if it.opmerking.startsWith(AUTO_NOTE_PREFIX)}
														<span class="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs whitespace-nowrap text-red-700">🤖 scan-bevinding</span>
													{:else}
														<span class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs whitespace-nowrap text-blue-700">🤖 scanbaar</span>
													{/if}
												{:else if it.manualReason}
													<span
														class="shrink-0 cursor-help rounded-full bg-slate-100 px-2 py-0.5 text-xs whitespace-nowrap text-slate-600"
														title={MANUAL_REASON_LABEL[it.manualReason]}
													>
														{MANUAL_REASON_ICON[it.manualReason]} {MANUAL_REASON_LABEL[it.manualReason]}
													</span>
												{/if}
											</div>
											{#if it.opmerking}
												<p class="mt-1 text-xs text-slate-500">{it.opmerking}</p>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		{#each MIGRATIE_CHECKLIST as fase}
			<h2 class="mt-8 text-base font-semibold tracking-wide text-slate-900 uppercase">{fase.titel}</h2>
			{#each fase.categorieen as cat}
				{@const catKey = `${fase.id}:${cat.id}`}
				{@const voortgang = categorieVoortgang(cat.items.map((i) => i.id))}
				<section class="mt-3 rounded-2xl border border-slate-200 bg-white shadow-sm">
					<button
						type="button"
						class="flex w-full items-center gap-3 px-5 py-3.5 text-left"
						onclick={() => (collapsed[catKey] = !collapsed[catKey])}
					>
						<span class="flex-1 text-sm font-semibold">{cat.titel}</span>
						<span
							class="rounded-full px-2 py-0.5 text-xs {voortgang.done === voortgang.total
								? 'bg-green-100 text-green-700'
								: 'bg-slate-100 text-slate-500'}"
						>
							{voortgang.done}/{voortgang.total}
						</span>
						<span class="text-slate-400">{collapsed[catKey] ? '▸' : '▾'}</span>
					</button>
					{#if !collapsed[catKey]}
						<div class="border-t border-slate-100 px-5 pb-4">
							<ul class="divide-y divide-slate-100">
								{#each cat.items as taakItem}
									{@const s = item(taakItem.id)}
									<li class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-3">
										<label class="flex flex-1 items-start gap-3">
											<input
												type="checkbox"
												bind:checked={s.done}
												class="mt-0.5 h-4 w-4 rounded accent-green-600"
											/>
											<span class="text-sm {s.done ? 'text-slate-400 line-through' : 'text-slate-700'}">
												{taakItem.taak}
												{#if taakItem.auto}
													<span
														class="ml-1 cursor-help text-xs"
														title="Dit item wordt automatisch bijgewerkt als je een scan toepast op de checklist"
														>🤖</span
													>
												{:else if taakItem.manualReason}
													<span class="ml-1 cursor-help text-xs" title={MANUAL_REASON_LABEL[taakItem.manualReason]}
														>{MANUAL_REASON_ICON[taakItem.manualReason]}</span
													>
												{/if}
											</span>
										</label>
										<div class="flex shrink-0 gap-2 pl-7 sm:pl-0">
											<select
												bind:value={s.wie}
												class="rounded-md border border-slate-200 px-2 py-1 text-xs {s.wie
													? wieBadge[s.wie]
													: 'text-slate-400'}"
											>
												{#each wieOpties as opt}
													<option value={opt.value}>{opt.label}</option>
												{/each}
											</select>
											<input
												type="text"
												bind:value={s.opmerking}
												placeholder="Opmerking…"
												title={s.opmerking}
												class="w-40 rounded-md border border-slate-200 px-2 py-1 text-xs focus:border-slate-400 focus:outline-none sm:w-52"
											/>
										</div>
									</li>
								{/each}
							</ul>
							<textarea
								bind:value={migratie.categorieOpmerkingen[catKey]}
								placeholder="Opmerkingen bij {cat.titel.toLowerCase()}…"
								rows="2"
								class="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
							></textarea>
						</div>
					{/if}
				</section>
			{/each}
		{/each}

		<div class="mt-8 flex justify-end">
			<button
				type="button"
				onclick={verwijderProject}
				class="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-600 transition hover:bg-red-50"
			>
				Checklist van dit project verwijderen
			</button>
		</div>
	{:else}
		<p class="mt-10 text-center text-sm text-slate-400">
			Open een project om de checklist te starten — voortgang wordt lokaal in je browser opgeslagen.
		</p>
	{/if}
</main>
