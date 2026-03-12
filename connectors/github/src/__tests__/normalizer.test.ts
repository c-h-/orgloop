import { describe, expect, it } from 'vitest';
import {
	normalizeIssueAssigned,
	normalizeIssueComment,
	normalizeIssueLabeled,
	normalizeIssueOpened,
	normalizePullRequestClosed,
	normalizePullRequestReview,
	normalizePullRequestReviewComment,
} from '../normalizer.js';

const repo = { full_name: 'org/repo' };

function makePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number: 42,
		title: 'Test PR',
		state: 'open',
		user: { login: 'author', type: 'User' },
		html_url: 'https://github.com/org/repo/pull/42',
		...overrides,
	};
}

describe('normalizePullRequestReview provenance', () => {
	const review = {
		id: 1,
		state: 'approved',
		body: 'LGTM',
		user: { login: 'reviewer', type: 'User' },
		html_url: 'https://github.com/org/repo/pull/42#pullrequestreview-1',
	};

	it('includes pr_number, pr_state, pr_merged for open PR', () => {
		const event = normalizePullRequestReview('gh', review, makePr(), repo);
		expect(event.provenance.pr_number).toBe(42);
		expect(event.provenance.pr_state).toBe('open');
		expect(event.provenance.pr_merged).toBe(false);
	});

	it('detects merged via merged_at', () => {
		const pr = makePr({ state: 'closed', merged_at: '2025-01-01T00:00:00Z' });
		const event = normalizePullRequestReview('gh', review, pr, repo);
		expect(event.provenance.pr_state).toBe('closed');
		expect(event.provenance.pr_merged).toBe(true);
	});

	it('detects merged via merged boolean', () => {
		const pr = makePr({ state: 'closed', merged: true });
		const event = normalizePullRequestReview('gh', review, pr, repo);
		expect(event.provenance.pr_merged).toBe(true);
	});
});

describe('normalizePullRequestReviewComment provenance', () => {
	const comment = {
		id: 2,
		body: 'nit',
		user: { login: 'reviewer', type: 'User' },
		html_url: 'https://github.com/org/repo/pull/42#discussion_r2',
		diff_hunk: '@@ -1,3 +1,3 @@',
		path: 'src/foo.ts',
	};

	it('includes pr_number, pr_state, pr_merged for open PR', () => {
		const event = normalizePullRequestReviewComment('gh', comment, makePr(), repo);
		expect(event.provenance.pr_number).toBe(42);
		expect(event.provenance.pr_state).toBe('open');
		expect(event.provenance.pr_merged).toBe(false);
	});

	it('detects merged via merged_at', () => {
		const pr = makePr({ state: 'closed', merged_at: '2025-01-01T00:00:00Z' });
		const event = normalizePullRequestReviewComment('gh', comment, pr, repo);
		expect(event.provenance.pr_merged).toBe(true);
	});
});

describe('normalizeIssueComment provenance', () => {
	const comment = {
		id: 3,
		body: 'Thanks!',
		user: { login: 'commenter', type: 'User' },
		html_url: 'https://github.com/org/repo/issues/42#issuecomment-3',
	};

	function makeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			number: 42,
			title: 'Test Issue',
			state: 'open',
			user: { login: 'author', type: 'User' },
			pull_request: { merged_at: null },
			...overrides,
		};
	}

	it('includes pr_number, pr_state, pr_merged for open issue', () => {
		const event = normalizeIssueComment('gh', comment, makeIssue(), repo);
		expect(event.provenance.pr_number).toBe(42);
		expect(event.provenance.pr_state).toBe('open');
		expect(event.provenance.pr_merged).toBe(false);
	});

	it('detects merged via pull_request.merged_at', () => {
		const issue = makeIssue({
			state: 'closed',
			pull_request: { merged_at: '2025-01-01T00:00:00Z' },
		});
		const event = normalizeIssueComment('gh', comment, issue, repo);
		expect(event.provenance.pr_state).toBe('closed');
		expect(event.provenance.pr_merged).toBe(true);
	});

	it('pr_merged is false when pull_request.merged_at is null', () => {
		const issue = makeIssue({
			state: 'closed',
			pull_request: { merged_at: null },
		});
		const event = normalizeIssueComment('gh', comment, issue, repo);
		expect(event.provenance.pr_merged).toBe(false);
	});
});

