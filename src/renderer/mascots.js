// Mascot definitions and SVG pixel-art generators

const MASCOT_CONFIGS = {
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    baseColor: '#7b2cbf',
    accentColor: '#00f5d4',
    themeClass: 'theme-antigravity',
    defaultRole: 'lead',
    renderAvatar(role, status) {
      const isLead = role === 'lead';
      const isAlert = status === 'needs_input';
      const isWorking = status === 'working';
      const isSleeping = status === 'sleeping';

      return `
        <div class="mascot-sprite antigravity ${status} ${isLead ? 'is-lead' : ''}">
          ${isAlert ? `
            <div class="alert-bubble animate-bounce">
              <span class="alert-icon">!</span>
            </div>
          ` : ''}
          ${isSleeping ? `
            <div class="sleep-bubble animate-float">
              <span>z</span><span>Z</span><span>z</span>
            </div>
          ` : ''}
          <div class="avatar-svg-container">
            <svg viewBox="0 0 48 48" class="pixel-avatar" shape-rendering="crispEdges">
              ${isLead ? `
                <!-- Golden Lead Crown -->
                <polygon points="16,6 20,12 24,5 28,12 32,6 30,14 18,14" fill="#ffd166" stroke="#b08900" stroke-width="1"/>
                <circle cx="20" cy="7" r="1.5" fill="#ef476f"/>
                <circle cx="24" cy="6" r="1.5" fill="#00f5d4"/>
                <circle cx="28" cy="7" r="1.5" fill="#ef476f"/>
              ` : `
                <!-- Anti-Gravity Antenna -->
                <rect x="23" y="8" width="2" height="6" fill="#00f5d4"/>
                <circle cx="24" cy="7" r="2" fill="#9d4edd" class="glow-pulse"/>
              `}

              <!-- Helmet / Body -->
              <rect x="14" y="14" width="20" height="18" rx="4" fill="#3c096c" stroke="#5a189a" stroke-width="1.5"/>
              
              <!-- Visor -->
              <rect x="17" y="18" width="14" height="8" rx="2" fill="#10002b"/>
              <rect x="18" y="19" width="12" height="6" rx="1" fill="#00f5d4" opacity="0.9" class="${isWorking ? 'visor-active' : ''}"/>
              
              <!-- Visor Eyes / Reflection -->
              ${isSleeping ? `
                <!-- Sleeping eye slits -->
                <line x1="20" y1="22" x2="23" y2="22" stroke="#10002b" stroke-width="1.5"/>
                <line x1="25" y1="22" x2="28" y2="22" stroke="#10002b" stroke-width="1.5"/>
              ` : `
                <circle cx="21" cy="22" r="1.5" fill="#ffffff"/>
                <circle cx="27" cy="22" r="1.5" fill="#ffffff"/>
              `}

              <!-- Jetpack Thrusters / Floating Legs -->
              <rect x="17" y="32" width="4" height="6" fill="#5a189a"/>
              <rect x="27" y="32" width="4" height="6" fill="#5a189a"/>
              
              <!-- Thruster Flame / Aura -->
              <polygon points="17,38 19,44 21,38" fill="#00f5d4" opacity="0.8" class="flame-flicker"/>
              <polygon points="27,38 29,44 31,38" fill="#00f5d4" opacity="0.8" class="flame-flicker"/>
            </svg>
          </div>
        </div>
      `;
    }
  },

  claude: {
    id: 'claude',
    name: 'Claude Code',
    baseColor: '#e76f51',
    accentColor: '#f4a261',
    themeClass: 'theme-claude',
    defaultRole: 'architect',
    renderAvatar(role, status) {
      const isLead = role === 'lead';
      const isAlert = status === 'needs_input';
      const isWorking = status === 'working';
      const isSleeping = status === 'sleeping';

      return `
        <div class="mascot-sprite claude ${status} ${isLead ? 'is-lead' : ''}">
          ${isAlert ? `
            <div class="alert-bubble animate-bounce">
              <span class="alert-icon">!</span>
            </div>
          ` : ''}
          ${isSleeping ? `
            <div class="sleep-bubble animate-float">
              <span>z</span><span>Z</span><span>z</span>
            </div>
          ` : ''}
          <div class="avatar-svg-container">
            <svg viewBox="0 0 48 48" class="pixel-avatar" shape-rendering="crispEdges">
              ${isLead ? `
                <polygon points="16,6 20,12 24,5 28,12 32,6 30,14 18,14" fill="#ffd166" stroke="#b08900" stroke-width="1"/>
                <circle cx="20" cy="7" r="1.5" fill="#ef476f"/>
                <circle cx="24" cy="6" r="1.5" fill="#00f5d4"/>
                <circle cx="28" cy="7" r="1.5" fill="#ef476f"/>
              ` : `
                <!-- Claude Sunburst Star Antenna -->
                <polygon points="24,6 26,10 30,10 27,13 28,17 24,14 20,17 21,13 18,10 22,10" fill="#f4a261"/>
              `}

              <!-- Terracotta Chibi Head/Body -->
              <rect x="13" y="14" width="22" height="20" rx="4" fill="#d95d39" stroke="#9e2a2b" stroke-width="1.5"/>
              
              <!-- Soft Face Plate -->
              <rect x="16" y="17" width="16" height="13" rx="2" fill="#fceade"/>
              
              <!-- Eyes & Expression -->
              ${isSleeping ? `
                <line x1="18" y1="23" x2="22" y2="23" stroke="#9e2a2b" stroke-width="1.5"/>
                <line x1="26" y1="23" x2="30" y2="23" stroke="#9e2a2b" stroke-width="1.5"/>
              ` : `
                <circle cx="20" cy="22" r="2" fill="#33272a"/>
                <circle cx="28" cy="22" r="2" fill="#33272a"/>
                <circle cx="19" cy="21" r="0.7" fill="#ffffff"/>
                <circle cx="27" cy="21" r="0.7" fill="#ffffff"/>
                <path d="M22,27 Q24,29 26,27" stroke="#9e2a2b" stroke-width="1.2" fill="none"/>
              `}

              <!-- Cute Little Feet -->
              <rect x="16" y="34" width="6" height="4" rx="2" fill="#9e2a2b"/>
              <rect x="26" y="34" width="6" height="4" rx="2" fill="#9e2a2b"/>
            </svg>
          </div>
        </div>
      `;
    }
  },

  codex: {
    id: 'codex',
    name: 'Codex',
    baseColor: '#2a9d8f',
    accentColor: '#52b788',
    themeClass: 'theme-codex',
    defaultRole: 'tester',
    renderAvatar(role, status) {
      const isLead = role === 'lead';
      const isAlert = status === 'needs_input';
      const isWorking = status === 'working';
      const isSleeping = status === 'sleeping';

      return `
        <div class="mascot-sprite codex ${status} ${isLead ? 'is-lead' : ''}">
          ${isAlert ? `
            <div class="alert-bubble animate-bounce">
              <span class="alert-icon">!</span>
            </div>
          ` : ''}
          ${isSleeping ? `
            <div class="sleep-bubble animate-float">
              <span>z</span><span>Z</span><span>z</span>
            </div>
          ` : ''}
          <div class="avatar-svg-container">
            <svg viewBox="0 0 48 48" class="pixel-avatar" shape-rendering="crispEdges">
              ${isLead ? `
                <polygon points="16,6 20,12 24,5 28,12 32,6 30,14 18,14" fill="#ffd166" stroke="#b08900" stroke-width="1"/>
                <circle cx="20" cy="7" r="1.5" fill="#ef476f"/>
                <circle cx="24" cy="6" r="1.5" fill="#00f5d4"/>
                <circle cx="28" cy="7" r="1.5" fill="#ef476f"/>
              ` : `
                <!-- Retro Dual Antennae -->
                <line x1="18" y1="8" x2="20" y2="14" stroke="#52b788" stroke-width="2"/>
                <circle cx="17" cy="7" r="2" fill="#52b788"/>
                <line x1="30" y1="8" x2="28" y2="14" stroke="#52b788" stroke-width="2"/>
                <circle cx="31" cy="7" r="2" fill="#52b788"/>
              `}

              <!-- CRT Monitor Head -->
              <rect x="12" y="14" width="24" height="20" rx="3" fill="#1b4332" stroke="#2d6a4f" stroke-width="1.5"/>
              
              <!-- CRT Phosphor Screen -->
              <rect x="15" y="17" width="18" height="14" rx="2" fill="#081c15"/>
              
              <!-- Screen Face -->
              ${isSleeping ? `
                <text x="17" y="27" fill="#52b788" font-family="monospace" font-size="9" font-weight="bold">-.-</text>
              ` : isWorking ? `
                <text x="17" y="27" fill="#69ff94" font-family="monospace" font-size="9" font-weight="bold">&gt;_</text>
              ` : `
                <text x="18" y="27" fill="#52b788" font-family="monospace" font-size="9" font-weight="bold">^.^</text>
              `}

              <!-- Retro Computer Base / Stand -->
              <rect x="18" y="34" width="12" height="3" fill="#2d6a4f"/>
              <rect x="15" y="37" width="18" height="3" rx="1" fill="#1b4332"/>
            </svg>
          </div>
        </div>
      `;
    }
  },

  grok: {
    id: 'grok',
    name: 'Grok',
    baseColor: '#212529',
    accentColor: '#00f5d4',
    themeClass: 'theme-grok',
    defaultRole: 'reviewer',
    renderAvatar(role, status) {
      const isLead = role === 'lead';
      const isAlert = status === 'needs_input';
      const isWorking = status === 'working';
      const isSleeping = status === 'sleeping';

      return `
        <div class="mascot-sprite grok ${status} ${isLead ? 'is-lead' : ''}">
          ${isAlert ? `
            <div class="alert-bubble animate-bounce">
              <span class="alert-icon">!</span>
            </div>
          ` : ''}
          ${isSleeping ? `
            <div class="sleep-bubble animate-float">
              <span>z</span><span>Z</span><span>z</span>
            </div>
          ` : ''}
          <div class="avatar-svg-container">
            <svg viewBox="0 0 48 48" class="pixel-avatar" shape-rendering="crispEdges">
              ${isLead ? `
                <polygon points="16,6 20,12 24,5 28,12 32,6 30,14 18,14" fill="#ffd166" stroke="#b08900" stroke-width="1"/>
                <circle cx="20" cy="7" r="1.5" fill="#ef476f"/>
                <circle cx="24" cy="6" r="1.5" fill="#00f5d4"/>
                <circle cx="28" cy="7" r="1.5" fill="#ef476f"/>
              ` : `
                <!-- Cyber Angular Horns/Antennae -->
                <polygon points="16,8 20,14 18,14" fill="#00f5d4"/>
                <polygon points="32,8 28,14 30,14" fill="#00f5d4"/>
              `}

              <!-- Cyber Chassis Body -->
              <polygon points="14,15 34,15 32,34 16,34" fill="#121214" stroke="#343a40" stroke-width="1.5"/>
              
              <!-- Neon Visor -->
              <rect x="17" y="20" width="14" height="6" fill="#050505"/>
              ${isSleeping ? `
                <line x1="18" y1="23" x2="30" y2="23" stroke="#495057" stroke-width="1.5"/>
              ` : `
                <rect x="18" y="21" width="12" height="4" fill="#00f5d4" class="grok-visor-scan"/>
                <circle cx="24" cy="23" r="1.5" fill="#ffffff"/>
              `}

              <!-- Neon Chest Core -->
              <circle cx="24" cy="29" r="2" fill="${isWorking ? '#00f5d4' : '#495057'}" class="${isWorking ? 'core-pulse' : ''}"/>

              <!-- Cyber Feet -->
              <rect x="16" y="34" width="5" height="5" fill="#212529"/>
              <rect x="27" y="34" width="5" height="5" fill="#212529"/>
            </svg>
          </div>
        </div>
      `;
    }
  }
};

window.MASCOT_CONFIGS = MASCOT_CONFIGS;
