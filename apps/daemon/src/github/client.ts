import { Octokit } from '@octokit/rest'

import type {
  DraftComment,
  ReviewEvent,
  PullRequestSummary,
  PullRequestPage,
} from '@legible/protocol'

import type { CommandRunner } from '../preflight/command-runner.js'

export type GitHubReview = {
  id: number
  htmlUrl: string
  body: string
  submittedAt: string
}

export type CreateGitHubReview = {
  owner: string
  repo: string
  pullNumber: number
  commitId: string
  event: ReviewEvent
  body: string
  comments: DraftComment[]
}

export interface GitHubClient {
  getPullHead(owner: string, repo: string, pullNumber: number): Promise<string>
  createReview(input: CreateGitHubReview): Promise<GitHubReview>
  listReviews(owner: string, repo: string, pullNumber: number): Promise<GitHubReview[]>
}

export type PullRequestDetails = PullRequestSummary & { headSha: string; baseSha: string }
export interface PullRequestReader {
  listPullRequests(owner: string, repo: string, page: number): Promise<PullRequestPage>
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestDetails>
}

export class GitHubClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'GitHubClientError'
  }
}

export class OctokitGitHubClient implements GitHubClient, PullRequestReader {
  constructor(private readonly runner: CommandRunner) {}

  async listPullRequests(owner: string, repo: string, page: number): Promise<PullRequestPage> {
    const octokit = await this.#octokit()
    try {
      const response = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 30,
        page,
      })
      return {
        items: response.data.map(normalizePullRequest),
        page,
        hasNextPage: Boolean(response.headers.link?.includes('rel="next"')),
      }
    } catch (error) {
      throw githubError(error)
    }
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDetails> {
    const octokit = await this.#octokit()
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
      return { ...normalizePullRequest(data), headSha: data.head.sha, baseSha: data.base.sha }
    } catch (error) {
      throw githubError(error)
    }
  }

  async getPullHead(owner: string, repo: string, pullNumber: number): Promise<string> {
    const octokit = await this.#octokit()
    try {
      const response = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
      return response.data.head.sha
    } catch (error) {
      throw githubError(error)
    }
  }

  async createReview(input: CreateGitHubReview): Promise<GitHubReview> {
    const octokit = await this.#octokit()
    try {
      const response = await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        commit_id: input.commitId,
        event: input.event,
        body: input.body,
        comments: input.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          ...(comment.startLine === undefined
            ? {}
            : { start_line: comment.startLine, start_side: comment.startSide }),
          body: comment.body,
        })),
      })
      return {
        id: response.data.id,
        htmlUrl: response.data.html_url,
        body: response.data.body ?? '',
        submittedAt: response.data.submitted_at ?? new Date().toISOString(),
      }
    } catch (error) {
      throw githubError(error)
    }
  }

  async listReviews(owner: string, repo: string, pullNumber: number): Promise<GitHubReview[]> {
    const octokit = await this.#octokit()
    try {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      })
      return reviews.map((review) => ({
        id: review.id,
        htmlUrl: review.html_url,
        body: review.body ?? '',
        submittedAt: review.submitted_at ?? '',
      }))
    } catch (error) {
      throw githubError(error)
    }
  }

  async #octokit(): Promise<Octokit> {
    const result = await this.runner.run('gh', ['auth', 'token', '--hostname', 'github.com'], {
      timeoutMs: 10_000,
    })
    if (result.status !== 'completed' || result.exitCode !== 0 || !result.stdout.trim()) {
      throw new GitHubClientError('GitHub authentication is unavailable', 401)
    }
    return new Octokit({
      auth: result.stdout.trim(),
      request: { headers: { 'x-github-api-version': '2026-03-10' } },
    })
  }
}

function normalizePullRequest(data: {
  number: number
  title: string
  html_url: string
  user: { login: string } | null
  base: { ref: string }
  head: { ref: string }
  draft?: boolean
  state: string
  updated_at: string
}): PullRequestSummary {
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    author: data.user?.login ?? 'unknown',
    baseRef: data.base.ref,
    headRef: data.head.ref,
    draft: data.draft ?? false,
    state: data.state === 'open' ? 'open' : 'closed',
    updatedAt: data.updated_at,
  }
}

function githubError(error: unknown): GitHubClientError {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined
  return new GitHubClientError('GitHub request failed', status, { cause: error })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
