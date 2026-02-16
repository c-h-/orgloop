/**
 * Tests for module manifest types and parameter expansion engine.
 */

import type { ModuleExpansionContext, ModuleManifest } from '../module.js';
import { expandTemplate, expandTemplateDeep, moduleManifestSchema } from '../module.js';

// ─── expandTemplate ──────────────────────────────────────────────────────────

describe('expandTemplate', () => {
	const ctx: ModuleExpansionContext = {
		module: { name: 'code-review', path: '/path/to/module' },
		params: { github_source: 'github', agent_actor: 'engineering' },
	};

	it('expands {{ params.X }} placeholders', () => {
		expect(expandTemplate('{{ params.github_source }}', ctx)).toBe('github');
	});

	it('expands {{ module.name }}', () => {
		expect(expandTemplate('{{ module.name }}', ctx)).toBe('code-review');
	});

	it('expands {{ module.path }}', () => {
		expect(expandTemplate('{{ module.path }}', ctx)).toBe('/path/to/module');
	});

	it('expands multiple placeholders in one string', () => {
		const template = '{{ module.name }}-pr-review-{{ params.agent_actor }}';
		expect(expandTemplate(template, ctx)).toBe('code-review-pr-review-engineering');
	});

	it('handles whitespace variations in braces', () => {
		expect(expandTemplate('{{params.github_source}}', ctx)).toBe('github');
		expect(expandTemplate('{{  params.github_source  }}', ctx)).toBe('github');
	});

	it('passes through strings without placeholders', () => {
		expect(expandTemplate('no placeholders here', ctx)).toBe('no placeholders here');
	});

	it('throws on missing parameter', () => {
		expect(() => expandTemplate('{{ params.nonexistent }}', ctx)).toThrow(
			'Missing parameter: {{ params.nonexistent }}',
		);
	});

	it('throws on unknown namespace', () => {
		expect(() => expandTemplate('{{ env.HOME }}', ctx)).toThrow('Unknown namespace "env"');
	});

	it('throws on invalid expression format', () => {
		expect(() => expandTemplate('{{ justoneword }}', ctx)).toThrow('Invalid template expression');
	});

	it('converts non-string param values to string', () => {
		const numCtx: ModuleExpansionContext = {
			module: { name: 'test', path: '/test' },
			params: { count: 42, enabled: true },
		};
		expect(expandTemplate('{{ params.count }}', numCtx)).toBe('42');
		expect(expandTemplate('{{ params.enabled }}', numCtx)).toBe('true');
	});
});

// ─── expandTemplateDeep ──────────────────────────────────────────────────────

describe('expandTemplateDeep', () => {
	const ctx: ModuleExpansionContext = {
		module: { name: 'code-review', path: '/modules/code-review' },
		params: { source: 'github', actor: 'engineering' },
	};

	it('expands strings in nested objects', () => {
		const input = {
			name: '{{ module.name }}-route',
			when: { source: '{{ params.source }}' },
			then: { actor: '{{ params.actor }}' },
		};
		const result = expandTemplateDeep(input, ctx) as Record<string, unknown>;
		expect(result.name).toBe('code-review-route');
		expect((result.when as Record<string, unknown>).source).toBe('github');
		expect((result.then as Record<string, unknown>).actor).toBe('engineering');
	});

	it('expands strings in arrays', () => {
		const input = ['{{ params.source }}', '{{ params.actor }}'];
		const result = expandTemplateDeep(input, ctx);
		expect(result).toEqual(['github', 'engineering']);
	});

	it('passes through non-string primitives', () => {
		const input = { count: 5, enabled: true, name: '{{ module.name }}' };
		const result = expandTemplateDeep(input, ctx) as Record<string, unknown>;
		expect(result.count).toBe(5);
		expect(result.enabled).toBe(true);
		expect(result.name).toBe('code-review');
	});

	it('handles null values', () => {
		expect(expandTemplateDeep(null, ctx)).toBeNull();
	});

	it('handles deeply nested structures', () => {
		const input = {
			routes: [
				{
					name: '{{ module.name }}-pr',
					with: { prompt_file: '{{ module.path }}/sops/pr.md' },
				},
			],
		};
		const result = expandTemplateDeep(input, ctx) as Record<string, unknown>;
		const routes = result.routes as Array<Record<string, unknown>>;
		expect(routes[0].name).toBe('code-review-pr');
		expect((routes[0].with as Record<string, unknown>).prompt_file).toBe(
			'/modules/code-review/sops/pr.md',
		);
	});
});

// ─── moduleManifestSchema ────────────────────────────────────────────────────

describe('moduleManifestSchema', () => {
	it('has required fields', () => {
		expect(moduleManifestSchema.required).toEqual(['apiVersion', 'kind', 'metadata']);
	});

	it('requires Module kind', () => {
		expect(moduleManifestSchema.properties.kind).toEqual({ const: 'Module' });
	});

	it('requires metadata.name, description, version', () => {
		expect(moduleManifestSchema.properties.metadata.required).toEqual([
			'name',
			'description',
			'version',
		]);
	});

	it('validates name pattern (lowercase kebab)', () => {
		expect(moduleManifestSchema.properties.metadata.properties.name.pattern).toBe(
			'^[a-z0-9][a-z0-9-]*$',
		);
	});
});

// ─── ModuleManifest type ─────────────────────────────────────────────────────

describe('ModuleManifest type', () => {
	it('accepts a valid manifest object', () => {
		const manifest: ModuleManifest = {
			apiVersion: 'orgloop/v1alpha1',
			kind: 'Module',
			metadata: {
				name: 'code-review',
				description: 'Automated code review workflow',
				version: '1.0.0',
			},
			requires: {
				connectors: [
					{ type: 'source', id: 'github', connector: '@orgloop/connector-github', required: true },
					{
						type: 'actor',
						id: 'agent',
						connector: '@orgloop/connector-openclaw',
						required: false,
						fallback: 'queue',
					},
				],
			},
			parameters: [
				{
					name: 'github_source',
					description: 'GitHub source name',
					type: 'string',
					required: true,
				},
				{ name: 'agent_actor', description: 'Agent actor name', type: 'string', required: true },
			],
			provides: { routes: 2, transforms: 0, sops: 2 },
		};
		// Type-check only — if this compiles, the type works
		expect(manifest.kind).toBe('Module');
		expect(manifest.metadata.name).toBe('code-review');
		expect(manifest.requires?.connectors).toHaveLength(2);
		expect(manifest.parameters).toHaveLength(2);
	});
});
