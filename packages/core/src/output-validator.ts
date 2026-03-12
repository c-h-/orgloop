/**
 * OutputValidator — pre-delivery validation of SOP outputs.
 *
 * Checks for potential payload propagation (viral agent loop defense):
 * - Instruction-like content in outputs (potential injection)
 * - Content similarity to input (echo/amplification)
 * - References to tools, URLs, or actions outside expected SOP scope
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import type { AuditFlag } from './audit.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OutputValidationResult {
	/** Whether the output passed validation */
	passed: boolean;
	/** Whether the output should be held for human review */
	hold_for_review: boolean;
	/** Flags raised during validation */
	flags: AuditFlag[];
}

export interface OutputValidatorOptions {
	/** Enable instruction content detection (default: true) */
	detectInstructions?: boolean;
	/** Enable input echo detection (default: true) */
	detectEcho?: boolean;
	/** Enable scope violation detection (default: true) */
	detectScopeViolations?: boolean;
	/** Similarity threshold for echo detection (0-1, default: 0.7) */
	echoThreshold?: number;
	/** Hold outputs with critical flags for human review (default: false) */
	holdOnCritical?: boolean;
	/** Custom instruction patterns to detect */
	instructionPatterns?: RegExp[];
	/** Allowed URL domains for scope checking */
	allowedDomains?: string[];
}

// ─── Instruction Detection Patterns ──────────────────────────────────────────

const DEFAULT_INSTRUCTION_PATTERNS: RegExp[] = [
	// System prompt injection markers
	/\bignore\s+(all\s+)?previous\s+instructions\b/i,
	/\byou\s+are\s+now\b/i,
	/\bsystem\s*:\s*/i,
	/\b(new|override|updated?)\s+instructions?\b/i,
	// Agent manipulation
	/\bexecute\s+(this|the\s+following)\s+(command|code|script)\b/i,
	/\brun\s+(this|the\s+following)\s+(command|code|script)\b/i,
	/\bmodify\s+your\s+(instructions?|behavior|prompt)\b/i,
	// Prompt injection delimiters
	/^-{3,}\s*$/m,
	/\[INST\]/i,
	/<<\s*SYS\s*>>/i,
	// Encoded instructions
	/\bbase64\s*[:=]\s*[A-Za-z0-9+/=]{20,}/i,
];

// ─── OutputValidator Class ───────────────────────────────────────────────────

export class OutputValidator {
	private readonly options: Required<
		Omit<OutputValidatorOptions, 'instructionPatterns' | 'allowedDomains'>
	> & {
		instructionPatterns: RegExp[];
		allowedDomains: string[];
	};

	constructor(options?: OutputValidatorOptions) {
		this.options = {
			detectInstructions: options?.detectInstructions ?? true,
			detectEcho: options?.detectEcho ?? true,
			detectScopeViolations: options?.detectScopeViolations ?? true,
			echoThreshold: options?.echoThreshold ?? 0.7,
			holdOnCritical: options?.holdOnCritical ?? false,
			instructionPatterns: [
				...DEFAULT_INSTRUCTION_PATTERNS,
				...(options?.instructionPatterns ?? []),
			],
			allowedDomains: options?.allowedDomains ?? [],
		};
	}

	/**
	 * Validate an output payload before it's committed to an external system.
	 */
	validate(
		outputContent: string,
		inputEvent: OrgLoopEvent,
		sopScope?: { allowedActions?: string[]; allowedDomains?: string[] },
	): OutputValidationResult {
		const flags: AuditFlag[] = [];

		if (this.options.detectInstructions) {
			flags.push(...this.checkInstructionContent(outputContent));
		}

		if (this.options.detectEcho) {
			flags.push(...this.checkInputEcho(outputContent, inputEvent));
		}

		if (this.options.detectScopeViolations) {
			flags.push(...this.checkScopeViolations(outputContent, sopScope));
		}

		const hasCritical = flags.some((f) => f.severity === 'critical');
		const holdForReview = hasCritical && this.options.holdOnCritical;

		return {
			passed: !hasCritical,
			hold_for_review: holdForReview,
			flags,
		};
	}

