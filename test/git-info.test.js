const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGitHubRepo, getGitInfo } = require('../src/git-info');

test('parseGitHubRepo reads https, ssh and .git remotes', () => {
  assert.equal(parseGitHubRepo('https://github.com/mcsanchez27/Agent-Daycare-Meta-Hack-2026-.git'), 'mcsanchez27/Agent-Daycare-Meta-Hack-2026-');
  assert.equal(parseGitHubRepo('https://github.com/mcsanchez27/repo'), 'mcsanchez27/repo');
  assert.equal(parseGitHubRepo('git@github.com:mcsanchez27/repo.git'), 'mcsanchez27/repo');
  assert.equal(parseGitHubRepo('ssh://git@github.com/mcsanchez27/repo.git'), 'mcsanchez27/repo');
  assert.equal(parseGitHubRepo('https://gitlab.com/mcsanchez27/repo.git'), null);
  assert.equal(parseGitHubRepo(''), null);
  assert.equal(parseGitHubRepo(null), null);
});

test('getGitInfo returns repo and branch from git output', async () => {
  const exec = async (args) => (args.includes('get-url') ? 'git@github.com:me/proj.git\n' : 'meta/live-glance\n');
  assert.deepEqual(await getGitInfo('/tmp/x', exec), { repo: 'me/proj', branch: 'meta/live-glance' });
});

test('getGitInfo is null outside a repo or for non-GitHub remotes', async () => {
  const boom = async () => { throw new Error('not a repo'); };
  assert.equal(await getGitInfo('/tmp/x', boom), null);
  const gitlab = async (args) => (args.includes('get-url') ? 'https://gitlab.com/me/p.git' : 'main');
  assert.equal(await getGitInfo('/tmp/x', gitlab), null);
});
