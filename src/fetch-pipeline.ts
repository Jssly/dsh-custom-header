/**
 * Shared fetch middleware pipeline.
 *
 * Vendored from @aizigao/pi-fetch-pipeline v1.0.1 (MIT)
 * https://github.com/aizigao/pi-fetch-pipeline, re-keyed for DSH so
 * multiple plugins can coexist in one process without clobbering each
 * other's middleware chains. The mechanics are unchanged: an object-property
 * `fetch` on globalThis whose setter keeps the underlying fetch in sync,
 * and a priority-ordered middleware chain composed on every (re)install.
 */
export type FetchPipelineNext = (
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
) => Promise<Response>;

export type FetchMiddleware = (args: {
	input: Parameters<typeof fetch>[0];
	init?: RequestInit;
	next: FetchPipelineNext;
}) => Promise<Response>;

export type FetchMiddlewareRegistration = {
	name: string;
	priority: number;
	middleware: FetchMiddleware;
};

export type FetchPipelineState = {
	getUnderlyingFetch: () => typeof fetch;
	setUnderlyingFetch: (nextFetch: typeof fetch) => void;
	middlewares: FetchMiddlewareRegistration[];
	installed: boolean;
	patchedFetch?: typeof fetch;
};

/**
 * DSH-scoped pipeline key. DSH plugins are separate packages, so the chain
 * uses a dedicated symbol — nothing else should splice into the
 * harness's global fetch unless it opts into this exact symbol.
 */
const FETCH_PIPELINE_KEY = Symbol.for("dsh-custom-header.fetch.pipeline.v1");

type GlobalWithFetchPipeline = typeof globalThis & {
	[FETCH_PIPELINE_KEY]?: FetchPipelineState;
};

function getGlobal(): GlobalWithFetchPipeline {
	return globalThis as GlobalWithFetchPipeline;
}

function compose(state: FetchPipelineState): typeof fetch {
	const ordered = [...state.middlewares].sort((a, b) => a.priority - b.priority);

	const callAt = (
		index: number,
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	): Promise<Response> => {
		if (index >= ordered.length) {
			return state.getUnderlyingFetch()(input, init);
		}

		const current = ordered[index];
		return current.middleware({
			input,
			init,
			next: (nextInput, nextInit) => callAt(index + 1, nextInput, nextInit),
		});
	};

	return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		callAt(0, input, init)) as typeof fetch;
}

export function ensureFetchPipeline(): FetchPipelineState {
	const g = getGlobal();
	if (g[FETCH_PIPELINE_KEY]) {
		return g[FETCH_PIPELINE_KEY]!;
	}

	let underlyingFetch: typeof fetch = globalThis.fetch;
	const state: FetchPipelineState = {
		getUnderlyingFetch: () => underlyingFetch,
		setUnderlyingFetch: (nextFetch) => {
			underlyingFetch = nextFetch;
		},
		middlewares: [],
		installed: false,
	};

	g[FETCH_PIPELINE_KEY] = state;
	return state;
}

export function installFetchPipeline(): void {
	const state = ensureFetchPipeline();
	if (state.installed) {
		state.patchedFetch = compose(state);
		return;
	}

	const prevDesc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	state.patchedFetch = compose(state);

	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: prevDesc?.enumerable ?? true,
		get() {
			return state.patchedFetch!;
		},
		set(newFetch: typeof fetch) {
			if (newFetch === state.patchedFetch) return;
			prevDesc?.set?.call(globalThis, newFetch);
			state.setUnderlyingFetch(newFetch);
			state.patchedFetch = compose(state);
		},
	});

	state.installed = true;
}

export function registerFetchMiddleware(registration: FetchMiddlewareRegistration): void {
	const state = ensureFetchPipeline();
	const existingIndex = state.middlewares.findIndex((m) => m.name === registration.name);
	if (existingIndex >= 0) {
		state.middlewares.splice(existingIndex, 1, registration);
	} else {
		state.middlewares.push(registration);
	}
	installFetchPipeline();
}