describe('normalizePullRequestClosed provenance', () => {
	it('includes pr_state and pr_merged for closed (not merged)', () => {
		const pr = makePr({ state: 'closed', merged: false });
		const event = normalizePullRequestClosed('gh', pr, repo);
		expect(event.provenance.pr_number).toBe(42);
		expect(event.provenance.pr_state).toBe('closed');
		expect(event.provenance.pr_merged).toBe(false);
	});

	it('includes pr_state and pr_merged for merged PR', () => {
		const pr = makePr({ state: 'closed', merged: true, merged_at: '2025-01-01T00:00:00Z' });
		const event = normalizePullRequestClosed('gh', pr, repo);
		expect(event.provenance.pr_state).toBe('closed');
		expect(event.provenance.pr_merged).toBe(true);
	});
});

// ─── Issue event normalizers ─────────────────────────────────────────────────

function makeIssueEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 1000,
		event: 'opened',
		created_at: '2025-01-15T10:00:00Z',
		actor: { login: 'alice', type: 'User' },
		issue: {
			number: 10,
			title: 'Bug report',
			state: 'open',
			user: { login: 'alice', type: 'User' },
			html_url: 'https://github.com/org/repo/issues/10',
		},
		...overrides,
	};
}

describe('normalizeIssueOpened', () => {
	it('sets platform_event to issues.opened', () => {
		const event = normalizeIssueOpened('gh', makeIssueEvent(), repo);
		expect(event.provenance.platform_event).toBe('issues.opened');
	});

	it('uses actor as author', () => {
		const event = normalizeIssueOpened('gh', makeIssueEvent(), repo);
		expect(event.provenance.author).toBe('alice');
		expect(event.provenance.author_type).toBe('team_member');
	});

	it('detects bot actor', () => {
		const event = normalizeIssueOpened(
			'gh',
			makeIssueEvent({ actor: { login: 'dependabot[bot]', type: 'Bot' } }),
			repo,
		);
		expect(event.provenance.author).toBe('dependabot[bot]');
		expect(event.provenance.author_type).toBe('bot');
	});

	it('populates payload with issue details', () => {
		const event = normalizeIssueOpened('gh', makeIssueEvent(), repo);
		expect(event.payload.action).toBe('opened');
		expect(event.payload.issue_title).toBe('Bug report');
		expect(event.payload.issue_number).toBe(10);
		expect(event.payload.issue_state).toBe('open');
	});

	it('sets resource_id with issue number', () => {
		const event = normalizeIssueOpened('gh', makeIssueEvent(), repo);
		expect(event.provenance.resource_id).toBe('issue-10-opened');
	});
});

describe('normalizeIssueLabeled', () => {
	const labeledEvent = makeIssueEvent({
		event: 'labeled',
		label: { name: 'bug', color: 'd73a4a' },
	});

	it('sets platform_event to issues.labeled', () => {
		const event = normalizeIssueLabeled('gh', labeledEvent, repo);
		expect(event.provenance.platform_event).toBe('issues.labeled');
	});

	it('includes label in provenance', () => {
		const event = normalizeIssueLabeled('gh', labeledEvent, repo);
		expect(event.provenance.label).toBe('bug');
	});

	it('includes label in payload', () => {
		const event = normalizeIssueLabeled('gh', labeledEvent, repo);
		expect(event.payload.label).toBe('bug');
		expect(event.payload.action).toBe('labeled');
	});

	it('sets resource_id with issue number and label', () => {
		const event = normalizeIssueLabeled('gh', labeledEvent, repo);
		expect(event.provenance.resource_id).toBe('issue-10-labeled-bug');
	});
});

describe('normalizeIssueAssigned', () => {
	const assignedEvent = makeIssueEvent({
		event: 'assigned',
		assignee: { login: 'bob', type: 'User' },
	});

	it('sets platform_event to issues.assigned', () => {
		const event = normalizeIssueAssigned('gh', assignedEvent, repo);
		expect(event.provenance.platform_event).toBe('issues.assigned');
	});

	it('includes assignee in payload', () => {
		const event = normalizeIssueAssigned('gh', assignedEvent, repo);
		expect(event.payload.assignee).toBe('bob');
		expect(event.payload.action).toBe('assigned');
	});

	it('sets resource_id with issue number and assignee', () => {
		const event = normalizeIssueAssigned('gh', assignedEvent, repo);
		expect(event.provenance.resource_id).toBe('issue-10-assigned-bob');
	});

	it('uses actor as author (the person who assigned)', () => {
		const event = normalizeIssueAssigned('gh', assignedEvent, repo);
		expect(event.provenance.author).toBe('alice');
	});
});
