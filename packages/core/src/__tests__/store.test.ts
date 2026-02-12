import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEvent } from '@orgloop/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore, InMemoryCheckpointStore, InMemoryEventStore } from '../store.js';

describe('InMemoryCheckpointStore', () => {
	let store: InMemoryCheckpointStore;

	beforeEach(() => {
		store = new InMemoryCheckpointStore();
	});

	it('returns null for unknown source', async () => {
		expect(await store.get('unknown')).toBeNull();
	});

	it('stores and retrieves checkpoint', async () => {
		await store.set('github', 'checkpoint-123');
		expect(await store.get('github')).toBe('checkpoint-123');
	});

	it('overwrites existing checkpoint', async () => {
		await store.set('github', 'v1');
		await store.set('github', 'v2');
		expect(await store.get('github')).toBe('v2');
	});

	it('handles multiple sources independently', async () => {
		await store.set('github', 'g-checkpoint');
		await store.set('linear', 'l-checkpoint');
		expect(await store.get('github')).toBe('g-checkpoint');
		expect(await store.get('linear')).toBe('l-checkpoint');
	});
});

describe('FileCheckpointStore', () => {
	let tempDir: string;
	let store: FileCheckpointStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-test-checkpoint-'));
		store = new FileCheckpointStore(tempDir);
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it('returns null for unknown source', async () => {
		expect(await store.get('unknown')).toBeNull();
	});

	it('stores and retrieves checkpoint', async () => {
		await store.set('gog-gmail', 'historyId:12345');
		expect(await store.get('gog-gmail')).toBe('historyId:12345');
	});

	it('overwrites existing checkpoint', async () => {
		await store.set('gog-gmail', 'v1');
		await store.set('gog-gmail', 'v2');
		expect(await store.get('gog-gmail')).toBe('v2');
	});

	it('persists checkpoints across store instances (simulates daemon restart)', async () => {
		// First "daemon lifecycle" — write checkpoint
		const store1 = new FileCheckpointStore(tempDir);
		await store1.set('gog-gmail', 'historyId:99999');

		// Second "daemon lifecycle" — new instance, same directory
		const store2 = new FileCheckpointStore(tempDir);
		const checkpoint = await store2.get('gog-gmail');

		// Checkpoint must survive the "restart"
		expect(checkpoint).toBe('historyId:99999');
	});

	it('handles multiple sources independently with persistence', async () => {
		await store.set('gog-gmail', 'gmail-cp');
		await store.set('github', 'github-cp');

		// New instance — both should survive
		const fresh = new FileCheckpointStore(tempDir);
		expect(await fresh.get('gog-gmail')).toBe('gmail-cp');
		expect(await fresh.get('github')).toBe('github-cp');
	});

	it('creates checkpoint directory if it does not exist', async () => {
		const nonExistentDir = join(tempDir, 'nested', 'deep', 'dir');
		const deepStore = new FileCheckpointStore(nonExistentDir);

		// Should not throw — mkdir { recursive: true } in set()
		await deepStore.set('test-source', 'cp-value');
		expect(await deepStore.get('test-source')).toBe('cp-value');
	});
});

describe('InMemoryEventStore', () => {
	let store: InMemoryEventStore;

	beforeEach(() => {
		store = new InMemoryEventStore();
	});

	it('writes and retrieves events', async () => {
		const event = createTestEvent();
		await store.write(event);

		const unacked = await store.unacked();
		expect(unacked).toHaveLength(1);
		expect(unacked[0].event.id).toBe(event.id);
		expect(unacked[0].acked).toBe(false);
	});

	it('ack marks events as acknowledged', async () => {
		const event = createTestEvent();
		await store.write(event);
		await store.ack(event.id);

		const unacked = await store.unacked();
		expect(unacked).toHaveLength(0);
	});

	it('multiple writes create multiple entries', async () => {
		await store.write(createTestEvent());
		await store.write(createTestEvent());
		await store.write(createTestEvent());

		const unacked = await store.unacked();
		expect(unacked).toHaveLength(3);
	});

	it('ack only affects the specified event', async () => {
		const e1 = createTestEvent();
		const e2 = createTestEvent();
		await store.write(e1);
		await store.write(e2);
		await store.ack(e1.id);

		const unacked = await store.unacked();
		expect(unacked).toHaveLength(1);
		expect(unacked[0].event.id).toBe(e2.id);
	});
});
