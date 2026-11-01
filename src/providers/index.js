// Provider seam (hackathon V1): every engine is described the same way so the
// runner and renderer never branch on vendor names.
//
// - { type: 'cli' } engines launch as child processes. Their specs migrate
//   here from agent-runner during the V1 port; until then the runner keeps
//   its existing launch path for these vendors.
// - { type: 'api' } engines run in the main process over HTTPS and stream
//   the same output/step/done lifecycle as a child process.
//
// Meta (Muse Spark over an OpenAI-compatible endpoint, Baseten today) is the
// first api-type engine. Swapping endpoints means changing base URL config,
// never call sites.
const meta = require('./meta');

const CLI_VENDORS = ['antigravity', 'claude', 'codex', 'grok'];

function get(vendor) {
  if (vendor === 'meta') return { id: 'meta', type: 'api', driver: meta };
  if (CLI_VENDORS.includes(vendor)) return { id: vendor, type: 'cli', driver: null };
  throw new Error(`unknown provider: ${vendor}`);
}

function isApiProvider(vendor) {
  try {
    return get(vendor).type === 'api';
  } catch (_) {
    return false;
  }
}

module.exports = { get, isApiProvider, CLI_VENDORS };