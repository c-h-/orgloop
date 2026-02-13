import { describe, expect, it } from 'vitest';
import { stripFrontMatter } from '../prompt.js';

describe('stripFrontMatter', () => {
	it('strips YAML front matter and returns parsed metadata', () => {
		const input = `---
title: Review SOP
priority: high
---
You are a code reviewer.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('You are a code reviewer.');
		expect(result.metadata).toEqual({ title: 'Review SOP', priority: 'high' });
	});

	it('returns content unchanged when no front matter present', () => {
		const input = 'Just a plain prompt file.\nNo front matter here.';

		const result = stripFrontMatter(input);
		expect(result.content).toBe(input);
		expect(result.metadata).toBeNull();
	});

	it('handles various YAML types (strings, numbers, booleans, arrays)', () => {
		const input = `---
name: test
version: 3
enabled: true
tags:
  - review
  - sop
---
Content here.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content here.');
		expect(result.metadata).toEqual({
			name: 'test',
			version: 3,
			enabled: true,
			tags: ['review', 'sop'],
		});
	});

	it('handles empty front matter block', () => {
		const input = `---
---
Content after empty front matter.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content after empty front matter.');
		// js-yaml.load('') returns undefined, so metadata should be null
		expect(result.metadata).toBeNull();
	});

	it('does not strip --- that appears mid-document (horizontal rules)', () => {
		const input = `Some text above.

---

Some text below.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe(input);
		expect(result.metadata).toBeNull();
	});

	it('requires front matter to start at line 1', () => {
		const input = `
---
title: Not front matter
---
Content.`;

		const result = stripFrontMatter(input);
		// Leading newline means --- is not at position 0
		expect(result.content).toBe(input);
		expect(result.metadata).toBeNull();
	});

	it('returns empty string content and null metadata for empty file', () => {
		const result = stripFrontMatter('');
		expect(result.content).toBe('');
		expect(result.metadata).toBeNull();
	});

	it('handles file with only front matter and no content after', () => {
		const input = `---
title: Metadata only
---
`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('');
		expect(result.metadata).toEqual({ title: 'Metadata only' });
	});

	it('handles front matter with no trailing newline after closing delimiter', () => {
		const input = `---
title: No trailing newline
---
Content starts here.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content starts here.');
		expect(result.metadata).toEqual({ title: 'No trailing newline' });
	});

	it('handles trailing whitespace on delimiter lines', () => {
		const input = `---
title: Whitespace delimiters
---
Content.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content.');
		expect(result.metadata).toEqual({ title: 'Whitespace delimiters' });
	});

	it('returns null metadata for invalid YAML in front matter', () => {
		const input = `---
: invalid: yaml: [
---
Content after bad YAML.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content after bad YAML.');
		expect(result.metadata).toBeNull();
	});

	it('returns null metadata when YAML parses to a non-object (scalar)', () => {
		const input = `---
just a string
---
Content.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content.');
		expect(result.metadata).toBeNull();
	});

	it('returns null metadata when YAML parses to an array', () => {
		const input = `---
- item1
- item2
---
Content.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Content.');
		expect(result.metadata).toBeNull();
	});

	it('preserves multi-line content after front matter', () => {
		const input = `---
role: reviewer
---
Line 1.

Line 3 after blank.

## Section

More content.`;

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Line 1.\n\nLine 3 after blank.\n\n## Section\n\nMore content.');
		expect(result.metadata).toEqual({ role: 'reviewer' });
	});

	it('handles multi-line YAML values', () => {
		const input = [
			'---',
			'description: |',
			'  This is a multi-line',
			'  description value.',
			'title: Test',
			'---',
			'Body content',
		].join('\n');

		const result = stripFrontMatter(input);
		expect(result.content).toBe('Body content');
		expect(result.metadata).not.toBeNull();
		expect(result.metadata?.title).toBe('Test');
		expect((result.metadata?.description as string).trim()).toBe(
			'This is a multi-line\ndescription value.',
		);
	});

	it('does not treat --- as front matter when text appears before it', () => {
		const input = 'Some text\n---\ntitle: x\n---\ncontent';

		const result = stripFrontMatter(input);
		expect(result.content).toBe(input);
		expect(result.metadata).toBeNull();
	});
});
