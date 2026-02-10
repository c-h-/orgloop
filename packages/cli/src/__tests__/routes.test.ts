import type {
	ActorInstanceConfig,
	OrgLoopConfig,
	RouteDefinition,
	SourceInstanceConfig,
	TransformDefinition,
} from '@orgloop/sdk';
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { type RouteGraph, buildRouteGraph, renderRouteGraph } from '../commands/routes.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSource(id: string): SourceInstanceConfig {
	return { id, connector: '@orgloop/connector-github', config: {} };
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
	opts?: {
		filter?: Record<string, unknown>;
		transforms?: string[];
		description?: string;
	},
): RouteDefinition {
	const route: RouteDefinition = {
		name,
		description: opts?.description,
		when: { source, events, filter: opts?.filter },
		then: { actor },
	};
	if (opts?.transforms) {
		route.transforms = opts.transforms.map((ref) => ({ ref }));
	}
	return route;
}

function makeConfig(overrides: Partial<OrgLoopConfig> = {}): OrgLoopConfig {
	return {
		project: { name: 'test-project' },
		sources: [],
		actors: [],
		routes: [],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

// ─── buildRouteGraph ──────────────────────────────────────────────────────────

describe('buildRouteGraph', () => {
	it('builds edges from routes', () => {
		const config = makeConfig({
			sources: [makeSource('github')],
			actors: [makeActor('agent')],
			transforms: [makeTransform('filter')],
			routes: [
				makeRoute('r1', 'github', 'agent', ['resource.changed'], {
					filter: { 'provenance.platform_event': 'pull_request.review_submitted' },
					transforms: ['filter'],
				}),
			],
		});

		const graph = buildRouteGraph(config);

		expect(graph.project).toBe('test-project');
		expect(graph.sources).toEqual(['github']);
		expect(graph.actors).toEqual(['agent']);
		expect(graph.transforms).toEqual(['filter']);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]).toEqual({
			route: 'r1',
			description: undefined,
			source: 'github',
			actor: 'agent',
			events: ['resource.changed'],
			filter: { 'provenance.platform_event': 'pull_request.review_submitted' },
			transforms: ['filter'],
		});
		expect(graph.warnings).toHaveLength(0);
	});

	it('detects unrouted sources', () => {
		const config = makeConfig({
			sources: [makeSource('github'), makeSource('linear')],
			actors: [makeActor('agent')],
			routes: [makeRoute('r1', 'github', 'agent')],
		});

		const graph = buildRouteGraph(config);

		expect(graph.warnings).toHaveLength(1);
		expect(graph.warnings[0].kind).toBe('unrouted-source');
		expect(graph.warnings[0].id).toBe('linear');
	});

	it('detects unreachable actors', () => {
		const config = makeConfig({
			sources: [makeSource('github')],
			actors: [makeActor('agent-a'), makeActor('agent-b')],
			routes: [makeRoute('r1', 'github', 'agent-a')],
		});

		const graph = buildRouteGraph(config);

		expect(graph.warnings).toHaveLength(1);
		expect(graph.warnings[0].kind).toBe('unreachable-actor');
		expect(graph.warnings[0].id).toBe('agent-b');
	});

	it('detects orphan transforms', () => {
		const config = makeConfig({
			sources: [makeSource('github')],
			actors: [makeActor('agent')],
			transforms: [makeTransform('filter'), makeTransform('dedup')],
			routes: [
				makeRoute('r1', 'github', 'agent', ['resource.changed'], {
					transforms: ['filter'],
				}),
			],
		});

		const graph = buildRouteGraph(config);

		expect(graph.warnings).toHaveLength(1);
		expect(graph.warnings[0].kind).toBe('orphan-transform');
		expect(graph.warnings[0].id).toBe('dedup');
	});

	it('returns clean graph when all wired', () => {
		const config = makeConfig({
			sources: [makeSource('github')],
			actors: [makeActor('agent')],
			transforms: [makeTransform('filter')],
			routes: [
				makeRoute('r1', 'github', 'agent', ['resource.changed'], {
					transforms: ['filter'],
				}),
			],
		});

		const graph = buildRouteGraph(config);
		expect(graph.warnings).toHaveLength(0);
	});

	it('handles multiple routes from same source', () => {
		const config = makeConfig({
			sources: [makeSource('github')],
			actors: [makeActor('agent')],
			routes: [
				makeRoute('r1', 'github', 'agent', ['resource.changed'], {
					filter: { 'provenance.platform_event': 'pull_request.review_submitted' },
				}),
				makeRoute('r2', 'github', 'agent', ['resource.changed'], {
					filter: { 'provenance.platform_event': 'check_run.completed' },
				}),
			],
		});

		const graph = buildRouteGraph(config);
		expect(graph.edges).toHaveLength(2);
		expect(graph.warnings).toHaveLength(0);
	});

	it('handles empty config gracefully', () => {
		const config = makeConfig();
		const graph = buildRouteGraph(config);

		expect(graph.edges).toHaveLength(0);
		expect(graph.warnings).toHaveLength(0);
		expect(graph.sources).toEqual([]);
		expect(graph.actors).toEqual([]);
	});

	it('detects multiple warnings at once', () => {
		const config = makeConfig({
			sources: [makeSource('github'), makeSource('linear')],
			actors: [makeActor('agent-a'), makeActor('agent-b')],
			transforms: [makeTransform('unused-transform')],
			routes: [makeRoute('r1', 'github', 'agent-a')],
		});

		const graph = buildRouteGraph(config);
		const kinds = graph.warnings.map((w) => w.kind);

		expect(kinds).toContain('unrouted-source');
		expect(kinds).toContain('unreachable-actor');
		expect(kinds).toContain('orphan-transform');
		expect(graph.warnings).toHaveLength(3);
	});
});

