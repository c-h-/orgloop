/**
 * Poll scheduling.
 *
 * Schedules poll operations for sources based on their configured intervals.
 * Graceful start/stop with interval cleanup.
 */

import { parseDuration } from '@orgloop/sdk';

export type PollCallback = (sourceId: string, moduleName?: string) => Promise<void>;

interface ScheduledSource {
	sourceId: string;
	intervalMs: number;
	moduleName?: string;
	timer: ReturnType<typeof setInterval> | null;
}

export class Scheduler {
	private readonly sources: ScheduledSource[] = [];
	private running = false;
	private pollCallback: PollCallback | null = null;

	/**
	 * Register a source to be polled at the given interval.
	 * If the scheduler is already running, starts polling immediately.
	 */
	addSource(sourceId: string, interval: string, moduleName?: string): void {
		const intervalMs = parseDuration(interval);
		const source: ScheduledSource = { sourceId, intervalMs, moduleName, timer: null };
		this.sources.push(source);

		// If scheduler is already running, start polling this source immediately
		if (this.running && this.pollCallback) {
			void this.safePoll(source.sourceId, source.moduleName);
			source.timer = setInterval(() => {
				void this.safePoll(source.sourceId, source.moduleName);
			}, source.intervalMs);
		}
	}

	/**
	 * Remove a single source by ID and clear its interval.
	 */
	removeSource(sourceId: string): void {
		const idx = this.sources.findIndex((s) => s.sourceId === sourceId);
		if (idx === -1) return;
		const source = this.sources[idx];
		if (source.timer) {
			clearInterval(source.timer);
			source.timer = null;
		}
		this.sources.splice(idx, 1);
	}

	/**
	 * Remove all sources belonging to a given module.
	 */
	removeSources(moduleName: string): void {
		for (let i = this.sources.length - 1; i >= 0; i--) {
			if (this.sources[i].moduleName === moduleName) {
				const source = this.sources[i];
				if (source.timer) {
					clearInterval(source.timer);
					source.timer = null;
				}
				this.sources.splice(i, 1);
			}
		}
	}

	/**
	 * Start polling all registered sources.
	 */
	start(callback: PollCallback): void {
		if (this.running) return;
		this.running = true;
		this.pollCallback = callback;

		for (const source of this.sources) {
			// Run first poll immediately
			void this.safePoll(source.sourceId, source.moduleName);
			// Then schedule recurring polls
			source.timer = setInterval(() => {
				void this.safePoll(source.sourceId, source.moduleName);
			}, source.intervalMs);
		}
	}

	private async safePoll(sourceId: string, moduleName?: string): Promise<void> {
		if (!this.pollCallback) return;
		try {
			await this.pollCallback(sourceId, moduleName);
		} catch {
			// Errors handled upstream; scheduler keeps going
		}
	}

	/**
	 * Stop all scheduled polls.
	 */
	stop(): void {
		this.running = false;
		for (const source of this.sources) {
			if (source.timer) {
				clearInterval(source.timer);
				source.timer = null;
			}
		}
	}

	get isRunning(): boolean {
		return this.running;
	}
}
