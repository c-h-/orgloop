/**
 * Prompt file utilities — front matter parsing for launch prompts.
 */

import yaml from 'js-yaml';

export interface StripFrontMatterResult {
	/** Prompt content with front matter removed */
	content: string;
	/** Parsed YAML front matter metadata, or null if none found */
	metadata: Record<string, unknown> | null;
}

const FRONT_MATTER_RE = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*\n?/;

/**
 * Strip YAML front matter from prompt file content.
 *
 * Front matter must start at line 1 with `---`, contain YAML,
 * and end with `---` on its own line. Everything after the closing
 * delimiter is returned as the prompt content.
 *
 * Files without front matter are returned as-is with null metadata.
 */
export function stripFrontMatter(raw: string): StripFrontMatterResult {
	const match = FRONT_MATTER_RE.exec(raw);
	if (!match) {
		return { content: raw, metadata: null };
	}

	const frontMatterYaml = (match[1] ?? '').replace(/\n$/, '');
	const content = raw.slice(match[0].length);

	let metadata: Record<string, unknown> | null = null;
	try {
		const parsed = yaml.load(frontMatterYaml);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			metadata = parsed as Record<string, unknown>;
		}
	} catch {
		// Invalid YAML in front matter — treat as no metadata
		metadata = null;
	}

	return { content, metadata };
}
