/**
 * Logger fan-out manager.
 *
 * Fans out LogEntry to all configured loggers.
 * Non-blocking: errors in one logger don't affect others.
 */

import type { LogEntry } from '@orgloop/sdk';
import type { Logger } from '@orgloop/sdk';

interface TaggedLogger {
	logger: Logger;
	tag?: string;
}

export class LoggerManager {
	private readonly loggers: TaggedLogger[] = [];

	addLogger(logger: Logger, tag?: string): void {
		this.loggers.push({ logger, tag });
	}

	/**
	 * Remove all loggers with the given tag.
	 */
	removeLoggersByTag(tag: string): void {
		for (let i = this.loggers.length - 1; i >= 0; i--) {
			if (this.loggers[i].tag === tag) {
				this.loggers.splice(i, 1);
			}
		}
	}

	/**
	 * Fan out a log entry to all loggers.
	 * Non-blocking: fires all loggers concurrently, catches individual errors.
	 */
	async log(entry: LogEntry): Promise<void> {
		await Promise.allSettled(
			this.loggers.map(async ({ logger }) => {
				try {
					await logger.log(entry);
				} catch {
					// Swallow — one logger's failure must not affect others
				}
			}),
		);
	}

	/** Flush all loggers */
	async flush(): Promise<void> {
		await Promise.allSettled(
			this.loggers.map(async ({ logger }) => {
				try {
					await logger.flush();
				} catch {
					// Swallow
				}
			}),
		);
	}

	/** Shutdown all loggers */
	async shutdown(): Promise<void> {
		await Promise.allSettled(
			this.loggers.map(async ({ logger }) => {
				try {
					await logger.shutdown();
				} catch {
					// Swallow
				}
			}),
		);
	}
}
