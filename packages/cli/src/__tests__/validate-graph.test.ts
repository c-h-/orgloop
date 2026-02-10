import type {
	ActorInstanceConfig,
	RouteDefinition,
	SourceInstanceConfig,
	TransformDefinition,
} from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { type GraphWarning, validateRouteGraph } from '../commands/validate.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSource(id: string, emits?: string[]): SourceInstanceConfig {
	return {
		id,
		connector: '@orgloop/connector-github',
		config: {},
		...(emits ? { emits } : {}),
	};
}

function makeActor(id: string): ActorInstanceConfig {
	return { id, connector: '@orgloop/connector-openclaw', config: {} };
}

function makeTransform(name: string): TransformDefinition {
	return { name, type: 'package', package: '@orgloop/transform-filter', config: {} };
}

function makeRoute(
	name: string,
	source: string,
	actor: string,
	events: string[] = ['resource.changed'],
	transforms?: string[],
): RouteDefinition {
	const route: RouteDefinition = {
		name,
		when: { source, events },
		then: { actor },
	};
	if (transforms) {
		route.transforms = transforms.map((ref) => ({ ref }));
	}
	return route;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateRouteGraph', () => {
	it('returns no warnings for a clean graph', () => {
		const sources = new Map([['github', makeSource('github', ['resource.changed'])]]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map([['filter', makeTransform('filter')]]);
		const routes = [makeRoute('r1', 'github', 'agent', ['resource.changed'], ['filter'])];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(0);
	});

	it('detects dead sources', () => {
		const sources = new Map([
			['github', makeSource('github')],
			['linear', makeSource('linear')],
		]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map<string, TransformDefinition>();
		const routes = [makeRoute('r1', 'github', 'agent')];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe('dead-source');
		expect(warnings[0].id).toBe('linear');
	});

	it('detects unreachable actors', () => {
		const sources = new Map([['github', makeSource('github')]]);
		const actors = new Map([
			['agent-a', makeActor('agent-a')],
			['agent-b', makeActor('agent-b')],
		]);
		const transforms = new Map<string, TransformDefinition>();
		const routes = [makeRoute('r1', 'github', 'agent-a')];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe('unreachable-actor');
		expect(warnings[0].id).toBe('agent-b');
	});

	it('detects orphan transforms', () => {
		const sources = new Map([['github', makeSource('github')]]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map([
			['filter', makeTransform('filter')],
			['dedup', makeTransform('dedup')],
		]);
		const routes = [makeRoute('r1', 'github', 'agent', ['resource.changed'], ['filter'])];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe('orphan-transform');
		expect(warnings[0].id).toBe('dedup');
	});

	it('detects event type mismatch when source declares emits', () => {
		const sources = new Map([['github', makeSource('github', ['resource.changed'])]]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map<string, TransformDefinition>();
		const routes = [makeRoute('r1', 'github', 'agent', ['resource.changed', 'actor.stopped'])];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe('event-type-mismatch');
		expect(warnings[0].id).toBe('r1');
		expect(warnings[0].message).toContain('actor.stopped');
		expect(warnings[0].message).toContain('resource.changed');
	});

	it('skips event type check when source has no emits', () => {
		const sources = new Map([['github', makeSource('github')]]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map<string, TransformDefinition>();
		const routes = [makeRoute('r1', 'github', 'agent', ['actor.stopped'])];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		expect(warnings).toHaveLength(0);
	});

	it('detects multiple warnings at once', () => {
		const sources = new Map([
			['github', makeSource('github', ['resource.changed'])],
			['linear', makeSource('linear')],
		]);
		const actors = new Map([
			['agent-a', makeActor('agent-a')],
			['agent-b', makeActor('agent-b')],
		]);
		const transforms = new Map([['dedup', makeTransform('dedup')]]);
		const routes = [makeRoute('r1', 'github', 'agent-a', ['message.received'])];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);

		const kinds = warnings.map((w) => w.kind);
		expect(kinds).toContain('dead-source');
		expect(kinds).toContain('unreachable-actor');
		expect(kinds).toContain('orphan-transform');
		expect(kinds).toContain('event-type-mismatch');
		expect(warnings).toHaveLength(4);
	});

	it('handles empty routes gracefully', () => {
		const sources = new Map([['github', makeSource('github')]]);
		const actors = new Map([['agent', makeActor('agent')]]);
		const transforms = new Map([['filter', makeTransform('filter')]]);
		const routes: RouteDefinition[] = [];

		const warnings = validateRouteGraph(sources, actors, transforms, routes);
		// All are "dead" / "unreachable" / "orphan" since no routes reference them
		expect(warnings).toHaveLength(3);
		expect(warnings.map((w) => w.kind)).toEqual([
			'dead-source',
			'unreachable-actor',
			'orphan-transform',
		]);
	});
});
