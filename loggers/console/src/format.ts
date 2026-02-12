/**
 * Formatting and color logic for the console logger.
 *
 * Uses ANSI escape codes directly — no external dependencies.
 */

import type { LogEntry, LogPhase } from '@orgloop/sdk';

// ANSI color codes
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';

interface PhaseStyle {
	icon: string;
	color: string;
}

const PHASE_STYLES: Record<LogPhase, PhaseStyle> = {
	'source.emit': { icon: '\u25cf', color: BLUE }, // ●
	'transform.start': { icon: '\u25c6', color: CYAN }, // ◆
	'transform.pass': { icon: '\u25c6', color: GREEN }, // ◆
	'transform.drop': { icon: '\u2717', color: RED }, // ✗
	'transform.error': { icon: '\u26a0', color: YELLOW }, // ⚠
	'transform.error_drop': { icon: '\u2717', color: YELLOW }, // ✗
	'transform.error_halt': { icon: '\u26d4', color: RED }, // ⛔
	'route.match': { icon: '\u25ba', color: CYAN }, // ►
	'route.no_match': { icon: '\u25ba', color: DIM }, // ►
	'deliver.attempt': { icon: '\u25b7', color: CYAN }, // ▷
	'deliver.success': { icon: '\u2713', color: GREEN }, // ✓
	'deliver.failure': { icon: '\u2717', color: RED }, // ✗
	'deliver.retry': { icon: '\u21bb', color: YELLOW }, // ↻
	'system.start': { icon: '\u25cf', color: MAGENTA }, // ●
	'system.stop': { icon: '\u25cf', color: MAGENTA }, // ●
	'system.error': { icon: '\u26a0', color: MAGENTA }, // ⚠
	'source.circuit_open': { icon: '\u26a0', color: YELLOW }, // ⚠
	'source.circuit_retry': { icon: '\u21bb', color: CYAN }, // ↻
	'source.circuit_close': { icon: '\u2713', color: GREEN }, // ✓
	'module.loading': { icon: '\u25cf', color: CYAN }, // ●
	'module.active': { icon: '\u2713', color: GREEN }, // ✓
	'module.unloading': { icon: '\u25cf', color: YELLOW }, // ●
	'module.removed': { icon: '\u25cf', color: DIM }, // ●
	'module.error': { icon: '\u26a0', color: RED }, // ⚠
	'runtime.start': { icon: '\u25cf', color: MAGENTA }, // ●
	'runtime.stop': { icon: '\u25cf', color: MAGENTA }, // ●
};

/**
 * Format a log entry as a compact one-line string.
 */
export function formatCompact(entry: LogEntry, useColor: boolean): string {
	const style = PHASE_STYLES[entry.phase] ?? { icon: '?', color: '' };
	const time = formatTime(entry.timestamp);
	const phase = entry.phase;
	const icon = style.icon;

	const parts: string[] = [];

	if (useColor) {
		parts.push(`${DIM}${time}${RESET}`);
		parts.push(`${style.color}${icon}${RESET}`);
		parts.push(`${style.color}${phase}${RESET}`);
	} else {
		parts.push(time);
		parts.push(icon);
		parts.push(phase);
	}

	if (entry.source) parts.push(`src=${entry.source}`);
	if (entry.target) parts.push(`tgt=${entry.target}`);
	if (entry.route) parts.push(`route=${entry.route}`);
	if (entry.transform) parts.push(`xform=${entry.transform}`);
	if (entry.event_type) parts.push(`type=${entry.event_type}`);
	if (entry.result) parts.push(`result=${entry.result}`);
	if (entry.duration_ms !== undefined) parts.push(`${entry.duration_ms}ms`);
	if (entry.error) {
		if (useColor) {
			parts.push(`${RED}err=${entry.error}${RESET}`);
		} else {
			parts.push(`err=${entry.error}`);
		}
	}

	return parts.join(' ');
}

/**
 * Format a log entry in verbose multi-line format.
 */
export function formatVerbose(entry: LogEntry, useColor: boolean, showPayload: boolean): string {
	const lines: string[] = [formatCompact(entry, useColor)];

	if (entry.metadata && showPayload) {
		const meta = JSON.stringify(entry.metadata, null, 2);
		if (useColor) {
			lines.push(`  ${DIM}metadata: ${meta}${RESET}`);
		} else {
			lines.push(`  metadata: ${meta}`);
		}
	}

	return lines.join('\n');
}

/**
 * Extract HH:MM:SS.mmm from an ISO timestamp.
 */
function formatTime(timestamp: string): string {
	try {
		const d = new Date(timestamp);
		const h = String(d.getHours()).padStart(2, '0');
		const m = String(d.getMinutes()).padStart(2, '0');
		const s = String(d.getSeconds()).padStart(2, '0');
		const ms = String(d.getMilliseconds()).padStart(3, '0');
		return `${h}:${m}:${s}.${ms}`;
	} catch {
		return timestamp;
	}
}

/**
 * Map log phases to severity levels for filtering.
 */
const PHASE_LEVELS: Record<LogPhase, number> = {
	'source.emit': 1, // debug
	'transform.start': 0, // debug
	'transform.pass': 1, // info
	'transform.drop': 1, // info
	'transform.error': 2, // warn
	'transform.error_drop': 2, // warn
	'transform.error_halt': 3, // error
	'route.match': 1, // info
	'route.no_match': 0, // debug
	'deliver.attempt': 0, // debug
	'deliver.success': 1, // info
	'deliver.failure': 3, // error
	'deliver.retry': 2, // warn
	'system.start': 1, // info
	'system.stop': 1, // info
	'system.error': 3, // error
	'source.circuit_open': 2, // warn
	'source.circuit_retry': 1, // info
	'source.circuit_close': 1, // info
	'module.loading': 1, // info
	'module.active': 1, // info
	'module.unloading': 1, // info
	'module.removed': 1, // info
	'module.error': 3, // error
	'runtime.start': 1, // info
	'runtime.stop': 1, // info
};

const LEVEL_VALUES: Record<string, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Check if a log entry should be shown at the given level.
 */
export function shouldLog(phase: LogPhase, level: string): boolean {
	const phaseLevel = PHASE_LEVELS[phase] ?? 1;
	const configLevel = LEVEL_VALUES[level] ?? 1;
	return phaseLevel >= configLevel;
}