// ─── renderRouteGraph ─────────────────────────────────────────────────────────

describe('renderRouteGraph', () => {
	it('renders a basic route', () => {
		const graph: RouteGraph = {
			project: 'my-org',
			sources: ['github'],
			actors: ['agent'],
			transforms: [],
			edges: [
				{
					route: 'github-to-agent',
					source: 'github',
					actor: 'agent',
					events: ['resource.changed'],
					transforms: [],
				},
			],
			warnings: [],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('my-org');
		expect(rendered).toContain('github');
		expect(rendered).toContain('github-to-agent');
		expect(rendered).toContain('agent');
		expect(rendered).toContain('0 warnings');
	});

	it('renders filter details', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github'],
			actors: ['agent'],
			transforms: [],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent',
					events: ['resource.changed'],
					filter: { 'provenance.platform_event': 'pull_request.review_submitted' },
					transforms: [],
				},
			],
			warnings: [],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('filter:');
		expect(rendered).toContain('resource.changed');
		expect(rendered).toContain('provenance.platform_event: pull_request.review_submitted');
	});

	it('renders transforms', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github'],
			actors: ['agent'],
			transforms: ['drop-bot-noise', 'dedup'],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent',
					events: ['resource.changed'],
					transforms: ['drop-bot-noise', 'dedup'],
				},
			],
			warnings: [],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('transform:');
		expect(rendered).toContain('drop-bot-noise');
		expect(rendered).toContain('dedup');
	});

	it('renders unrouted sources with warning', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github', 'linear'],
			actors: ['agent'],
			transforms: [],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent',
					events: ['resource.changed'],
					transforms: [],
				},
			],
			warnings: [
				{
					kind: 'unrouted-source',
					id: 'linear',
					message: 'Source "linear" has no routes',
				},
			],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('linear');
		expect(rendered).toContain('no routes');
		expect(rendered).toContain('unrouted source');
	});

	it('renders unreachable actors with warning', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github'],
			actors: ['agent-a', 'agent-b'],
			transforms: [],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent-a',
					events: ['resource.changed'],
					transforms: [],
				},
			],
			warnings: [
				{
					kind: 'unreachable-actor',
					id: 'agent-b',
					message: 'Actor "agent-b" is not targeted by any route',
				},
			],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('agent-b');
		expect(rendered).toContain('unreachable actor');
	});

	it('renders empty graph message', () => {
		const graph: RouteGraph = {
			project: 'empty-org',
			sources: [],
			actors: [],
			transforms: [],
			edges: [],
			warnings: [],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('empty-org');
		expect(rendered).toContain('No routes defined');
	});

	it('renders warning count in summary', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github', 'linear'],
			actors: ['agent'],
			transforms: [],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent',
					events: ['resource.changed'],
					transforms: [],
				},
			],
			warnings: [
				{
					kind: 'unrouted-source',
					id: 'linear',
					message: 'Source "linear" has no routes',
				},
			],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('1 route');
		expect(rendered).toContain('1 warning');
	});

	it('uses correct plural forms', () => {
		const graph: RouteGraph = {
			project: 'test',
			sources: ['github'],
			actors: ['agent-a', 'agent-b'],
			transforms: [],
			edges: [
				{
					route: 'r1',
					source: 'github',
					actor: 'agent-a',
					events: ['resource.changed'],
					transforms: [],
				},
				{
					route: 'r2',
					source: 'github',
					actor: 'agent-a',
					events: ['actor.stopped'],
					transforms: [],
				},
			],
			warnings: [
				{
					kind: 'unreachable-actor',
					id: 'agent-b',
					message: 'Actor "agent-b" is not targeted by any route',
				},
			],
		};

		const rendered = renderRouteGraph(graph);
		expect(rendered).toContain('2 routes');
		expect(rendered).toContain('1 warning');
	});
});

// ─── JSON output structure ────────────────────────────────────────────────────

describe('RouteGraph JSON structure', () => {
	it('produces a valid JSON-serializable graph', () => {
		const config = makeConfig({
			sources: [makeSource('github'), makeSource('linear')],
			actors: [makeActor('agent')],
			transforms: [makeTransform('filter')],
			routes: [
				makeRoute('r1', 'github', 'agent', ['resource.changed'], {
					filter: { 'provenance.platform_event': 'pull_request.review_submitted' },
					transforms: ['filter'],
				}),
			],
		});

		const graph = buildRouteGraph(config);

		// Should be JSON-serializable
		const json = JSON.parse(JSON.stringify(graph));

		expect(json).toHaveProperty('project', 'test-project');
		expect(json).toHaveProperty('sources');
		expect(json).toHaveProperty('actors');
		expect(json).toHaveProperty('transforms');
		expect(json).toHaveProperty('edges');
		expect(json).toHaveProperty('warnings');
		expect(json.edges).toHaveLength(1);
		expect(json.edges[0]).toHaveProperty('route', 'r1');
		expect(json.edges[0]).toHaveProperty('source', 'github');
		expect(json.edges[0]).toHaveProperty('actor', 'agent');
		expect(json.edges[0]).toHaveProperty('events');
		expect(json.edges[0]).toHaveProperty('filter');
		expect(json.edges[0]).toHaveProperty('transforms');
		expect(json.warnings).toHaveLength(1);
		expect(json.warnings[0]).toHaveProperty('kind', 'unrouted-source');
		expect(json.warnings[0]).toHaveProperty('id', 'linear');
	});
});
