const test = require('node:test');
const assert = require('node:assert/strict');
const { spellMenu } = require('../src/spellcheck');

test('suggestions come first, then Add to dictionary', () => {
  const menu = spellMenu({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tel', 'toe'], isEditable: true });
  assert.deepEqual(menu.slice(0, 5).map(i => i.label), ['the', 'tea', 'ten', 'tech', 'tel']);
  assert.deepEqual(menu[0].action, { replace: 'the' });
  assert.equal(menu[5].type, 'separator');
  assert.deepEqual(menu[6], { label: 'Add to dictionary', action: { addWord: 'teh' } });
  assert.equal(menu[7].type, 'separator');
  assert.deepEqual(menu.slice(8).map(i => i.role), ['cut', 'copy', 'paste']);
});

test('a misspelling with no suggestions says so', () => {
  const menu = spellMenu({ misspelledWord: 'qwzx', dictionarySuggestions: [], isEditable: true });
  assert.deepEqual(menu[0], { label: 'No suggestions', enabled: false });
});

test('plain text gets Copy only', () => {
  assert.deepEqual(spellMenu({ misspelledWord: '', isEditable: false, selectionText: 'x' }), [{ role: 'copy' }]);
});

test('nothing to offer returns null', () => {
  assert.equal(spellMenu({ misspelledWord: '', isEditable: false, selectionText: '' }), null);
});
