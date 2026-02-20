/**
 * GitHub API response normalizer — maps GitHub events to OrgLoop events.
 */

import type { AuthorType, OrgLoopEvent } from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

/** Detect if a GitHub user is a bot by checking for [bot] suffix or type field */
function detectAuthorType(login: string, type?: string): AuthorType {
	if (type === 'Bot' || login.endsWith('[bot]')) {
		return 'bot';
	}
	return 'team_member';
}

/** Extract the login of a PR owner */
function extractPrAuthor(pr: Record<string, unknown>): string {
	const prUser = pr.user as Record<string, unknown> | undefined;
	return (prUser?.login as string) ?? 'unknown';
}

/** Normalize a PR review event */
export function normalizePullRequestReview(
	sourceId: string,
	review: Record<string, unknown>,
	pr: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = review.user as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'pull_request.review_submitted',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(pr),
			repo: (repo.full_name as string) ?? '',
			pr_number: pr.number as number,
			url: (review.html_url as string) ?? '',
			review_id: review.id as number,
			review_state: review.state as string,
		},
		payload: {
			action: 'review_submitted',
			review_id: review.id,
			review_state: review.state,
			review_body: review.body,
			pr_title: pr.title,
			pr_number: pr.number,
		},
	});
}

/** Normalize a PR review comment event */
export function normalizePullRequestReviewComment(
	sourceId: string,
	comment: Record<string, unknown>,
	pr: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = comment.user as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'pull_request_review_comment',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(pr),
			repo: (repo.full_name as string) ?? '',
			pr_number: pr.number as number,
			url: (comment.html_url as string) ?? '',
		},
		payload: {
			action: 'review_comment',
			comment_body: comment.body,
			pr_title: pr.title,
			pr_number: pr.number,
			diff_hunk: comment.diff_hunk,
			path: comment.path,
		},
	});
}

/** Normalize an issue comment on a PR */
export function normalizeIssueComment(
	sourceId: string,
	comment: Record<string, unknown>,
	issue: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = comment.user as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'issue_comment',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(issue),
			repo: (repo.full_name as string) ?? '',
			pr_number: issue.number as number,
			url: (comment.html_url as string) ?? '',
		},
		payload: {
			action: 'issue_comment',
			comment_body: comment.body,
			issue_title: issue.title,
			issue_number: issue.number,
			is_pull_request: !!issue.pull_request,
		},
	});
}

/** Normalize a PR closed/merged event */
export function normalizePullRequestClosed(
	sourceId: string,
	pr: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = pr.user as Record<string, unknown> | undefined;
	const merged = pr.merged as boolean;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: merged ? 'pull_request.merged' : 'pull_request.closed',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(pr),
			repo: (repo.full_name as string) ?? '',
			pr_number: pr.number as number,
			url: (pr.html_url as string) ?? '',
		},
		payload: {
			action: merged ? 'merged' : 'closed',
			pr_title: pr.title,
			pr_number: pr.number,
			merged,
			merged_by: merged ? ((pr.merged_by as Record<string, unknown>)?.login as string) : undefined,
		},
	});
}

/** Normalize a workflow run completion (failure) */
export function normalizeWorkflowRunFailed(
	sourceId: string,
	run: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const actor = run.actor as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'workflow_run.completed',
			author: (actor?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(actor?.login as string) ?? '',
				actor?.type as string | undefined,
			),
			repo: (repo.full_name as string) ?? '',
			url: (run.html_url as string) ?? '',
		},
		payload: {
			action: 'workflow_run_failed',
			workflow_name: run.name,
			run_number: run.run_number,
			conclusion: run.conclusion,
			head_branch: run.head_branch,
			head_sha: run.head_sha,
		},
	});
}

/** Normalize a PR opened event */
export function normalizePullRequestOpened(
	sourceId: string,
	pr: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = pr.user as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'pull_request.opened',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(pr),
			repo: (repo.full_name as string) ?? '',
			pr_number: pr.number as number,
			url: (pr.html_url as string) ?? '',
		},
		payload: {
			action: 'opened',
			pr_title: pr.title,
			pr_number: pr.number,
			draft: pr.draft ?? false,
			head_ref: pr.head ? (pr.head as Record<string, unknown>).ref : undefined,
			base_ref: pr.base ? (pr.base as Record<string, unknown>).ref : undefined,
		},
	});
}

/** Normalize a PR draft→ready transition */
export function normalizePullRequestReadyForReview(
	sourceId: string,
	pr: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const user = pr.user as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'pull_request.ready_for_review',
			author: (user?.login as string) ?? 'unknown',
			author_type: detectAuthorType(
				(user?.login as string) ?? '',
				user?.type as string | undefined,
			),
			pr_author: extractPrAuthor(pr),
			repo: (repo.full_name as string) ?? '',
			pr_number: pr.number as number,
			url: (pr.html_url as string) ?? '',
		},
		payload: {
			action: 'ready_for_review',
			pr_title: pr.title,
			pr_number: pr.number,
			head_ref: pr.head ? (pr.head as Record<string, unknown>).ref : undefined,
			base_ref: pr.base ? (pr.base as Record<string, unknown>).ref : undefined,
		},
	});
}

/** Normalize a check suite completion event */
export function normalizeCheckSuiteCompleted(
	sourceId: string,
	suite: Record<string, unknown>,
	repo: Record<string, unknown>,
): OrgLoopEvent {
	const app = suite.app as Record<string, unknown> | undefined;
	return buildEvent({
		source: sourceId,
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'check_suite.completed',
			author: (app?.slug as string) ?? 'unknown',
			author_type: 'bot' as const,
			repo: (repo.full_name as string) ?? '',
			url: (suite.url as string) ?? '',
		},
		payload: {
			action: 'check_suite_completed',
			conclusion: suite.conclusion,
			status: suite.status,
			app_name: app?.name ?? app?.slug,
			head_branch: suite.head_branch,
			head_sha: suite.head_sha,
			before: suite.before,
			after: suite.after,
		},
	});
}
