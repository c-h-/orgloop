import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession, ExecFn } from '../source.js';
import { AgentCtlSource } from '../source.js';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: 'sess_001',
		adapter: 'claude-code',
		status: 'running',
		startedAt: '2025-01-15T10:00:00Z',
		meta: {},
		...overrides,
	};
}

function mockExec(sessions: AgentSession[]): ExecFn {
	return async () => ({ stdout: JSON.stringify(sessions), stderr: '' });
}

function failExec(): ExecFn {
	return async () => {
		throw new Error('agent-ctl not found');
	};
}

describe('AgentCtlSource', () => {
	let source: AgentCtlSource;

	beforeEach(() => {
		source = new AgentCtlSource();
	});

	it('initializes with default config', async () => {
		await source.init({ id: 'test-src', connector: 'agent-ctl', config: {} });
		expect(source.id).toBe('agent-ctl');
	});

	it('initializes with custom binary path', async () => {
		await source.init({
			id: 'test-src',
			connector: 'agent-ctl',
			config: { binary_path: '/usr/local/bin/agent-ctl' },
		});
		expect(source.id).toBe('agent-ctl');
	});

	it('emits session.started for new running sessions', async () => {
		const sessions = [makeSession({ id: 'sess_001', status: 'running' })];
		source.setExecFn(mockExec(sessions));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });

		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('resource.changed');
		expect(result.events[0].source).toBe('my-agents');
		expect(result.events[0].provenance.platform).toBe('agent-ctl');
		expect(result.events[0].provenance.platform_event).toBe('session.started');
		expect(result.events[0].payload.session_id).toBe('sess_001');
		expect(result.events[0].payload.adapter).toBe('claude-code');
		expect(result.events[0].payload.status).toBe('running');
	});

	it('emits session.stopped when a running session stops', async () => {
		// First poll: running session
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		// Second poll: session now stopped
		source.setExecFn(
			mockExec([
				makeSession({
					id: 'sess_001',
					status: 'stopped',
					stoppedAt: '2025-01-15T10:30:00Z',
				}),
			]),
		);
		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].provenance.platform_event).toBe('session.stopped');
		expect(result.events[0].payload.stopped_at).toBe('2025-01-15T10:30:00Z');
	});

	it('emits session.stopped when a session disappears', async () => {
		// First poll: running session
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		// Second poll: session gone
		source.setExecFn(mockExec([]));
		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].provenance.platform_event).toBe('session.stopped');
	});

	it('emits session.idle when a running session goes idle', async () => {
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'idle' })]));
		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].provenance.platform_event).toBe('session.idle');
	});

	it('emits session.error when a session enters error state', async () => {
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'error' })]));
		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].provenance.platform_event).toBe('session.error');
	});

	it('emits no events when state is unchanged', async () => {
		const sessions = [makeSession({ id: 'sess_001', status: 'running' })];
		source.setExecFn(mockExec(sessions));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		// Same state again
		const result = await source.poll(null);

		expect(result.events).toHaveLength(0);
	});

	it('handles multiple sessions', async () => {
		const sessions = [
			makeSession({ id: 'sess_001', adapter: 'claude-code', status: 'running' }),
			makeSession({ id: 'sess_002', adapter: 'cursor', status: 'idle' }),
		];
		source.setExecFn(mockExec(sessions));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });

		const result = await source.poll(null);

		expect(result.events).toHaveLength(2);
		expect(result.events[0].payload.session_id).toBe('sess_001');
		expect(result.events[0].provenance.platform_event).toBe('session.started');
		expect(result.events[1].payload.session_id).toBe('sess_002');
		expect(result.events[1].provenance.platform_event).toBe('session.started');
	});

	it('returns empty events when agent-ctl fails', async () => {
		source.setExecFn(failExec());
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });

		const result = await source.poll(null);

		expect(result.events).toHaveLength(0);
		expect(result.checkpoint).toBeTruthy();
	});

	it('includes full session data in payload', async () => {
		const session = makeSession({
			id: 'sess_001',
			adapter: 'claude-code',
			status: 'running',
			cwd: '/home/user/project',
			spec: 'review-pr',
			model: 'claude-sonnet-4-5-20250929',
			tokens: { in: 1000, out: 500 },
			cost: 0.05,
			pid: 12345,
			meta: { branch: 'main' },
		});
		source.setExecFn(mockExec([session]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });

		const result = await source.poll(null);

		const payload = result.events[0].payload;
		expect(payload.cwd).toBe('/home/user/project');
		expect(payload.spec).toBe('review-pr');
		expect(payload.model).toBe('claude-sonnet-4-5-20250929');
		expect(payload.tokens).toEqual({ in: 1000, out: 500 });
		expect(payload.cost).toBe(0.05);
		expect(payload.pid).toBe(12345);
		expect(payload.meta).toEqual({ branch: 'main' });
	});

	it('does not emit stopped for already-stopped sessions that disappear', async () => {
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'stopped' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);

		// Session disappears, but was already stopped
		source.setExecFn(mockExec([]));
		const result = await source.poll(null);

		expect(result.events).toHaveLength(0);
	});

	it('returns a checkpoint timestamp', async () => {
		source.setExecFn(mockExec([]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });

		const result = await source.poll(null);

		expect(result.checkpoint).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('clears state on shutdown', async () => {
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		await source.poll(null);
		await source.shutdown();

		// After shutdown and re-init, same session should appear as new
		source.setExecFn(mockExec([makeSession({ id: 'sess_001', status: 'running' })]));
		await source.init({ id: 'my-agents', connector: 'agent-ctl', config: {} });
		const result = await source.poll(null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].provenance.platform_event).toBe('session.started');
	});
});
