import type { TransitPlugin } from "./types.js";

export type PluginHookErrorHandler = (plugin: TransitPlugin, error: unknown) => void;

export interface PluginHookRunOptions {
	/**
	 * When true, a failing hook aborts the run after its group settles by
	 * rethrowing the first error in registration order (preserves today's
	 * static-generation publication gating). When false, every hook runs and
	 * failures only reach `onError` (today's realtime refresh behavior).
	 */
	abortOnError: boolean;
	onError?: PluginHookErrorHandler;
}

/**
 * Run one lifecycle hook across plugins, overlapping the fetch phases of
 * plugins that opted into the same audited `concurrencyGroup`. Ungrouped
 * plugins keep sequential registration order.
 *
 * Grouped hooks run via `Promise.allSettled`: every member settles, `onError`
 * fires per failure, and `abortOnError` rethrows the first failure in
 * registration order (not completion order) once the group settles.
 */
export async function runPluginHooks(
	plugins: readonly TransitPlugin[],
	invoke: (plugin: TransitPlugin) => unknown,
	options: PluginHookRunOptions,
): Promise<void> {
	let index = 0;
	while (index < plugins.length) {
		const plugin = plugins[index];
		const group = plugin.concurrencyGroup;
		if (!group) {
			try {
				await invoke(plugin);
			} catch (error) {
				options.onError?.(plugin, error);
				if (options.abortOnError) throw error;
			}
			index += 1;
			continue;
		}
		const segment: TransitPlugin[] = [];
		while (index < plugins.length && plugins[index].concurrencyGroup === group) {
			segment.push(plugins[index]);
			index += 1;
		}
		const settled = await Promise.allSettled(segment.map((member) => invoke(member)));
		let firstError: unknown;
		let hasError = false;
		settled.forEach((outcome, position) => {
			if (outcome.status === "rejected") {
				options.onError?.(segment[position], outcome.reason);
				if (!hasError) {
					hasError = true;
					firstError = outcome.reason;
				}
			}
		});
		if (hasError && options.abortOnError) throw firstError;
	}
}
