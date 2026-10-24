// The shared chat thread: one list of messages from Matt, the chat's agents
// and the app itself, plus the agents themselves (thread.members, see
// members.js). Plain data, no DOM, so it runs in the window and in node --test.
// buildPrompt turns it into the text each agent launch receives, because the
// CLIs remember nothing between launches.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./members'));
  else root.ChatThread = factory(root.ChatMembers);
})(typeof self !== 'undefined' ? self : this, function ({ VENDORS, VENDOR_NAMES, ROLES, newMember }) {
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
  // brought another in. TM-54 Batch 5: 'guest' is another chat asking this
  // one in the background (guest: { chatId, chatTitle, name }), and side, on
  // an app note, records a background ask this chat made
  // ({ chatId, chatTitle, asker, question, state, hop, answer? }).
  // Returns the new message, or throws on bad input.
  // What an agent did while it answered (TM-59), kept with its reply.
  const MAX_STEPS = 50;

  function addMessage(thread, { from, to = null, text, relayOf = null, endedAs = null, threadOf = null, handoff = null, guest = null, side = null, steps = null }) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw new Error('A message needs text');
    if (from !== 'matt' && from !== 'system' && from !== 'guest' && !isMember(thread, from)) {
      throw new Error(`Unknown sender: ${from}`);
    }
    if ((from === 'matt' || from === 'guest') && !isMember(thread, to)) {
      throw new Error(`Pick an agent to send to (got ${to})`);
    }
    if ((from === 'guest') !== Boolean(guest && guest.chatId && guest.chatTitle && guest.name)) {
      throw new Error('A guest message needs its guest: chatId, chatTitle and name');
    }
    if (side !== null && from !== 'system') throw new Error('Only app notes record background asks');
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
    const message = { id: thread.nextId++, from, to: from === 'matt' || from === 'guest' ? to : null, text: body, ts: new Date().toISOString() };
    if (guest) message.guest = { chatId: guest.chatId, chatTitle: guest.chatTitle, name: guest.name };
    if (side) message.side = { ...side };
    if (relayOf) message.relayOf = relayOf;
    if (threadOf !== null) message.threadOf = threadOf;
    if (handoff) message.handoff = { from: handoff.from, to: handoff.to };
    if (Array.isArray(steps) && steps.length && isMember(thread, from)) message.steps = steps.slice(-MAX_STEPS).map(String);
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
    if (m.from === 'guest') return `${m.guest.name} (from chat '${m.guest.chatTitle}')`;
    return m.from === 'matt' ? `Matt (to ${names[m.to] || m.to})` : (names[m.from] || m.from);
  }

  // Messages that go into prompts: everything but app notes, except the
  // background asks that got an answer.
  function spoken(m) {
    return m.from !== 'system' || Boolean(m.side && m.side.answer);
  }

  // A relayed reply is already in the history under the agent who wrote it,
  // so the relay itself is a short line rather than the whole text again.
  // In the main chat, thread messages are marked so agents can tell them apart.
  function historyLine(m, names, inMain) {
    const where = inMain && m.threadOf ? '(in a thread) ' : '';
    if (m.side) {
      const who = m.side.asker === 'matt' ? 'Matt' : (names[m.side.asker] || m.side.asker);
      return `${where}(in the background) ${who} asked the chat '${m.side.chatTitle}': ${m.side.question}\nIt answered: ${m.side.answer}`;
    }
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
    const said = thread.messages.filter(spoken);
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
  // A crew (agents with roles, TM-59) passes work along more: brief, design,
  // build, a question back. It gets more handoffs in a row before Matt.
  const CREW_HOP_LIMIT = 6;
  function hopLimit(thread) {
    return (thread.members || []).some(m => m.role && !m.left) ? CREW_HOP_LIMIT : HOP_LIMIT;
  }

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
  // A guest (another chat asking in the background) is answered like Matt.
  // answer ({ chatTitle, text }) is the follow-up after this member asked
  // another chat: the prompt ends with that chat's answer.
  // chatTitles: the titles of Matt's other chats, so an agent can ask one with #.
  // since: resume the member's vendor session, sending only messages after this id.
  // centralBrain: Mountain Man Studios operating doctrine (TM-60 Batch 4).
  // personaChip: dynamic persona instructions resolved from disk.
  // brainUpdate: notification notice for resumed sessions if brain files changed.
  function buildPrompt(thread, memberId, { maxMessages = 20, maxChars = 12000, threadOf = null, answer = null, chatTitles = [], since = null, centralBrain = null, personaChip = null, brainUpdate = null } = {}) {
    const members = thread.members || [];
    const me = members.find(m => m.id === memberId);
    const names = nameMap(thread);
    const said = thread.messages.filter(m => spoken(m) &&
      (threadOf === null || m.threadOf === threadOf || (!m.threadOf && m.id <= threadOf)));
    const last = said[said.length - 1];
    const fromMatt = last && (last.from === 'matt' || last.from === 'guest') && last.to === memberId;
    const handoff = last && isMember(thread, last.from) && findMention(last.text, last.from, members) === memberId;
    if (!me || (!answer && !fromMatt && !handoff)) {
      throw new Error(`The newest message is not from Matt to ${memberId} or a handoff to it`);
    }

    const who = `You are ${me.name} (${me.vendor}, model ${me.model || 'default'})`;
    // Agents Matt removed (TM-57, `left`) aren't in the room any more.
    const here = members.filter(m => !m.left);
    // Roles (TM-59): each agent knows its own brief and who does what.
    const roleOf = (m) => (m.role && ROLES[m.role] ? ROLES[m.role] : null);
    const effectivePersona = (personaChip || me.brainText || '').trim();
    const brain = effectivePersona ? `Your assigned persona directives:\n${effectivePersona} ` : '';
    const central = centralBrain ? `Central Brain directives:\n${centralBrain.trim()} ` : '';
    const intro = (here.length === 1
      ? `${who}, chatting one-on-one with Matt. To bring another agent in, write ${list(VENDORS.map(v => '@' + VENDOR_NAMES[v])).replace(' and ', ' or ')} in your reply. `
      : `${who}, one of ${here.length} AI agents (${list(here.map(m => (roleOf(m) ? `${m.name} (${roleOf(m).label})` : m.name)))}) in a group chat with Matt. To bring another agent in, write @Name in your reply; only do that when you need it to act, since every @ launches it (not to thank or agree). `) +
      (roleOf(me) ? `Your role: ${roleOf(me).label}. ${roleOf(me).brief} ` : '') +
      (central ? central : '') +
      (brain ? brain : '');
    const where = threadOf === null ? '' : 'This is a thread off the main chat; Matt and the agents in it read every message here. ';
    const background = "To ask one of Matt's other chats something without bringing it in, write # and that chat's exact title, then the question (for example: #Trip plans what dates did we pick?). The answer comes back to you here. " +
      (chatTitles.length ? `Matt's other chats: ${chatTitles.map(c => `"${c}"`).join(', ')}. ` : '');
    const header = intro + background + where + 'Reply to the latest message in plain text.';

    // Background from the chat this member was added from counts toward the limit.
    const was = me.memory && me.memory.name && me.memory.name !== me.name ? ` (you were called ${me.memory.name} there)` : '';
    const memory = me.memory && me.memory.text ? `Background from your earlier chat '${me.memory.title}'${was}:\n${me.memory.text}` : '';
    const history = [];
    let used = memory.length;
    // A follow-up keeps everything but the answered asks themselves (the
    // newest side rows), which end the prompt. One answer or several (TM-57).
    const answers = answer ? [].concat(answer) : null;
    let earlier = said.slice(0, -1);
    if (answers) {
      let k = said.length;
      while (k && said[k - 1].side) k--;
      earlier = said.slice(0, k);
    }
    // Resuming its vendor session (TM-55): the session already holds the
    // header, the memory and everything up to `since`, and the agent's own
    // words; only what others said since then goes in.
    if (since !== null) earlier = earlier.filter(m => m.id > since && m.from !== memberId);
    if (!answer && last.relayOf) {
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

    const parts = since === null ? [header] : (brainUpdate ? [`[Notice: Central Brain or Persona Chip updated on disk:\n${brainUpdate.trim()}]`] : []);
    if (memory && since === null) parts.push(memory);
    if (history.length) parts.push((since === null ? 'Recent conversation:\n' : 'New in this chat since your last reply:\n') + history.join('\n\n'));
    if (answers && answers.length === 1) {
      parts.push(`The chat '${answers[0].chatTitle}' answered your question:\n${answers[0].text}\n\nFinish your reply to Matt.`);
    } else if (answers) {
      parts.push('The chats you asked answered:\n\n' + answers.map(a => `'${a.chatTitle}': ${a.text}`).join('\n\n') + '\n\nFinish your reply to Matt.');
    } else if (last.from === 'guest') {
      parts.push(`${speaker(last, names)} asks you:\n` + last.text);
    } else if (handoff && !fromMatt) {
      parts.push(`${names[last.from]} brought you in with this message:\n` + last.text);
    } else if (last.relayOf) {
      parts.push(`Matt passed you this reply from ${names[last.relayOf] || last.relayOf}. Respond to it:\n` + last.text);
    } else {
      parts.push("Matt's message to you:\n" + last.text);
    }
    return parts.join('\n\n');
  }

  // Which other chat text asks in the background: `#<chat title>`, matched
  // case-insensitively as a whole phrase; the longest title wins, so
  // "#Codex solo" beats a chat called "Codex". chats: [{ id, title }].
  function findChatMention(text, chats) {
    const [first] = findChatMentions(text, chats);
    return first ? { chatId: first.chatId } : null;
  }

  // Every other chat text asks (TM-57), in the order they appear, each once:
  // [{ chatId, start }]. Where two titles start at the same # ("#Codex solo 1"
  // and "#Codex solo"), the longest wins.
  function findChatMentions(text, chats) {
    const hits = [];
    for (const c of chats) {
      // One space after # is allowed: agents write markdown ("# Codex solo").
      const re = new RegExp(`(^|[^\\w#])(# ?${escapeRegExp(c.title)})(?![\\w-])`, 'gi');
      for (let h; (h = re.exec(text));) hits.push({ chatId: c.id, start: h.index + h[1].length, end: h.index + h[0].length });
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    for (const h of hits) {
      const prev = out[out.length - 1];
      if (prev && h.start < prev.end) continue;
      if (!out.some(o => o.chatId === h.chatId)) out.push(h);
    }
    return out.map(({ chatId, start }) => ({ chatId, start }));
  }

  // What to ask each chat: one # gets the whole text; with several, each chat
  // gets its own part, from its # to the next one. [{ chatId, question }]
  function splitChatAsks(text, chats) {
    const found = findChatMentions(text, chats);
    if (found.length < 2) return found.map(f => ({ chatId: f.chatId, question: text }));
    return found.map((f, i) => ({ chatId: f.chatId, question: text.slice(f.start, i + 1 < found.length ? found[i + 1].start : undefined).trim() }));
  }

  // Two chats as one new thread (TM-54 Batch 6): both chats' agents (each
  // keeps its name unless it clashes, then "<name> 2"), and both histories in
  // time order, renumbered, with every member and message reference remapped.
  // a and b are left as they were.
  function mergeThreads(a, b, vendorNames = VENDOR_NAMES) {
    const members = [];
    const memberMaps = [a, b].map(t => {
      const map = {};
      for (const m of t.members) {
        const fresh = newMember(members, { vendor: m.vendor, model: m.model, memory: m.memory || null, role: m.role || null },{ vendorNames: { ...vendorNames, [m.vendor]: m.name } });
        if (m.left) fresh.left = true;
        members.push(fresh);
        map[m.id] = fresh.id;
      }
      return map;
    });
    // Stable by time; on a tie, a's message first.
    const all = [a, b].flatMap((t, src) => t.messages.map((m, i) => ({ m, src, i })))
      .sort((x, y) => (x.m.ts < y.m.ts ? -1 : x.m.ts > y.m.ts ? 1 : x.src - y.src || x.i - y.i));
    const idMaps = [{}, {}];
    all.forEach(({ m, src }, n) => { idMaps[src][m.id] = n + 1; });
    const messages = all.map(({ m, src }, n) => {
      const who = (id) => (id in memberMaps[src] ? memberMaps[src][id] : id);
      const c = JSON.parse(JSON.stringify(m));
      c.id = n + 1;
      c.from = who(c.from);
      if (c.to) c.to = who(c.to);
      if (c.relayOf) c.relayOf = who(c.relayOf);
      if (c.threadOf) c.threadOf = idMaps[src][c.threadOf];
      if (c.handoff) c.handoff = { from: who(c.handoff.from), to: who(c.handoff.to) };
      if (c.side && c.side.asker !== 'matt') c.side.asker = who(c.side.asker);
      return c;
    });
    return { messages, nextId: messages.length + 1, members };
  }

  // A chat's title: Matt's first message, on one line and cut to 40 characters.
  function chatTitle(thread) {
    const first = thread.messages.find(m => m.from === 'matt');
    if (!first) return 'New chat';
    const line = first.text.replace(/\s+/g, ' ').trim();
    return line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1).trimEnd() + '…' : line;
  }

  return { VENDORS, HOP_LIMIT, hopLimit, createThread, addMessage, buildPrompt, chatTitle, findMention, findTarget, findChatMention, findChatMentions, splitChatAsks, routeMessage, memorySnapshot, hopsSinceMatt, mergeThreads };
});
