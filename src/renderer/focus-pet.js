// Focus mode, in-Daycare editor, Open in Antigravity, pet mode, and agent
// kick-out (hackathon). Loaded after app.js and uses its chat state, so the
// big app file stays untouched. `finishReply` and `previewFromText` are
// wrapped: the originals run first, then this file reacts to the reply that
// was just posted (pet relay, `kick @Name`).
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const { findKick, findThreadSignal } = window.ChatThread;

  let fpFile = null; // chat-folder file currently in Preview
  let fpPet = null; // { chatId, memberId } the pet window is talking to
  let fpQueued = null; // one pet message waiting for the agent to be free

  // A non-file preview (Notion glance, dev server) disarms Edit/IDE.
  const origShowPreview = showPreview;
  showPreview = function (opts) {
    if (!opts || opts.type === 'notion' || !opts.url || !String(opts.url).startsWith('file:')) fpFile = null;
    return origShowPreview(opts);
  };

  // Remember which chat-folder file Preview is showing (a localhost preview
  // is not a file).
  const origPreviewFromText = previewFromText;
  previewFromText = function (text) {
    const out = origPreviewFromText(text);
    const host = /(https?:\/\/localhost:\d+[^\s]*)/i.exec(text || '');
    const file = /([a-zA-Z0-9_\-\/]+\.html)/i.exec(text || '');
    fpFile = !host && file ? file[1] : null;
    return out;
  };

  // After a reply lands: send it to the pet if it is the pet's agent, and
  // honour a `kick @Name` line in it (never the chat owner, never itself).
  const origFinishReply = finishReply;
  finishReply = function (runKey, code, why, opts) {
    const cut = String(runKey).lastIndexOf('/');
    const chatId = String(runKey).slice(0, cut);
    const memberId = String(runKey).slice(cut + 1);
    const chat = chats.get(chatId);
    const before = chat && chat.thread ? chat.thread.messages.length : 0;
    const out = origFinishReply(runKey, code, why, opts);
    try {
      const c = chats.get(chatId);
      if (!c || !c.thread) return out;
      const fresh = c.thread.messages.slice(before);
      const replyMsg = [...fresh].reverse().find((m) => m.from === memberId);
      if (!replyMsg) return out;
      if (fpPet && fpPet.chatId === chatId && fpPet.memberId === memberId) {
        api.petReply({ text: replyMsg.text });
      }
      const kick = findKick(replyMsg.text, memberId, c.thread.members);
      if (kick) {
        const target = memberById(c.thread, kick.memberId);
        const kicker = memberById(c.thread, memberId);
        if (target && target !== c.thread.members[0] && !target.left) {
          const key = runKeyOf(chatId, target.id);
          if (pending[key]) stopRun(key);
          target.left = true;
          post(chatId, {
            from: 'system',
            threadOf: replyMsg.threadOf || null,
            text: `${kicker ? kicker.name : 'An agent'} removed ${target.name} from this chat. Type @${target.name} to bring them back.`
          });
          api.log('info', 'agent removed by agent', { chatId, by: memberId, removed: target.id });
          if (chatId === currentId) renderMembers();
        }
      }
      const threadSig = !replyMsg.threadOf ? findThreadSignal(replyMsg.text, memberId, c.thread.members) : null;
      if (threadSig) {
        const tTarget = memberById(c.thread, threadSig.memberId);
        const tKicker = memberById(c.thread, memberId);
        if (tTarget && !tTarget.left && !pending[runKeyOf(chatId, threadSig.memberId)]) {
          post(chatId, {
            from: 'system',
            threadOf: null,
            text: `${tKicker ? tKicker.name : 'An agent'} started a thread with ${tTarget.name} on that reply. It continues under the reply (Thread button).`
          });
          ask(chatId, threadSig.memberId, replyMsg.id);
        }
      }
      if (fpQueued && fpPet && fpPet.chatId === chatId && fpPet.memberId === memberId && !pending[runKeyOf(chatId, memberId)]) {
        const queued = fpQueued;
        fpQueued = null;
        post(chatId, { from: 'matt', to: memberId, text: queued });
        ask(chatId, memberId, null);
      }
    } catch (err) {
      api.log('warn', 'focus-pet reply hook failed', { error: err.message });
    }
    return out;
  };

  const focusBtn = $('preview-focus');
  if (focusBtn) focusBtn.addEventListener('click', () => {
    const sidecar = $('sidecar');
    if (sidecar) { sidecar.style.width = ''; sidecar.classList.toggle('focused'); }
  });

  const editBtn = $('preview-edit');
  if (editBtn) editBtn.addEventListener('click', async () => {
    if (!fpFile || !currentId) return;
    try {
      $('file-editor-text').value = await api.readChatFile(currentId, fpFile);
      $('file-editor-name').textContent = fpFile;
      $('file-editor').hidden = false;
      $('preview-iframe').hidden = true;
      $('preview-empty').hidden = true;
    } catch (err) { api.log('warn', 'editor could not open the file', { error: err.message }); }
  });

  const closeBtn = $('file-editor-close');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    $('file-editor').hidden = true;
    const frame = $('preview-iframe');
    if (frame && currentPreviewUrl) { frame.hidden = false; frame.src = currentPreviewUrl; }
  });

  const saveBtn = $('file-editor-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    if (!fpFile || !currentId) return;
    try {
      await api.saveChatFile(currentId, fpFile, $('file-editor-text').value);
      saveBtn.textContent = 'Saved';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200);
      const frame = $('preview-iframe');
      if (frame && currentPreviewUrl) frame.src = currentPreviewUrl;
    } catch (err) { api.log('warn', 'editor could not save the file', { error: err.message }); }
  });

  const ideBtn = $('preview-ide');
  if (ideBtn) ideBtn.addEventListener('click', async () => {
    if (!fpFile || !currentId) return;
    const out = await api.openInIde(currentId, fpFile).catch((err) => ({ ok: false, reason: err.message }));
    if (!out.ok) $('preview-title').textContent = `Antigravity: ${out.reason}`;
  });

  const petBtn = $('pet-btn');
  if (petBtn) petBtn.addEventListener('click', () => {
    const c = current();
    if (!c || !c.thread || !c.thread.members.length) return;
    const owner = c.thread.members[0];
    fpPet = { chatId: c.id, memberId: owner.id };
    api.openPet(owner.name);
  });

  api.onPetIncoming(({ text }) => {
    if (!fpPet || !text || !chats.get(fpPet.chatId)) return;
    if (pending[runKeyOf(fpPet.chatId, fpPet.memberId)]) {
      fpQueued = text;
      api.petReply({ text: 'Still working on the last one - I have queued that and will answer it next.' });
      return;
    }
    post(fpPet.chatId, { from: 'matt', to: fpPet.memberId, text });
    ask(fpPet.chatId, fpPet.memberId, null);
  });
})();