	/** Check for instruction-like content that could be prompt injection. */
	private checkInstructionContent(content: string): AuditFlag[] {
		const flags: AuditFlag[] = [];

		for (const pattern of this.options.instructionPatterns) {
			const match = pattern.exec(content);
			if (match) {
				flags.push({
					type: 'instruction_content',
					severity: 'critical',
					message: `Potential instruction injection detected: "${match[0]}"`,
				});
			}
		}

		return flags;
	}

	/** Check if the output is suspiciously similar to the input (echo/amplification). */
	private checkInputEcho(content: string, inputEvent: OrgLoopEvent): AuditFlag[] {
		const flags: AuditFlag[] = [];

		// Serialize input payload for comparison
		const inputText = JSON.stringify(inputEvent.payload);
		if (!inputText || inputText.length < 20) return flags;

		const similarity = this.computeSimilarity(content, inputText);

		if (similarity >= this.options.echoThreshold) {
			flags.push({
				type: 'input_echo',
				severity: similarity >= 0.9 ? 'critical' : 'warning',
				message: `Output is ${Math.round(similarity * 100)}% similar to input payload (threshold: ${Math.round(this.options.echoThreshold * 100)}%)`,
			});
		}

		return flags;
	}

	/** Check for references to tools, URLs, or actions outside SOP's expected scope. */
	private checkScopeViolations(
		content: string,
		sopScope?: { allowedActions?: string[]; allowedDomains?: string[] },
	): AuditFlag[] {
		const flags: AuditFlag[] = [];

		// Extract URLs from content
		const urlPattern = /https?:\/\/[^\s"'<>)}\]]+/gi;
		const urls = content.match(urlPattern) ?? [];

		const allowedDomains = [...this.options.allowedDomains, ...(sopScope?.allowedDomains ?? [])];

		if (allowedDomains.length > 0) {
			for (const url of urls) {
				try {
					const hostname = new URL(url).hostname;
					const isAllowed = allowedDomains.some(
						(d) => hostname === d || hostname.endsWith(`.${d}`),
					);
					if (!isAllowed) {
						flags.push({
							type: 'scope_violation',
							severity: 'warning',
							message: `URL references domain "${hostname}" not in allowed scope: ${allowedDomains.join(', ')}`,
						});
					}
				} catch {
					// Malformed URL — flag it
					flags.push({
						type: 'scope_violation',
						severity: 'warning',
						message: `Malformed URL detected in output: "${url.slice(0, 100)}"`,
					});
				}
			}
		}

		// Check for shell command patterns
		const shellPatterns = [
			/\b(curl|wget|ssh|scp|rsync)\s+/i,
			/\brm\s+-rf\b/i,
			/\bsudo\s+/i,
			/\bchmod\s+[0-7]{3,4}\b/i,
			/\|\s*(bash|sh|zsh)\b/i,
		];

		for (const pattern of shellPatterns) {
			const match = pattern.exec(content);
			if (match) {
				flags.push({
					type: 'scope_violation',
					severity: 'warning',
					message: `Shell command pattern detected in output: "${match[0]}"`,
				});
			}
		}

		return flags;
	}

	/**
	 * Compute bigram-based Jaccard similarity between two strings.
	 * Returns 0-1 where 1 is identical.
	 */
	private computeSimilarity(a: string, b: string): number {
		if (a.length === 0 && b.length === 0) return 1;
		if (a.length === 0 || b.length === 0) return 0;

		const bigramsA = this.toBigrams(a.toLowerCase());
		const bigramsB = this.toBigrams(b.toLowerCase());

		let intersection = 0;
		const bCopy = new Map(bigramsA);

		for (const [bigram, countA] of bCopy) {
			const countB = bigramsB.get(bigram) ?? 0;
			intersection += Math.min(countA, countB);
		}

		const totalA = [...bigramsA.values()].reduce((s, v) => s + v, 0);
		const totalB = [...bigramsB.values()].reduce((s, v) => s + v, 0);
		const union = totalA + totalB - intersection;

		return union === 0 ? 0 : intersection / union;
	}

	/** Extract character bigrams from a string. */
	private toBigrams(s: string): Map<string, number> {
		const bigrams = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bigram = s.slice(i, i + 2);
			bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
		}
		return bigrams;
	}
}
