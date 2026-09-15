'use strict';
// Objects created inside the vm sandbox belong to a different JS realm — structurally
// identical to a normal object, but with a different Object.prototype, which trips up
// assert.deepStrictEqual's stricter checks (it wants matching constructors, not just
// matching shape). Round-tripping through JSON strips that away and leaves a plain,
// same-realm object to compare normally. Safe for everything these tests compare (state
// snapshots, registry objects) since none of it holds functions, Dates, or other
// non-JSON-safe values.
function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { toPlain };
