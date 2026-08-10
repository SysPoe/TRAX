import { TRAX } from "./index.js";
import type { NetworkDefinition, RuntimeOptions } from "./config.js";

export class NetworkRuntimeRegistry {
	readonly #runtimes = new Map<string, TRAX>();

	register(definition: NetworkDefinition, options: RuntimeOptions = {}): TRAX {
		if (this.#runtimes.has(definition.id)) throw new Error(`Network '${definition.id}' is already registered`);
		const runtime = new TRAX(definition, options);
		this.#runtimes.set(definition.id, runtime);
		return runtime;
	}

	get(networkId: string): TRAX {
		const runtime = this.#runtimes.get(networkId);
		if (!runtime) throw new Error(`Unknown network '${networkId}'`);
		return runtime;
	}

	list(): TRAX[] {
		return Array.from(this.#runtimes.values());
	}

	async loadAll(): Promise<void> {
		await Promise.all(this.list().map((runtime) => runtime.loadGTFS(true)));
	}

	clear(): void {
		for (const runtime of this.#runtimes.values()) runtime.clearIntervals();
		this.#runtimes.clear();
	}
}
