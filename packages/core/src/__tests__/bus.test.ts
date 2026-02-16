import type { OrgLoopEvent } from '@orgloop/sdk';
import { createTestEvent } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { InMemoryBus } from '../bus.js';

describe('InMemoryBus', () => {
	it('publishes and delivers to subscribers', async () => {
		const bus = new InMemoryBus();
		const received: OrgLoopEvent[] = [];

		bus.subscribe({}, async (event) => {
			received.push(event);
		});

		const event = createTestEvent();
		await bus.publish(event);

		expect(received).toHaveLength(1);
		expect(received[0].id).toBe(event.id);
	});

	it('tracks unacked events', async () => {
		const bus = new InMemoryBus();
		bus.subscribe({}, async () => {});

		const event = createTestEvent();
		await bus.publish(event);

		const unacked = await bus.unacked();
		expect(unacked).toHaveLength(1);
	});

	it('ack removes from pending', async () => {
		const bus = new InMemoryBus();
		bus.subscribe({}, async () => {});

		const event = createTestEvent();
		await bus.publish(event);
		await bus.ack(event.id);

		const unacked = await bus.unacked();
		expect(unacked).toHaveLength(0);
	});

	it('filters by source', async () => {
		const bus = new InMemoryBus();
		const received: OrgLoopEvent[] = [];

		bus.subscribe({ source: 'github' }, async (event) => {
			received.push(event);
		});

		await bus.publish(createTestEvent({ source: 'github' }));
		await bus.publish(createTestEvent({ source: 'linear' }));

		expect(received).toHaveLength(1);
		expect(received[0].source).toBe('github');
	});

	it('filters by type', async () => {
		const bus = new InMemoryBus();
		const received: OrgLoopEvent[] = [];

		bus.subscribe({ type: 'actor.stopped' }, async (event) => {
			received.push(event);
		});

		await bus.publish(createTestEvent({ type: 'resource.changed' }));
		await bus.publish(createTestEvent({ type: 'actor.stopped' }));

		expect(received).toHaveLength(1);
		expect(received[0].type).toBe('actor.stopped');
	});

	it('supports multiple subscribers', async () => {
		const bus = new InMemoryBus();
		let count1 = 0;
		let count2 = 0;

		bus.subscribe({}, async () => {
			count1++;
		});
		bus.subscribe({}, async () => {
			count2++;
		});

		await bus.publish(createTestEvent());

		expect(count1).toBe(1);
		expect(count2).toBe(1);
	});

	it('unsubscribe stops delivery', async () => {
		const bus = new InMemoryBus();
		let count = 0;

		const sub = bus.subscribe({}, async () => {
			count++;
		});
		await bus.publish(createTestEvent());
		expect(count).toBe(1);

		sub.unsubscribe();
		await bus.publish(createTestEvent());
		expect(count).toBe(1);
	});
});
