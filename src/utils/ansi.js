function parseAnsi(text) {
  if (!text) return '';

  // Strip OSC (Operating System Commands like title updates, colors) e.g. \x1b]0;...\x07
  let cleaned = text
    .replace(/\x1b\][0-9]+;[^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, ''); // cursor & private mode codes

  // Escape HTML characters
  let html = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const colorMap = {
    '30': '#4a4a4a',
    '31': '#ff5555',
    '32': '#50fa7b',
    '33': '#f1fa8c',
    '34': '#bd93f9',
    '35': '#ff79c6',
    '36': '#8be9fd',
    '37': '#f8f8f2',
    '90': '#6272a4',
    '91': '#ff6e6e',
    '92': '#69ff94',
    '93': '#ffffa5',
    '94': '#d6acff',
    '95': '#ff92df',
    '96': '#a4ffff',
    '97': '#ffffff'
  };

  html = html.replace(/\x1b\[([0-9;]+)m/g, (match, codes) => {
    const codeList = codes.split(';');
    let styles = [];

    for (const code of codeList) {
      if (code === '0') {
        return '</span>';
      } else if (code === '1') {
        styles.push('font-weight: bold;');
      } else if (code === '2') {
        styles.push('opacity: 0.7;');
      } else if (code === '4') {
        styles.push('text-decoration: underline;');
      } else if (colorMap[code]) {
        styles.push(`color: ${colorMap[code]};`);
      }
    }

    return `<span style="${styles.join(' ')}">`;
  });

  // Strip any remaining unhandled control sequences
  html = html.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

  return html;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAnsi };
}
