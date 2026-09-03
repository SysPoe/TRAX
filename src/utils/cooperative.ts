/**
 * Cooperative event-loop yielding for long cache-construction loops.
 *
 * Refresh paths build large derived structures on the single Node thread
 * while HTTP requests share that thread. Instead of yielding every N items
 * (too often for cheap items, too rarely for expensive ones), loops hold a
 * {@link YieldBudget} and yield only once more than `budgetMs` of
 * uninterrupted synchronous work has elapsed.
 */
export const EVENT_LOOP_YIELD_BUDGET_MS = 8;

/** Yield once so pending I/O, timers, and HTTP handlers can run. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

export class YieldBudget {
	private lastYield = Date.now();

	constructor(private readonly budgetMs: number = EVENT_LOOP_YIELD_BUDGET_MS) {}

	/** Await a macrotask turn iff the budget since the last yield is spent. */
	async maybeYield(): Promise<void> {
		if (Date.now() - this.lastYield >= this.budgetMs) {
			await yieldToEventLoop();
			this.lastYield = Date.now();
		}
	}

	/** Mark a natural suspension point (an awaited call already yielded). */
	noteYield(): void {
		this.lastYield = Date.now();
	}
}
