import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PullRequestDetails } from '../github/client.js'
import { NodeCommandRunner, type CommandRunner } from '../preflight/command-runner.js'

const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

/** A real local Git remote; the runner substitutes it for origin only during fetch. */
export async function repositoryFixture(repoId = 'owner/repo', parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'legible-repository-'))
  const checkout = join(root, 'checkout')
  const bare = join(root, 'remote.git')
  const stateDirectory = join(root, 'state')
  await git(root, 'init', '--initial-branch=main', checkout)
  await git(checkout, 'config', 'user.name', 'Legible Tests')
  await git(checkout, 'config', 'user.email', 'tests@example.invalid')
  await git(checkout, 'config', 'commit.gpgsign', 'false')
  await git(checkout, 'config', 'core.hooksPath', '/dev/null')
  await writeFile(join(checkout, 'example.ts'), 'before\n')
  await git(checkout, 'add', '.')
  await git(checkout, 'commit', '-m', 'base')
  const baseSha = await git(checkout, 'rev-parse', 'HEAD')
  await git(checkout, 'checkout', '-b', 'feature')
  await writeFile(join(checkout, 'example.ts'), 'after\n')
  await git(checkout, 'commit', '-am', 'head')
  const headSha = await git(checkout, 'rev-parse', 'HEAD')
  await git(root, 'clone', '--bare', checkout, bare)
  await git(bare, 'update-ref', 'refs/pull/42/head', headSha)
  await git(checkout, 'remote', 'add', 'origin', `https://github.com/${repoId}.git`)
  const node = new NodeCommandRunner()
  const runner: CommandRunner = {
    run: (command, args, options) => {
      if (command !== 'git')
        return Promise.resolve({ status: 'completed', exitCode: 0, stdout: 'ready', stderr: '' })
      return node.run(
        command,
        args.includes('fetch') ? args.map((arg) => (arg === 'origin' ? bare : arg)) : args,
        options,
      )
    },
  }
  const pull: PullRequestDetails = {
    number: 42,
    title: 'Improve review context',
    url: `https://github.com/${repoId}/pull/42`,
    author: 'reviewer',
    baseRef: 'main',
    headRef: 'feature',
    draft: false,
    state: 'open',
    updatedAt: '2026-09-13T00:00:00Z',
    baseSha,
    headSha,
  }
  return { root, checkout, bare, stateDirectory, runner, pull }
}
