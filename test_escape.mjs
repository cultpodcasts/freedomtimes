function escapeRegExp(value) {
  // First escape hyphens, then other special regex characters
  return value.replace(/[-]/g, '\\$&').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

console.log('Pattern test:');

const terms = ['klischee', 'legende', 'zweirad'];
const ctx = terms.map(escapeRegExp).join('|');
const pattern = new RegExp(`kult[^\\p{L}\\p{N}]{0,24}(${ctx})`, 'iu');
console.log('Pattern:', pattern);

const testStr = 'sie ist kult und ein klischee';
console.log('Test string:', testStr);
console.log('Match result:', pattern.test(testStr));

// Debug: check what's between kult and klischee
const kultIdx = testStr.indexOf('kult');
const klischIdx = testStr.indexOf('klischee');
console.log('kult at:', kultIdx, 'klischee at:', klischIdx);
console.log('Between:', JSON.stringify(testStr.substring(kultIdx+4, klischIdx)));

// Test simpler pattern
const simplePattern = /kult[\s\w]{0,24}klischee/i;
console.log('Simple pattern test:', simplePattern.test(testStr));

// Test with just spaces
const spacePattern = /kult[\s]{0,24}klischee/i;
console.log('Space-only pattern test:', spacePattern.test(testStr));
