// The right-click menu (TM-54 Batch 1): spelling fixes for a misspelled word,
// Add to dictionary, and Cut/Copy/Paste in text fields. Returns a plain
// template; main.js turns each `action` into a click handler.

const MAX_SUGGESTIONS = 5;

function spellMenu({ misspelledWord = '', dictionarySuggestions = [], isEditable = false, selectionText = '' } = {}) {
  const items = [];
  if (misspelledWord) {
    const fixes = dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (fixes.length) items.push(...fixes.map(word => ({ label: word, action: { replace: word } })));
    else items.push({ label: 'No suggestions', enabled: false });
    items.push({ type: 'separator' }, { label: 'Add to dictionary', action: { addWord: misspelledWord } }, { type: 'separator' });
  }
  if (isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' });
  else if (selectionText) items.push({ role: 'copy' });
  return items.length ? items : null;
}

module.exports = { spellMenu };
