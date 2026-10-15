// Mission Control Orchestrator v1.1

// Any error in this window ends up in logs/latest.log (source: "renderer").
window.addEventListener('error', (e) => {
  window.api.log('error', e.message, { file: e.filename, line: e.lineno, stack: e.error && e.error.stack });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {};
  window.api.log('error', r.message || String(e.reason), { stack: r.stack, phase: 'unhandledrejection' });
});

document.addEventListener('DOMContentLoaded', async () => {
  // State
  let agents = {};
  let currentActiveTab = 'antigravity';
  const cardSignatures = {}; // last-rendered state per card, see renderStage()
  let logs = {
    antigravity: '<span style="color: #6272a4;">[Antigravity Terminal Ready - Type any prompt below to run]</span>\r\n',
    claude: '<span style="color: #6272a4;">[Claude Code Terminal Ready - Type any prompt below to run]</span>\r\n',
    codex: '<span style="color: #6272a4;">[Codex Terminal Ready - Type any prompt below to run]</span>\r\n',
    grok: '<span style="color: #6272a4;">[Grok Terminal Ready - Type any prompt below to run]</span>\r\n',
    team: '<span style="color: #ffd166;">[Team Radio Online - Type instructions here to dispatch to your Team Lead]</span>\r\n'
  };

  // DOM Elements
  const agentsGrid = document.getElementById('agentsGrid');
  const terminalTabs = document.getElementById('terminalTabs');
  const terminalOutput = document.getElementById('terminalOutput');
  const terminalInput = document.getElementById('terminalInput');
  const sendBtn = document.getElementById('sendBtn');
  const inputPromptLabel = document.getElementById('inputPromptLabel');
  const startAgentBtn = document.getElementById('startAgentBtn');
  const stopAgentBtn = document.getElementById('stopAgentBtn');
  const promoteBtn = document.getElementById('promoteBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const soundToggleBtn = document.getElementById('soundToggleBtn');
  const soundIcon = document.getElementById('soundIcon');
  const soundText = document.getElementById('soundText');
  const demoAlertBtn = document.getElementById('demoAlertBtn');
  const manageRolesBtn = document.getElementById('manageRolesBtn');
  const scanAgentsBtn = document.getElementById('scanAgentsBtn');
  const openLogsBtn = document.getElementById('openLogsBtn');
  const roleModal = document.getElementById('roleModal');
  const roleModalBody = document.getElementById('roleModalBody');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const saveRolesBtn = document.getElementById('saveRolesBtn');
  const diagnosticsModal = document.getElementById('diagnosticsModal');
  const diagnosticsList = document.getElementById('diagnosticsList');
  const closeDiagBtn = document.getElementById('closeDiagBtn');
  const refreshDiagBtn = document.getElementById('refreshDiagBtn');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const workingDirInput = document.getElementById('workingDirInput');
  const pickWorkingDirBtn = document.getElementById('pickWorkingDirBtn');
  const configFileLabel = document.getElementById('configFileLabel');
  const stageSummary = document.getElementById('stageSummary');
  const summonAllBtn = document.getElementById('summonAllBtn');
  const sleepAllBtn = document.getElementById('sleepAllBtn');

  // Load configs & initial agent scan
  async function refreshAgents() {
    try {
      const scanned = await window.api.scanAgents();
      scanned.forEach(cfg => {
        agents[cfg.id] = { ...agents[cfg.id], ...cfg };
      });
    } catch (_) {
      try {
        const configs = await window.api.getAgentConfigs();
        configs.forEach(cfg => {
          agents[cfg.id] = { ...agents[cfg.id], ...cfg };
        });
      } catch (e) {
        // Fallback defaults
        agents = {
          antigravity: { id: 'antigravity', name: 'Antigravity', title: 'Team Lead & Orchestrator', role: 'lead', status: 'sleeping', version: '1.2.6' },
          claude: { id: 'claude', name: 'Claude Code', title: 'Code Architect & Builder', role: 'architect', status: 'sleeping', version: '2.1.276' },
          codex: { id: 'codex', name: 'Codex', title: 'QA & Logic Engineer', role: 'tester', status: 'sleeping', version: '0.155.0' },
          grok: { id: 'grok', name: 'Grok', title: 'Sentry & Code Reviewer', role: 'reviewer', status: 'sleeping', version: '1.0.34' }
        };
      }
    }
    renderStage();
  }

  await refreshAgents();

  // Audio state
  updateSoundUI();
  soundToggleBtn.addEventListener('click', () => {
    const isMuted = window.soundFX.toggleMute();
    updateSoundUI();
    if (!isMuted) window.soundFX.playBlip();
  });

  function updateSoundUI() {
    const isMuted = window.soundFX.muted;
    soundIcon.textContent = isMuted ? '🔇' : '🔊';
    soundText.textContent = isMuted ? 'Muted' : 'Sound';
    soundToggleBtn.style.color = isMuted ? 'var(--text-dim)' : 'var(--color-lead)';
  }

  // Render Agent Cards on Stage.
  //
  // Cards are created once and kept. A card's contents are only rebuilt when
  // something about that agent changed (its "signature"); otherwise the DOM is
  // left alone so the sprite animations keep running smoothly.
  function renderStage() {
    let workingCount = 0;
    let alertCount = 0;
    let linkedCount = 0;

    Object.values(agents).forEach(agent => {
      const isWorking = agent.status === 'working';
      const isAlert = agent.status === 'needs_input';
      const isLinked = !!agent.externalPid;

      if (isWorking) workingCount++;
      if (isAlert) alertCount++;
      if (isLinked) linkedCount++;

      let card = document.getElementById(`card-${agent.id}`);
      if (!card) {
        card = document.createElement('div');
        card.id = `card-${agent.id}`;
        card.className = 'agent-card';
        card.addEventListener('click', () => {
          selectAgent(agent.id);
          window.soundFX.playBlip();
        });
        agentsGrid.appendChild(card);
      }

      card.classList.toggle('selected', agent.id === currentActiveTab);
      card.classList.toggle('alert', isAlert);

      const sessions = agent.hookSessions || 0;
      const signature = [agent.role, agent.status, agent.externalPid, sessions, agent.version, agent.title, agent.name].join('|');
      if (cardSignatures[agent.id] === signature) return;
      cardSignatures[agent.id] = signature;

      const config = window.MASCOT_CONFIGS[agent.id] || window.MASCOT_CONFIGS.antigravity;
      const roleName = agent.role === 'lead' ? '👑 LEAD' :
                       agent.role === 'architect' ? '📐 ARCHITECT' :
                       agent.role === 'tester' ? '🧪 QA/TEST' : '🛡️ SENTRY';

      const sessionLabel = sessions > 1 ? ` ×${sessions}` : '';
      let statusText = 'SLEEPING';
      if (isAlert) statusText = `NEEDS YOU (!)${sessionLabel}`;
      else if (isWorking && sessions) statusText = `WORKING${sessionLabel}`;
      else if (isLinked) statusText = `ACTIVE (PID: ${agent.externalPid})`;
      else if (isWorking) statusText = 'WORKING';
      else if (agent.status === 'idle') statusText = sessions ? `READY FOR YOU${sessionLabel}` : 'IDLE';

      card.innerHTML = `
        <div class="agent-card-top">
          <span class="role-badge ${agent.role}">${roleName}</span>
          <span class="status-tag ${agent.status}">
            <span class="status-dot"></span>
            <span>${escapeHtml(statusText)}</span>
          </span>
        </div>
        
        <div class="mascot-diorama">
          ${config.renderAvatar(agent.role, agent.status)}
          <div class="desk-surface"></div>
          <div class="desk-laptop"></div>
          <div class="desk-mug"></div>
        </div>

        <div class="agent-card-bottom">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <span class="agent-name">${escapeHtml(agent.name)}</span>
            <span style="font-size: 9px; color: var(--text-dim);">${escapeHtml(agent.version || '')}</span>
          </div>
          <span class="agent-title" title="${escapeAttr(agent.title)}">${escapeHtml(agent.title)}</span>
        </div>
      `;
    });

    // Update summary in header
    if (alertCount > 0) {
      stageSummary.innerHTML = `<span style="color: var(--alert-yellow); font-weight: bold;">🚨 ${alertCount} Agent${alertCount > 1 ? 's' : ''} Need Review</span>`;
    } else if (linkedCount > 0) {
      stageSummary.innerHTML = `<span style="color: var(--color-grok); font-weight: bold;">🔗 ${linkedCount} Linked Terminal${linkedCount > 1 ? 's' : ''} Active</span>`;
    } else if (workingCount > 0) {
      stageSummary.innerHTML = `<span style="color: var(--success-green);">⚡ ${workingCount} Agent${workingCount > 1 ? 's' : ''} Coding</span>`;
    } else {
      stageSummary.innerHTML = `<span>${Object.keys(agents).length} Agents Ready</span>`;
    }
  }

  // Select Agent & Switch Tab
  function selectAgent(agentId) {
    currentActiveTab = agentId;

    document.querySelectorAll('.agent-card').forEach(c => {
      c.classList.toggle('selected', c.id === `card-${agentId}`);
    });

    document.querySelectorAll('.terminal-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.agent === agentId);
    });

    if (agentId === 'team') {
      inputPromptLabel.textContent = 'RADIO >';
      inputPromptLabel.style.color = 'var(--color-lead)';
      terminalInput.placeholder = 'Broadcast task/goal to your Team Lead...';
      startAgentBtn.style.display = 'none';
      stopAgentBtn.style.display = 'none';
      promoteBtn.style.display = 'none';
      forwardBtn.style.display = 'none';
    } else {
      const agent = agents[agentId] || {};
      inputPromptLabel.textContent = `${(agent.name || agentId).toUpperCase()} >`;
      inputPromptLabel.style.color = agent.accent || 'var(--color-grok)';
      
      if (agent.externalPid) {
        terminalInput.placeholder = `Connected to external terminal PID ${agent.externalPid} (type to run in Mission Control)...`;
      } else if (agent.status === 'needs_input') {
        terminalInput.placeholder = `Respond to ${agent.name}'s prompt...`;
      } else {
        terminalInput.placeholder = `Type prompt or instruction for ${agent.name} (Enter to send)...`;
      }

      startAgentBtn.style.display = 'flex';
      stopAgentBtn.style.display = 'flex';
      promoteBtn.style.display = 'flex';
      forwardBtn.style.display = 'flex';

      startAgentBtn.textContent = agent.status === 'working' ? '⚡ Restart' : '▶ Start';
    }

    renderTerminalOutput();
    terminalInput.focus();
  }

  function renderTerminalOutput() {
    terminalOutput.innerHTML = logs[currentActiveTab] || '';
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  // `isHtml` marks text that is already safe HTML (e.g. converted by the main
  // process); it is never re-parsed, since parseAnsi escapes HTML and running it
  // twice would corrupt entities and tags.
  function appendLog(agentId, htmlOrText, { isHtml = false } = {}) {
    if (!logs[agentId]) logs[agentId] = '';

    // Parse ANSI codes if any exist in the incoming string
    let html = htmlOrText;
    if (!isHtml && typeof html === 'string' && html.includes('\x1b[')) {
      html = parseAnsi(html);
    }

    logs[agentId] += html;

    if (currentActiveTab === agentId) {
      terminalOutput.insertAdjacentHTML('beforeend', html);
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }
  }

  // Tab click listeners
  terminalTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.terminal-tab');
    if (tab && tab.dataset.agent) {
      selectAgent(tab.dataset.agent);
      window.soundFX.playBlip();
    }
  });

  // Sending Input (Auto-launches agent if not already running!)
  async function submitInput(customText) {
    const text = customText !== undefined ? customText : terminalInput.value.trim();
    if (!text && customText === undefined) return;

    if (currentActiveTab === 'team') {
      appendLog('team', `\r\n<div style="margin: 4px 0;"><span style="color: #ffd166; font-weight: bold;">[Commander Broadcast]:</span> ${escapeHtml(text)}</div>`);
      terminalInput.value = '';
      window.soundFX.playWakeup();

      const leadAgent = Object.values(agents).find(a => a.role === 'lead') || agents.antigravity;
      if (leadAgent) {
        appendLog('team', `<div style="color: #00f5d4; margin: 4px 0;">👑 <strong>${leadAgent.name} (Team Lead)</strong>: "Mission acknowledged! Dispatching and working on it..."</div>`);
        appendLog(leadAgent.id, `<div style="color: #f1fa8c; margin: 4px 0;"><strong>[Dispatched from Team Radio]:</strong> ${escapeHtml(text)}</div>\r\n`);
        await window.api.sendInput(leadAgent.id, text);
        leadAgent.status = 'working';
        renderStage();
      }
      return;
    }

    const agent = agents[currentActiveTab];
    if (!agent) return;

    // Send to agent process
    appendLog(currentActiveTab, `<div style="color: #8be9fd; margin: 4px 0;"><strong>&gt; ${escapeHtml(text)}</strong></div>\r\n`);
    await window.api.sendInput(currentActiveTab, text);
    
    if (agent.status === 'needs_input') {
      agent.status = 'working';
      updateTabAlertBadge(currentActiveTab, false);
    } else {
      agent.status = 'working';
    }
    renderStage();

    terminalInput.value = '';
    window.soundFX.playBlip();
  }

  sendBtn.addEventListener('click', () => submitInput());
  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitInput();
    }
  });

  // Quick Reply Chips
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reply = btn.dataset.reply;
      submitInput(reply);
    });
  });

  // Start / Stop Agent
  startAgentBtn.addEventListener('click', async () => {
    if (currentActiveTab === 'team') return;
    window.soundFX.playWakeup();
    appendLog(currentActiveTab, `<span style="color: #50fa7b;">[Summoning ${agents[currentActiveTab].name}...]</span>\r\n`);
    await window.api.startAgent(currentActiveTab);
  });

  stopAgentBtn.addEventListener('click', async () => {
    if (currentActiveTab === 'team') return;
    await window.api.stopAgent(currentActiveTab);
    appendLog(currentActiveTab, `<span style="color: #ff5555;">[${agents[currentActiveTab].name} stopped]</span>\r\n`);
  });

  // Promote to Team Lead
  promoteBtn.addEventListener('click', async () => {
    if (currentActiveTab === 'team') return;
    const agent = agents[currentActiveTab];
    await window.api.updateAgentRole(currentActiveTab, 'lead', `${agent.name} (Team Lead)`);
    await refreshAgents();
    window.soundFX.playSuccess();
    appendLog('team', `<div style="color: #ffd166; font-weight: bold; margin: 4px 0;">👑 PROMOTION: ${agent.name} is now the Team Lead & Orchestrator!</div>`);
  });

  // Forward Output to another agent
  forwardBtn.addEventListener('click', async () => {
    if (currentActiveTab === 'team') return;
    const targetAgentId = currentActiveTab === 'antigravity' ? 'claude' : 'antigravity';
    const sampleContext = `Forwarded from ${agents[currentActiveTab].name}: Review recent output and proceed.`;
    await window.api.forwardToAgent(currentActiveTab, targetAgentId, sampleContext);
    window.soundFX.playBlip();
    selectAgent(targetAgentId);
  });

  // Summon All
  summonAllBtn.addEventListener('click', async () => {
    window.soundFX.playWakeup();
    appendLog('team', `<div style="color: #50fa7b; font-weight: bold; margin: 6px 0;">▶ Summoning full team! Pinging all CLI agents...</div>`);
    
    for (const id of Object.keys(agents)) {
      agents[id].status = 'working';
      appendLog(id, `\r\n\x1b[32m[${agents[id].name} awakened and listening. Ready for prompts]\x1b[0m\r\n`);
    }
    renderStage();
  });

  sleepAllBtn.addEventListener('click', () => {
    Object.keys(agents).forEach(id => {
      agents[id].status = 'sleeping';
      updateTabAlertBadge(id, false);
      window.api.stopAgent(id);
    });
    renderStage();
    appendLog('team', `<div style="color: #6272a4;">💤 All agents are now resting.</div>`);
  });

  // Demo Alert
  demoAlertBtn.addEventListener('click', () => {
    const targetId = currentActiveTab === 'team' ? 'antigravity' : currentActiveTab;
    const agent = agents[targetId];

    agent.status = 'needs_input';
    window.soundFX.playAlert();
    updateTabAlertBadge(targetId, true);
    renderStage();

    appendLog(targetId, `\r\n\x1b[33m? [DEMO ALERT] ${agent.name} needs your decision: Approve architecture plan for v2? (y/n): \x1b[0m`);
    appendLog('team', `<div style="color: #ffd166; font-weight: bold;">🚨 [ALERT] ${agent.name} stands at attention and needs your response!</div>`);
    selectAgent(targetId);
  });

  function updateTabAlertBadge(agentId, show) {
    const badge = document.getElementById(`badge-${agentId}`);
    if (badge) {
      badge.classList.toggle('hidden', !show);
    }
  }

  // Open the folder that holds logs/latest.log
  openLogsBtn.addEventListener('click', async () => {
    window.soundFX.playBlip();
    const result = await window.api.openLogsFolder();
    if (result && result.error) {
      appendLog('team', `<div style="color: #ff5555;">Could not open logs folder (${escapeHtml(result.path)}): ${escapeHtml(result.error)}</div>`);
    } else if (result) {
      appendLog('team', `<div style="color: #6272a4;">📄 Logs folder: ${escapeHtml(result.path)}</div>`);
    }
  });

  // Diagnostics Modal
  scanAgentsBtn.addEventListener('click', async () => {
    await showDiagnostics();
  });

  refreshDiagBtn.addEventListener('click', async () => {
    refreshDiagBtn.textContent = 'Scanning...';
    await showDiagnostics();
    refreshDiagBtn.textContent = '🔄 Re-scan System';
    window.soundFX.playSuccess();
  });

  closeDiagBtn.addEventListener('click', () => {
    diagnosticsModal.classList.add('hidden');
  });

  async function showDiagnostics() {
    diagnosticsModal.classList.remove('hidden');
    diagnosticsList.innerHTML = '<div style="color: var(--text-dim);">Scanning Windows processes and executables...</div>';
    
    const [results, hooks, cfg] = await Promise.all([
      window.api.scanAgents(),
      window.api.getHookStatus().catch(err => ({ listening: false, error: err.message, agents: {} })),
      window.api.getConfig().catch(err => ({ file: '?', config: { workingDir: '', agents: {} }, error: err.message }))
    ]);
    diagnosticsList.innerHTML = '';
    workingDirInput.value = cfg.config.workingDir || '';
    configFileLabel.textContent = `Settings file: ${cfg.file}`;

    results.forEach(res => {
      const item = document.createElement('div');
      item.className = 'role-row';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'flex-start';
      item.style.gap = '4px';

      const isLinked = !!res.externalPid;
      const statusBadge = isLinked 
        ? `<span style="background: rgba(0,245,212,0.2); color: #00f5d4; padding: 2px 6px; border-radius: 3px; font-size: 10px;">🔗 Active Terminal PID: ${escapeHtml(res.externalPid)}</span>`
        : res.installed 
          ? `<span style="background: rgba(6,214,160,0.2); color: #06d6a0; padding: 2px 6px; border-radius: 3px; font-size: 10px;">✔ Installed</span>`
          : `<span style="background: rgba(239,71,111,0.2); color: #ef476f; padding: 2px 6px; border-radius: 3px; font-size: 10px;">✕ Not Found</span>`;

      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
          <strong style="color: #fff; font-size: 13px;">${escapeHtml(res.name)}</strong>
          ${statusBadge}
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">
          <span>Version: <strong>${escapeHtml(res.version)}</strong></span> |
          <span>Role: <strong>${escapeHtml(res.role.toUpperCase())}</strong></span>
        </div>
        <div style="display: flex; gap: 6px; align-items: center; width: 100%;">
          <span style="font-size: 10px; color: var(--text-dim);">Path:</span>
          <input type="text" class="terminal-input agent-path-input" data-agent="${escapeAttr(res.id)}" value="${escapeAttr(res.path)}" spellcheck="false" style="flex: 1; font-size: 10px; padding: 2px 6px;">
          <button class="send-btn agent-path-browse" data-agent="${escapeAttr(res.id)}" style="padding: 2px 8px; font-size: 10px;">Browse…</button>
        </div>
      `;

      item.querySelector('.agent-path-browse').addEventListener('click', async () => {
        const input = item.querySelector('.agent-path-input');
        const picked = await window.api.pickFile(input.value, `Choose the ${res.name} executable`);
        if (picked) input.value = picked;
      });

      if (hooks.agents && hooks.agents[res.id]) {
        item.appendChild(renderHookRow(res, hooks));
      }

      diagnosticsList.appendChild(item);
    });
  }

  pickWorkingDirBtn.addEventListener('click', async () => {
    const picked = await window.api.pickFolder(workingDirInput.value);
    if (picked) workingDirInput.value = picked;
  });

  saveConfigBtn.addEventListener('click', async () => {
    const agentsCfg = {};
    diagnosticsList.querySelectorAll('.agent-path-input').forEach(input => {
      agentsCfg[input.dataset.agent] = { path: input.value };
    });
    saveConfigBtn.disabled = true;
    try {
      await window.api.saveConfig({ workingDir: workingDirInput.value, agents: agentsCfg });
      window.soundFX.playSuccess();
      appendLog('team', `<div style="color: #ffd166;">💾 Settings saved. Agents will now work in: ${escapeHtml(workingDirInput.value)}</div>`);
      await refreshAgents();
      await showDiagnostics();
    } catch (err) {
      appendLog('team', `<div style="color: #ff5555;">Could not save settings: ${escapeHtml(err.message)}</div>`);
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  // "Connect" installs a tiny hook into the agent's own settings so it reports
  // its activity straight to this app. "Disconnect" removes it again.
  function renderHookRow(res, hooks) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 4px; gap: 8px;';

    const info = hooks.agents[res.id] || {};
    const detail = res.id === 'codex'
      ? 'Codex reports when it finishes a turn'
      : `${res.name} reports to this app (${(info.events || []).length} events)`;
    let text;
    if (!hooks.listening) {
      text = `<span style="color: #ef476f;">⚠ Hook listener offline${hooks.error ? ': ' + escapeHtml(hooks.error) : ''}</span>`;
    } else if (info.error) {
      text = `<span style="color: #ef476f;">⚠ Can't read ${escapeHtml(info.file)}: ${escapeHtml(info.error)}</span>`;
    } else if (info.conflict) {
      text = `<span style="color: #ffd166;">⚠ ${escapeHtml(res.name)} already has a notify command</span> <span style="color: var(--text-dim);">— remove it from ${escapeHtml(info.file)} to connect</span>`;
    } else if (info.installed) {
      text = `<span style="color: #06d6a0;">🪝 Hooks connected</span> <span style="color: var(--text-dim);">— ${detail}</span>`;
    } else {
      text = `<span style="color: var(--text-muted);">🪝 Hooks not connected</span> <span style="color: var(--text-dim);">— the bot only sees sessions launched from here</span>`;
    }

    const label = document.createElement('span');
    label.style.fontSize = '11px';
    label.innerHTML = text;
    row.appendChild(label);

    if (hooks.listening && !info.error && !info.conflict) {
      const btn = document.createElement('button');
      btn.className = 'send-btn';
      btn.style.cssText = 'padding: 3px 10px; font-size: 10px; white-space: nowrap;';
      btn.textContent = info.installed ? 'Disconnect' : `Connect ${res.name}`;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const updated = info.installed
            ? await window.api.uninstallHooks(res.id)
            : await window.api.installHooks(res.id);
          const now = updated.agents[res.id];
          window.soundFX.playSuccess();
          appendLog('team', `<div style="color: #ffd166;">🪝 ${escapeHtml(res.name)} hooks ${now.installed ? 'connected' : 'disconnected'} (${escapeHtml(now.file)}). Restart any open ${escapeHtml(res.name)} sessions to pick this up.</div>`);
          await showDiagnostics();
        } catch (err) {
          btn.disabled = false;
          appendLog('team', `<div style="color: #ff5555;">Could not update hooks: ${escapeHtml(err.message)}</div>`);
        }
      });
      row.appendChild(btn);
    }
    return row;
  }

  // Manage Roles Modal
  manageRolesBtn.addEventListener('click', () => {
    renderRolesModal();
    roleModal.classList.remove('hidden');
    window.soundFX.playBlip();
  });

  closeModalBtn.addEventListener('click', () => {
    roleModal.classList.add('hidden');
  });

  function renderRolesModal() {
    roleModalBody.innerHTML = '';
    const rolesList = [
      { key: 'lead', label: '👑 Team Lead / Orchestrator' },
      { key: 'architect', label: '📐 Code Architect & Builder' },
      { key: 'tester', label: '🧪 QA, Logic & Testing' },
      { key: 'reviewer', label: '🛡️ Sentry & Code Reviewer' }
    ];

    Object.values(agents).forEach(agent => {
      const row = document.createElement('div');
      row.className = 'role-row';
      row.innerHTML = `
        <span class="role-row-agent">${escapeHtml(agent.name)}</span>
        <select class="role-select" data-agent="${escapeAttr(agent.id)}">
          ${rolesList.map(r => `
            <option value="${r.key}" ${agent.role === r.key ? 'selected' : ''}>${r.label}</option>
          `).join('')}
        </select>
      `;
      roleModalBody.appendChild(row);
    });
  }

  saveRolesBtn.addEventListener('click', async () => {
    const selects = roleModalBody.querySelectorAll('.role-select');
    for (const sel of selects) {
      const agentId = sel.dataset.agent;
      const newRole = sel.value;
      const roleTitles = {
        lead: 'Team Lead & Orchestrator',
        architect: 'Code Architect & Builder',
        tester: 'QA & Logic Engineer',
        reviewer: 'Sentry & Code Reviewer'
      };
      await window.api.updateAgentRole(agentId, newRole, `${agents[agentId].name} (${roleTitles[newRole]})`);
    }
    await refreshAgents();
    roleModal.classList.add('hidden');
    window.soundFX.playSuccess();
    renderStage();
  });

  // Real-time IPC Event Handlers
  window.api.onAgentOutput((data) => {
    appendLog(data.agentId, data.html || escapeHtml(data.raw), { isHtml: true });
  });

  window.api.onAgentStatus((data) => {
    if (agents[data.agentId]) {
      agents[data.agentId].status = data.status;
      if (data.role) agents[data.agentId].role = data.role;
      if (data.title) agents[data.agentId].title = data.title;
      if (data.externalPid !== undefined) agents[data.agentId].externalPid = data.externalPid;
      if (data.hookSessions !== undefined) agents[data.agentId].hookSessions = data.hookSessions;
      
      updateTabAlertBadge(data.agentId, data.status === 'needs_input');
      renderStage();

      if (data.status === 'needs_input') {
        window.soundFX.playAlert();
      }
    }
  });

  window.api.onAgentPrompt((data) => {
    window.soundFX.playAlert();
    updateTabAlertBadge(data.agentId, true);
    if (agents[data.agentId]) {
      agents[data.agentId].status = 'needs_input';
      renderStage();
    }
  });

  window.api.onTeamMessage((msg) => {
    const color = msg.type === 'alert' ? '#ffd166' :
                  msg.type === 'forward' ? '#00f5d4' :
                  msg.type === 'start' ? '#50fa7b' : '#8c96b5';

    appendLog('team', `
      <div style="margin: 3px 0;">
        <span style="color: #5c6585;">[${msg.timestamp}]</span>
        <span style="color: ${color}; font-weight: bold;">[${msg.agentName || 'System'}]:</span>
        <span>${escapeHtml(msg.text)}</span>
      </div>
    `);
  });

  // Window Controls
  document.getElementById('winMinBtn').addEventListener('click', () => window.api.minimizeWindow());
  document.getElementById('winMaxBtn').addEventListener('click', () => window.api.maximizeWindow());
  document.getElementById('winCloseBtn').addEventListener('click', () => window.api.closeWindow());

  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  renderStage();
  selectAgent('antigravity');
});
