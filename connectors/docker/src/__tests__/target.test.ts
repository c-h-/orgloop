import type { RouteDeliveryConfig } from '@orgloop/sdk';
import { createTestEvent } from '@orgloop/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFn } from '../target.js';
import { DockerTarget } from '../target.js';

function successExec(): ExecFn {
	return vi.fn(async () => ({ stdout: '', stderr: '' }));
}

function failExec(message: string): ExecFn {
	return vi.fn(async () => {
		throw new Error(message);
	});
}

function makeRouteConfig(overrides: Partial<RouteDeliveryConfig> = {}): RouteDeliveryConfig {
	return { ...overrides } as RouteDeliveryConfig;
}

describe('DockerTarget', () => {
	let target: DockerTarget;
	let execFn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		target = new DockerTarget();
		execFn = vi.fn(async () => ({ stdout: '', stderr: '' }));
		target.setExecFn(execFn);
	});

	it('initializes with config', async () => {
		await target.init({
			id: 'docker-ctl',
			connector: 'docker',
			config: { cluster_name: 'dev', container_name: 'app', timeout: 30000 },
		});
		expect(target.id).toBe('docker');
	});

	// ─── cluster.shutdown ─────────────────────────────────────────────────────

	describe('cluster.shutdown', () => {
		it('runs kind delete cluster with default name', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig({ action: 'cluster.shutdown' }));

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith('kind', ['delete', 'cluster', '--name', 'kind'], {
				timeout: 60_000,
			});
		});

		it('uses cluster_name from route config', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(
				event,
				makeRouteConfig({ action: 'cluster.shutdown', cluster_name: 'staging' }),
			);

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['delete', 'cluster', '--name', 'staging'],
				expect.any(Object),
			);
		});

		it('uses cluster_name from connector config', async () => {
			await target.init({
				id: 'docker-ctl',
				connector: 'docker',
				config: { cluster_name: 'prod' },
			});
			const event = createTestEvent();
			await target.deliver(event, makeRouteConfig({ action: 'cluster.shutdown' }));

			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['delete', 'cluster', '--name', 'prod'],
				expect.any(Object),
			);
		});

		it('returns error when kind fails', async () => {
			target.setExecFn(failExec('kind: command not found'));
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();

			const result = await target.deliver(event, makeRouteConfig({ action: 'cluster.shutdown' }));

			expect(result.status).toBe('error');
			expect(result.error?.message).toContain('kind: command not found');
		});
	});

	// ─── cluster.start ────────────────────────────────────────────────────────

	describe('cluster.start', () => {
		it('runs kind create cluster', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig({ action: 'cluster.start' }));

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['create', 'cluster', '--name', 'kind'],
				expect.any(Object),
			);
		});

		it('passes config_path when provided', async () => {
			await target.init({
				id: 'docker-ctl',
				connector: 'docker',
				config: { config_path: '/etc/kind/config.yaml' },
			});
			const event = createTestEvent();
			await target.deliver(event, makeRouteConfig({ action: 'cluster.start' }));

			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['create', 'cluster', '--name', 'kind', '--config', '/etc/kind/config.yaml'],
				expect.any(Object),
			);
		});

		it('prefers route config config_path over connector config', async () => {
			await target.init({
				id: 'docker-ctl',
				connector: 'docker',
				config: { config_path: '/default.yaml' },
			});
			const event = createTestEvent();
			await target.deliver(
				event,
				makeRouteConfig({ action: 'cluster.start', config_path: '/override.yaml' }),
			);

			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['create', 'cluster', '--name', 'kind', '--config', '/override.yaml'],
				expect.any(Object),
			);
		});
	});

	// ─── container.stop ───────────────────────────────────────────────────────

	describe('container.stop', () => {
		it('runs docker stop with container name', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(
				event,
				makeRouteConfig({ action: 'container.stop', container_name: 'nginx' }),
			);

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith('docker', ['stop', 'nginx'], expect.any(Object));
		});

		it('uses container_name from connector config', async () => {
			await target.init({
				id: 'docker-ctl',
				connector: 'docker',
				config: { container_name: 'redis' },
			});
			const event = createTestEvent();
			await target.deliver(event, makeRouteConfig({ action: 'container.stop' }));

			expect(execFn).toHaveBeenCalledWith('docker', ['stop', 'redis'], expect.any(Object));
		});

		it('rejects when no container name available', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig({ action: 'container.stop' }));

			expect(result.status).toBe('rejected');
			expect(result.error?.message).toContain('container_name');
		});
	});

	// ─── container.start ──────────────────────────────────────────────────────

	describe('container.start', () => {
		it('runs docker start with container name', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(
				event,
				makeRouteConfig({ action: 'container.start', container_name: 'postgres' }),
			);

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith('docker', ['start', 'postgres'], expect.any(Object));
		});

		it('rejects when no container name available', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig({ action: 'container.start' }));

			expect(result.status).toBe('rejected');
			expect(result.error?.message).toContain('container_name');
		});
	});

	// ─── Action validation ────────────────────────────────────────────────────

	describe('action validation', () => {
		it('rejects missing action', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig());

			expect(result.status).toBe('rejected');
			expect(result.error?.message).toContain('Invalid or missing action');
		});

		it('rejects unknown action', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();
			const result = await target.deliver(event, makeRouteConfig({ action: 'cluster.destroy' }));

			expect(result.status).toBe('rejected');
			expect(result.error?.message).toContain('cluster.destroy');
		});

		it('reads action from event payload when not in route config', async () => {
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent({
				payload: { action: 'cluster.shutdown' },
			});
			const result = await target.deliver(event, makeRouteConfig());

			expect(result.status).toBe('delivered');
			expect(execFn).toHaveBeenCalledWith(
				'kind',
				['delete', 'cluster', '--name', 'kind'],
				expect.any(Object),
			);
		});
	});

	// ─── Delay ────────────────────────────────────────────────────────────────

	describe('delay', () => {
		it('delays execution when delay is specified', async () => {
			vi.useFakeTimers();
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent();

			const promise = target.deliver(
				event,
				makeRouteConfig({ action: 'cluster.shutdown', delay: 0.01 }),
			);

			// Advance past the 10ms delay
			await vi.advanceTimersByTimeAsync(15);
			const result = await promise;

			expect(result.status).toBe('delivered');
			vi.useRealTimers();
		});

		it('reads delay from event payload', async () => {
			vi.useFakeTimers();
			await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
			const event = createTestEvent({ payload: { delay: 0.01 } });

			const promise = target.deliver(event, makeRouteConfig({ action: 'cluster.shutdown' }));

			await vi.advanceTimersByTimeAsync(15);
			const result = await promise;

			expect(result.status).toBe('delivered');
			vi.useRealTimers();
		});
	});

	// ─── Shutdown ─────────────────────────────────────────────────────────────

	it('shutdown is a no-op', async () => {
		await target.init({ id: 'docker-ctl', connector: 'docker', config: {} });
		await expect(target.shutdown()).resolves.toBeUndefined();
	});
});
