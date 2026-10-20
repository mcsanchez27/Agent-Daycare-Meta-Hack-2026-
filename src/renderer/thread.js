// The shared chat thread: one list of messages from Matt, the agents and the
// app itself. Plain data, no DOM, so it runs in the window and in node --test.
// Batch 2 builds the transcript that goes into each prompt from this list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatThread = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const AGENT_IDS = ['antigravity', 'claude', 'codex'];

  function createThread() {
    return { messages: [], nextId: 1 };
  }

  // from: 'matt', 'system', or an agent id. Matt's messages say which agent
  // they are for (to). Returns the new message, or throws on bad input.
  function addMessage(thread, { from, to = null, text }) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw new Error('A message needs text');
    if (from !== 'matt' && from !== 'system' && !AGENT_IDS.includes(from)) {
      throw new Error(`Unknown sender: ${from}`);
    }
    if (from === 'matt' && !AGENT_IDS.includes(to)) {
      throw new Error(`Pick an agent to send to (got ${to})`);
    }
    const message = { id: thread.nextId++, from, to: from === 'matt' ? to : null, text: body, ts: new Date().toISOString() };
    thread.messages.push(message);
    return message;
  }

  return { AGENT_IDS, createThread, addMessage };
});
