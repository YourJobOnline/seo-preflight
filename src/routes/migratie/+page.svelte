<script lang="ts">
	import {
		MIGRATIE_CHECKLIST,
		type ItemState,
		type MigratieState,
		type Verantwoordelijke
	} from '$lib/migratie';

	const STORAGE_PREFIX = 'seo-preflight:migratie:';

	let project = $state('');
	let projecten = $state<string[]>([]);
	let migratie = $state<MigratieState | null>(null);
	let collapsed = $state<Record<string, boolean>>({});

	$effect(() => {
		projecten = Object.keys(localStorage)
			.filter((k) => k.startsWith(STORAGE_PREFIX))
			.map((k) => k.slice(STORAGE_PREFIX.length))
			.sort();
	});

	function emptyItem(): ItemState {
		return { done: false, wie: '', opmerking: '' };
	}

	function openProject(name: string) {
		const trimmed = name.trim().toLowerCase();
		if (!trimmed) return;
		project = trimmed;

		// Alles vooraf initialiseren (state muteren tijdens renderen mag niet in Svelte 5)
		const base: MigratieState = { items: {}, categorieOpmerkingen: {} };
		for (const fase of MIGRATIE_CHECKLIST) {
			for (const cat of fase.categorieen) {
				base.categorieOpmerkingen[`${fase.id}:${cat.id}`] = '';
				for (const it of cat.items) base.items[it.id] = emptyItem();
			}
		}

		const raw = localStorage.getItem(STORAGE_PREFIX + trimmed);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as MigratieState;
				for (const [id, s] of Object.entries(parsed.items ?? {})) {
					if (base.items[id]) base.items[id] = { ...emptyItem(), ...s };
				}
				for (const [key, note] of Object.entries(parsed.categorieOpmerkingen ?? {})) {
					if (key in base.categorieOpmerkingen) base.categorieOpmerkingen[key] = note;
				}
			} catch {
				/* corrupte opslag — begin opnieuw */
			}
		}
		migratie = base;
	}

	// Automatisch opslaan bij elke wijziging
	$effect(() => {
		if (!migratie || !project) return;
		const snapshot = JSON.stringify(migratie);
		localStorage.setItem(STORAGE_PREFIX + project, snapshot);
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
