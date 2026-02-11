/**
 * GOG (Gmail) response normalizer — maps Gmail data to OrgLoop events.
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

/** Normalize a new email received event */
export function normalizeEmailReceived(
	sourceId: string,
	message: {
		id: string;
		threadId: string;
		subject: string;
		from: { name: string; email: string };
		to: Array<{ name: string; email: string }>;
		cc: Array<{ name: string; email: string }>;
		date: string;
		labels: string[];
		snippet: string;
		body_text?: string;
		body_html?: string;
	},
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'gmail',
			platform_event: 'email.received',
			author: message.from.email,
			author_type: 'external',
			url: `https://mail.google.com/mail/u/0/#inbox/${message.threadId}`,
		},
		payload: {
			message_id: message.id,
			thread_id: message.threadId,
			subject: message.subject,
			from: message.from,
			to: message.to,
			cc: message.cc,
			date: message.date,
			labels: message.labels,
			snippet: message.snippet,
			...(message.body_text !== undefined ? { body_text: message.body_text } : {}),
			...(message.body_html !== undefined ? { body_html: message.body_html } : {}),
		},
	});
}

/** Normalize an email label change event (history mode only) */
export function normalizeEmailLabelChanged(
	sourceId: string,
	message: {
		id: string;
		threadId: string;
		labelsAdded: string[];
		labelsRemoved: string[];
	},
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'gmail',
			platform_event: 'email.label_changed',
			author: 'unknown',
			author_type: 'unknown',
		},
		payload: {
			message_id: message.id,
			thread_id: message.threadId,
			labels_added: message.labelsAdded,
			labels_removed: message.labelsRemoved,
		},
	});
}
