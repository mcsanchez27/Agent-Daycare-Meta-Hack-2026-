// The shared chat thread: one list of messages from Matt, the agents and the
// app itself. Plain data, no DOM, so it runs in the window and in node --test.
// buildPrompt turns it into the text each agent launch receives, because the
// CLIs remember nothing between launches.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatThread = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const AGENT_IDS = ['antigravity', 'claude', 'codex'];
  const ENDINGS = ['stopped', 'timed out'];
  const TITLE_LENGTH = 40;

  function createThread() {
    return { messages: [], nextId: 1 };
  }

  // from: 'matt', 'system', or an agent id. Matt's messages say which agent
  // they are for (to); relayOf marks one that passes on another agent's reply
  // (Batch 4 relay). endedAs marks an agent reply cut short: 'stopped' or
  // 'timed out'. Returns the new message, or throws on bad input.
  function addMessage(thread, { from, to = null, text, relayOf = null, endedAs = null }) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw new Error('A message needs text');
    if (from !== 'matt' && from !== 'system' && !AGENT_IDS.includes(from)) {
      throw new Error(`Unknown sender: ${from}`);
    }
    if (from === 'matt' && !AGENT_IDS.includes(to)) {
      throw new Error(`Pick an agent to send to (got ${to})`);
    }
    if (relayOf !== null && (from !== 'matt' || !AGENT_IDS.includes(relayOf) || relayOf === to)) {
      throw new Error(`Can't relay ${relayOf}'s reply to ${to}`);
    }
    const message = { id: thread.nextId++, from, to: from === 'matt' ? to : null, text: body, ts: new Date().toISOString() };
    if (relayOf) message.relayOf = relayOf;
    if (endedAs !== null) {
      if (!AGENT_IDS.includes(from) || !ENDINGS.includes(endedAs)) throw new Error(`Bad ending: ${endedAs}`);
      message.endedAs = endedAs;
    }
    thread.messages.push(message);
    return message;
  }

  const DEFAULT_NAMES = { antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex' };

  function speaker(m, names) {
    return m.from === 'matt' ? `Matt (to ${names[m.to] || m.to})` : (names[m.from] || m.from);
  }

  // A relayed reply is already in the history under the agent who wrote it,
  // so the relay itself is a short line rather than the whole text again.
  function historyLine(m, names) {
    if (m.relayOf) return `${speaker(m, names)}: [passed on ${names[m.relayOf] || m.relayOf}'s reply]`;
    return `${speaker(m, names)}: ${m.text}`;
  }

  // The prompt for agentId, answering Matt's newest message (the last one in
  // the thread). Earlier messages go in as history, newest kept first when it
  // has to be cut: at most maxMessages of them and maxChars of text, which
  // keeps the command line well under the Windows limit (~32k characters).
  // App notes (from 'system') are left out.
  function buildPrompt(thread, agentId, { names = DEFAULT_NAMES, maxMessages = 20, maxChars = 12000 } = {}) {
    const last = thread.messages[thread.messages.length - 1];
    if (!last || last.from !== 'matt' || last.to !== agentId) {
      throw new Error(`The newest message is not from Matt to ${agentId}`);
    }
    const name = names[agentId] || agentId;
    const all = AGENT_IDS.map(id => names[id] || id);
    const header = `You are ${name}, one of three AI agents (${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}) in a shared chat with Matt. ` +
      'Only Matt reads the chat; another agent sees your reply only if Matt passes it on. ' +
      "Reply to Matt's latest message in plain text.";

    const history = [];
    let used = 0;
    let earlier = thread.messages.slice(0, -1).filter(m => m.from !== 'system');
    if (last.relayOf) {
      // The relayed reply goes in at the end; don't spend room on it twice.
      const i = earlier.map(m => m.from === last.relayOf && m.text === last.text).lastIndexOf(true);
      if (i !== -1) earlier = earlier.filter((_, j) => j !== i);
    }
    for (let i = earlier.length - 1; i >= 0 && history.length < maxMessages; i--) {
      const line = historyLine(earlier[i], names);
      if (used + line.length > maxChars) break;
      history.unshift(line);
      used += line.length;
    }

    const parts = [header];
    if (history.length) parts.push('Recent conversation:\n' + history.join('\n\n'));
    if (last.relayOf) {
      parts.push(`Matt passed you this reply from ${names[last.relayOf] || last.relayOf}. Respond to it:\n` + last.text);
    } else {
      parts.push("Matt's message to you:\n" + last.text);
    }
    return parts.join('\n\n');
  }

  // A chat's title: Matt's first message, on one line and cut to 40 characters.
  function chatTitle(thread) {
    const first = thread.messages.find(m => m.from === 'matt');
    if (!first) return 'New chat';
    const line = first.text.replace(/\s+/g, ' ').trim();
    return line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1).trimEnd() + '…' : line;
  }

  return { AGENT_IDS, createThread, addMessage, buildPrompt, chatTitle };
});
