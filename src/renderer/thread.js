// The shared chat thread: one list of messages from Matt, the chat's agents
// and the app itself, plus the agents themselves (thread.members, see
// members.js). Plain data, no DOM, so it runs in the window and in node --test.
// buildPrompt turns it into the text each agent launch receives, because the
// CLIs remember nothing between launches.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./members'));
  else root.ChatThread = factory(root.ChatMembers);
})(typeof self !== 'undefined' ? self : this, function ({ VENDORS, VENDOR_NAMES }) {
  const ENDINGS = ['stopped', 'timed out'];
  const TITLE_LENGTH = 40;

  function createThread(members = []) {
    return { messages: [], nextId: 1, members };
  }

  function isMember(thread, id) {
    return (thread.members || []).some(m => m.id === id);
  }

  // from: 'matt', 'system', or a member id. Matt's messages say which member
  // they are for (to); relayOf marks one that passes on another member's reply
  // (TM-47 relay). endedAs marks an agent reply cut short: 'stopped' or
  // 'timed out'. threadOf puts a message in the thread under a main-chat
  // message (TM-53 Batch 3); handoff marks an app note where one member
  // brought another in. Returns the new message, or throws on bad input.
  function addMessage(thread, { from, to = null, text, relayOf = null, endedAs = null, threadOf = null, handoff = null }) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw new Error('A message needs text');
    if (from !== 'matt' && from !== 'system' && !isMember(thread, from)) {
      throw new Error(`Unknown sender: ${from}`);
    }
    if (from === 'matt' && !isMember(thread, to)) {
      throw new Error(`Pick an agent to send to (got ${to})`);
    }
    if (relayOf !== null && (from !== 'matt' || !isMember(thread, relayOf) || relayOf === to)) {
      throw new Error(`Can't relay ${relayOf}'s reply to ${to}`);
    }
    if (threadOf !== null) {
      const root = thread.messages.find(m => m.id === threadOf);
      if (!root || root.threadOf || root.from === 'system') throw new Error(`Bad thread: ${threadOf}`);
    }
    if (handoff !== null && (from !== 'system' || !isMember(thread, handoff.from) ||
        !isMember(thread, handoff.to) || handoff.from === handoff.to)) {
      throw new Error('Bad handoff');
    }
    const message = { id: thread.nextId++, from, to: from === 'matt' ? to : null, text: body, ts: new Date().toISOString() };
    if (relayOf) message.relayOf = relayOf;
    if (threadOf !== null) message.threadOf = threadOf;
    if (handoff) message.handoff = { from: handoff.from, to: handoff.to };
    if (endedAs !== null) {
      if (!isMember(thread, from) || !ENDINGS.includes(endedAs)) throw new Error(`Bad ending: ${endedAs}`);
      message.endedAs = endedAs;
    }
    thread.messages.push(message);
    return message;
  }

  function nameMap(thread) {
    return Object.fromEntries((thread.members || []).map(m => [m.id, m.name]));
  }

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

  // Where `@name` first appears in text as a whole word, or -1.
  function mentionAt(text, name) {
    const hit = new RegExp(`(^|[^\\w@])@${escapeRegExp(name)}(?![\\w-])`, 'i').exec(text);
    return hit ? hit.index : -1;
  }

  // The first member other than selfId that text brings in with @Name, or null.
  function findMention(text, selfId, members) {
    const t = findTarget(text, selfId, members, {});
    return t && t.memberId ? t.memberId : null;
  }

  // Who text brings in with @ (TM-54): { memberId } for a member by name, or
  // { vendor } for a vendor's name that no member of the chat has (it joins
  // on its default model). The earliest @ wins; selfId is never a target.
  function findTarget(text, selfId, members, vendorNames = VENDOR_NAMES) {
    const names = new Set(members.map(m => m.name.toLowerCase()));
    const candidates = members.filter(m => m.id !== selfId).map(m => ({ name: m.name, target: { memberId: m.id } }))
      .concat(VENDORS.filter(v => vendorNames[v] && !names.has(vendorNames[v].toLowerCase()))
        .map(v => ({ name: vendorNames[v], target: { vendor: v } })));
    let best = null;
    for (const c of candidates) {
      const at = mentionAt(text, c.name);
      if (at !== -1 && (!best || at < best.at)) best = { at, target: c.target };
    }
    return best ? best.target : null;
  }

  // Who answers Matt's message: the first @ in it, else (in a thread) the
  // agent who wrote the thread's first message, else the chat's own agent.
  function routeMessage(thread, text, threadOf = null, vendorNames = VENDOR_NAMES) {
    const t = findTarget(text, null, thread.members, vendorNames);
    if (t) return t;
    const root = threadOf === null ? null : thread.messages.find(m => m.id === threadOf);
    if (root && isMember(thread, root.from)) return { memberId: root.from };
    return { memberId: thread.members[0].id };
  }

  // What an agent added from this chat carries to another one: the newest
  // messages (threads included), at most maxChars, oldest dropped first.
  function memorySnapshot(thread, maxChars = 4000) {
    const names = nameMap(thread);
    const lines = [];
    let used = 0;
    const said = thread.messages.filter(m => m.from !== 'system');
    for (let i = said.length - 1; i >= 0; i--) {
      const line = historyLine(said[i], names, true);
      if (used + line.length + 2 > maxChars) break;
      lines.unshift(line);
      used += line.length + 2;
    }
    return lines.join('\n\n');
  }

  // Agents bringing each other in stops after this many hops until Matt says
  // something in the thread.
  const HOP_LIMIT = 3;

  function hopsSinceMatt(thread, rootId) {
    let hops = 0;
    for (const m of thread.messages) {
      if ((m.threadOf || null) !== rootId) continue;
      if (m.from === 'matt') hops = 0;
      else if (m.handoff) hops++;
    }
    return hops;
  }

  function list(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // The prompt for a member, answering the newest message: Matt's message to
  // it, or another member's reply that brought it in with @Name. Earlier
  // messages go in as history, newest kept first when it has to be cut: at
  // most maxMessages of them and maxChars of text, which keeps the command
  // line well under the Windows limit (~32k characters). App notes (from
  // 'system') are left out. With threadOf, the member answers in that thread:
  // it sees the main chat up to the thread's first message, then the thread.
  // In the main chat it sees everything, threads included.
  function buildPrompt(thread, memberId, { maxMessages = 20, maxChars = 12000, threadOf = null } = {}) {
    const members = thread.members || [];
    const me = members.find(m => m.id === memberId);
    const names = nameMap(thread);
    const said = thread.messages.filter(m => m.from !== 'system' &&
      (threadOf === null || m.threadOf === threadOf || (!m.threadOf && m.id <= threadOf)));
    const last = said[said.length - 1];
    const fromMatt = last && last.from === 'matt' && last.to === memberId;
    const handoff = last && isMember(thread, last.from) && findMention(last.text, last.from, members) === memberId;
    if (!me || (!fromMatt && !handoff)) {
      throw new Error(`The newest message is not from Matt to ${memberId} or a handoff to it`);
    }

    const who = `You are ${me.name} (${me.vendor}, model ${me.model || 'default'})`;
    const intro = members.length === 1
      ? `${who}, chatting one-on-one with Matt. To bring another agent in, write ${list(VENDORS.map(v => '@' + VENDOR_NAMES[v])).replace(' and ', ' or ')} in your reply. `
      : `${who}, one of ${members.length} AI agents (${list(members.map(m => m.name))}) in a group chat with Matt. To bring another agent in, write @Name in your reply. `;
    const where = threadOf === null ? '' : 'This is a thread off the main chat; Matt and the agents in it read every message here. ';
    const header = intro + where + 'Reply to the latest message in plain text.';

    // Background from the chat this member was added from counts toward the limit.
    const was = me.memory && me.memory.name && me.memory.name !== me.name ? ` (you were called ${me.memory.name} there)` : '';
    const memory = me.memory && me.memory.text ? `Background from your earlier chat '${me.memory.title}'${was}:\n${me.memory.text}` : '';
    const history = [];
    let used = memory.length;
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
    if (memory) parts.push(memory);
    if (history.length) parts.push('Recent conversation:\n' + history.join('\n\n'));
    if (handoff && !fromMatt) {
      parts.push(`${names[last.from]} brought you in with this message:\n` + last.text);
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

  return { VENDORS, HOP_LIMIT, createThread, addMessage, buildPrompt, chatTitle, findMention, findTarget, routeMessage, memorySnapshot, hopsSinceMatt };
});
