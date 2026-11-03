// Read-only git facts about a folder, for the sidecar's Workspace section.
// execFile with an args array (never a shell string), so a folder path can
// never become a command. Anything unexpected reads as null: no row shown.
const { execFile } = require('child_process');

function parseGitHubRepo(remote) {
  const s = String(remote || '').trim();
  const m = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s)
    || /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s)
    || /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

function defaultExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function getGitInfo(dir, exec = (args) => defaultExec('git', args)) {
  if (!dir || typeof dir !== 'string') return null;
  try {
    const remote = await exec(['-C', dir, 'remote', 'get-url', 'origin']);
    const repo = parseGitHubRepo(remote);
    if (!repo) return null;
    let branch = null;
    try {
      branch = String(await exec(['-C', dir, 'branch', '--show-current']) || '').trim() || null;
    } catch (_) { /* detached HEAD: repo still shown */ }
    return { repo, branch };
  } catch (_) {
    return null;
  }
}

module.exports = { parseGitHubRepo, getGitInfo };
