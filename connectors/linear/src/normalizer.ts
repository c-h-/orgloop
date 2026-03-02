/**
 * Linear API response normalizer — maps Linear data to OrgLoop events.
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

/** Normalize a Linear issue state change */
export function normalizeIssueStateChange(
	sourceId: string,
	issue: {
		id: string;
		identifier: string;
		title: string;
		url: string;
		state: { name: string };
		assignee?: { name: string; isBot?: boolean } | null;
		updatedAt: string;
	},
	previousState: string | undefined,
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.state_changed',
			author: issue.assignee?.name ?? 'unknown',
			author_type: issue.assignee?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			state: issue.state.name,
			url: issue.url,
		},
		payload: {
			action: 'state_changed',
			issue_id: issue.identifier,
			issue_title: issue.title,
			previous_state: previousState,
			new_state: issue.state.name,
		},
	});
}

/** Normalize a new Linear comment */
export function normalizeComment(
	sourceId: string,
	comment: {
		id: string;
		body: string;
		url: string;
		createdAt: string;
		user?: { name: string; isBot?: boolean } | null;
	},
	issue: {
		identifier: string;
		title: string;
		assignee?: { name: string } | null;
		creator?: { name: string } | null;
	},
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'comment.created',
			author: comment.user?.name ?? 'unknown',
			author_type: comment.user?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			issue_assignee: issue.assignee?.name ?? null,
			issue_creator: issue.creator?.name ?? null,
			url: comment.url,
		},
		payload: {
			action: 'comment_created',
			issue_id: issue.identifier,
			issue_title: issue.title,
			comment_body: comment.body,
		},
	});
}

/** Normalize a new Linear issue */
export function normalizeNewIssue(
	sourceId: string,
	issue: {
		id: string;
		identifier: string;
		title: string;
		description?: string | null;
		url: string;
		state: { name: string };
		creator?: { name: string; isBot?: boolean } | null;
		createdAt: string;
	},
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.created',
			author: issue.creator?.name ?? 'unknown',
			author_type: issue.creator?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			state: issue.state.name,
			url: issue.url,
		},
		payload: {
			action: 'issue_created',
			issue_id: issue.identifier,
			issue_title: issue.title,
			issue_description: issue.description ?? '',
			state: issue.state.name,
		},
	});
}

/** Normalize a Linear issue assignee change */
export function normalizeAssigneeChange(
	sourceId: string,
	issue: {
		identifier: string;
		title: string;
		url: string;
		assignee?: { name: string; isBot?: boolean } | null;
		updatedAt: string;
	},
	previousAssignee: string | null,
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.assignee_changed',
			author: issue.assignee?.name ?? 'unknown',
			author_type: issue.assignee?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			url: issue.url,
		},
		payload: {
			action: 'assignee_changed',
			issue_id: issue.identifier,
			issue_title: issue.title,
			previous_assignee: previousAssignee,
			new_assignee: issue.assignee?.name ?? null,
		},
	});
}

/** Normalize a Linear issue priority change */
export function normalizePriorityChange(
	sourceId: string,
	issue: {
		identifier: string;
		title: string;
		url: string;
		assignee?: { name: string; isBot?: boolean } | null;
		updatedAt: string;
	},
	previousPriority: number,
	newPriority: number,
): OrgLoopEvent {
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.priority_changed',
			author: issue.assignee?.name ?? 'unknown',
			author_type: issue.assignee?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			url: issue.url,
		},
		payload: {
			action: 'priority_changed',
			issue_id: issue.identifier,
			issue_title: issue.title,
			previous_priority: previousPriority,
			new_priority: newPriority,
		},
	});
}

/** Normalize a Linear issue label change */
export function normalizeLabelChange(
	sourceId: string,
	issue: {
		identifier: string;
		title: string;
		url: string;
		assignee?: { name: string; isBot?: boolean } | null;
		updatedAt: string;
	},
	previousLabels: string[],
	newLabels: string[],
): OrgLoopEvent {
	const added = newLabels.filter((l) => !previousLabels.includes(l));
	const removed = previousLabels.filter((l) => !newLabels.includes(l));

	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.labels_changed',
			author: issue.assignee?.name ?? 'unknown',
			author_type: issue.assignee?.isBot ? 'bot' : 'team_member',
			issue_id: issue.identifier,
			url: issue.url,
		},
		payload: {
			action: 'labels_changed',
			issue_id: issue.identifier,
			issue_title: issue.title,
			previous_labels: previousLabels,
			new_labels: newLabels,
			added_labels: added,
			removed_labels: removed,
		},
	});
}
