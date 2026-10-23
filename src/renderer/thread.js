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
  // 'timed out'. threadOf puts a message in the thread under a main-chat
  // message (TM-53 Batch 3); handoff marks an app note where one agent
  // brought another in. Returns the new message, or throws on bad input.
  function addMessage(thread, { from, to = null, text, relayOf = null, endedAs = null, threadOf = null, handoff = null }) {
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
    if (threadOf !== null) {
      const root = thread.messages.find(m => m.id === threadOf);
      if (!root || root.threadOf || root.from === 'system') throw new Error(`Bad thread: ${threadOf}`);
    }
    if (handoff !== null && (from !== 'system' || threadOf === null || !AGENT_IDS.includes(handoff.from) ||
        !AGENT_IDS.includes(handoff.to) || handoff.from === handoff.to)) {
      throw new Error('Bad handoff');
    }
    const message = { id: thread.nextId++, from, to: from === 'matt' ? to : null, text: body, ts: new Date().toISOString() };
    if (relayOf) message.relayOf = relayOf;
    if (threadOf !== null) message.threadOf = threadOf;
    if (handoff) message.handoff = { from: handoff.from, to: handoff.to };
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
  // In the main chat, thread messages are marked so agents can tell them apart.
  function historyLine(m, names, inMain) {
    const where = inMain && m.threadOf ? '(in a thread) ' : '';
    if (m.relayOf) return `${where}${speaker(m, names)}: [passed on ${names[m.relayOf] || m.relayOf}'s reply]`;
    return `${where}${speaker(m, names)}: ${m.text}`;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // The first agent other than selfId that text brings in with @Name (by the
  // agent's current name), or null.
  function findMention(text, selfId, names = DEFAULT_NAMES) {
    let best = null;
    for (const id of AGENT_IDS) {
      if (id === selfId) continue;
      const m = new RegExp(`(^|[^\\w@])@${escapeRegExp(names[id] || id)}(?![\\w-])`, 'i').exec(text);
      if (m && (!best || m.index < best.index)) best = { id, index: m.index };
    }
    return best ? best.id : null;
  }

  // Agents bringing each other in stops after this many hops until Matt says
  // something in the thread.
  const HOP_LIMIT = 3;

  function hopsSinceMatt(thread, rootId) {
    let hops = 0;
    for (const m of thread.messages) {
      if (m.threadOf !== rootId) continue;
      if (m.from === 'matt') hops = 0;
      else if (m.handoff) hops++;
    }
    return hops;
  }

  // The prompt for agentId, answering the newest message: Matt's message to
  // it, or another agent's reply that brought it in with @Name. Earlier
  // messages go in as history, newest kept first when it has to be cut: at
  // most maxMessages of them and maxChars of text, which keeps the command
  // line well under the Windows limit (~32k characters). App notes (from
  // 'system') are left out. With threadOf, the agent answers in that thread:
  // it sees the main chat up to the thread's first message, then the thread.
  // In the main chat it sees everything, threads included.
  function buildPrompt(thread, agentId, { names = DEFAULT_NAMES, maxMessages = 20, maxChars = 12000, threadOf = null } = {}) {
    const said = thread.messages.filter(m => m.from !== 'system' &&
      (threadOf === null || m.threadOf === threadOf || (!m.threadOf && m.id <= threadOf)));
    const last = said[said.length - 1];
    const fromMatt = last && last.from === 'matt' && last.to === agentId;
    const handoff = last && AGENT_IDS.includes(last.from) && findMention(last.text, last.from, names) === agentId;
    if (!fromMatt && !handoff) {
      throw new Error(`The newest message is not from Matt to ${agentId} or a handoff to it`);
    }
    const name = names[agentId] || agentId;
    const all = AGENT_IDS.map(id => names[id] || id);
    const where = threadOf === null
      ? 'Only Matt reads the chat; another agent sees your reply only if Matt passes it on, or if you bring them in by writing @Name in your reply (they answer in a thread under it). '
      : 'This is a thread off the main chat. Matt and the agents in it read every message here. To bring another agent in, write @Name in your reply. ';
    const header = `You are ${name}, one of three AI agents (${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}) in a shared chat with Matt. ` +
      where + 'Reply to the latest message in plain text.';

    const history = [];
    let used = 0;
    let earlier = said.slice(0, -1);
    if (last.relayOf) {
      // The relayed reply goes in at the end; don't spend room on it twice.
      const i = earlier.map(m => m.from === last.relayOf && m.text === last.text).lastIndexOf(true);
      if (i !== -1) earlier = earlier.filter((_, j) => j !== i);
    }
    for (let i = earlier.length - 1; i >= 0 && history.length < maxMessages; i--) {
      const line = historyLine(earlier[i], names, threadOf === null);
      if (used + line.length > maxChars) break;
      history.unshift(line);
      used += line.length;
    }

    const parts = [header];
    if (history.length) parts.push('Recent conversation:\n' + history.join('\n\n'));
    if (handoff && !fromMatt) {
      parts.push(`${names[last.from] || last.from} brought you in with this message:\n` + last.text);
    } else if (last.relayOf) {
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

  return { AGENT_IDS, HOP_LIMIT, createThread, addMessage, buildPrompt, chatTitle, findMention, hopsSinceMatt };
});
