/*
 * diff.js
 * Line diff (LCS) for outline lines + hunk building + intra-line highlight.
 */
(function (root) {
  'use strict';

  var MAX_CELLS = 30000000; // guard for the LCS table (middle part only)

  function keyOf(line) {
    return line.depth + '\u0000' + line.text;
  }

  /**
   * @param {Array<{depth,text}>} a  old lines
   * @param {Array<{depth,text}>} b  new lines
   * @returns {Array<{type:'eq'|'del'|'ins', a:number|null, b:number|null}>}  indexes into a / b
   */
  function diffLines(a, b) {
    var ka = a.map(keyOf);
    var kb = b.map(keyOf);
    var ops = [];

    var start = 0;
    while (start < ka.length && start < kb.length && ka[start] === kb[start]) start++;
    var endA = ka.length, endB = kb.length;
    while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) { endA--; endB--; }

    for (var i = 0; i < start; i++) ops.push({ type: 'eq', a: i, b: i });

    var n = endA - start, m = endB - start;
    if (n > 0 || m > 0) {
      if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
        for (var x = 0; x < n; x++) ops.push({ type: 'del', a: start + x, b: null });
        for (var y = 0; y < m; y++) ops.push({ type: 'ins', a: null, b: start + y });
      } else {
        // LCS lengths, suffix-based so we can walk forward.
        var w = m + 1;
        var t = new Uint32Array((n + 1) * w);
        for (var p = n - 1; p >= 0; p--) {
          for (var q = m - 1; q >= 0; q--) {
            t[p * w + q] = ka[start + p] === kb[start + q]
              ? t[(p + 1) * w + q + 1] + 1
              : Math.max(t[(p + 1) * w + q], t[p * w + q + 1]);
          }
        }
        var pi = 0, qi = 0;
        while (pi < n && qi < m) {
          if (ka[start + pi] === kb[start + qi]) {
            ops.push({ type: 'eq', a: start + pi, b: start + qi }); pi++; qi++;
          } else if (t[(pi + 1) * w + qi] >= t[pi * w + qi + 1]) {
            ops.push({ type: 'del', a: start + pi, b: null }); pi++;
          } else {
            ops.push({ type: 'ins', a: null, b: start + qi }); qi++;
          }
        }
        while (pi < n) { ops.push({ type: 'del', a: start + pi, b: null }); pi++; }
        while (qi < m) { ops.push({ type: 'ins', a: null, b: start + qi }); qi++; }
      }
    }

    for (var s = 0; s < ka.length - endA; s++) ops.push({ type: 'eq', a: endA + s, b: endB + s });
    return reorderRuns(ops);
  }

  // Within a block of consecutive changes put all deletions before insertions,
  // so "modified" lines can be paired for intra-line highlight.
  function reorderRuns(ops) {
    var out = [];
    var i = 0;
    while (i < ops.length) {
      if (ops[i].type === 'eq') { out.push(ops[i]); i++; continue; }
      var dels = [], ins = [];
      while (i < ops.length && ops[i].type !== 'eq') {
        (ops[i].type === 'del' ? dels : ins).push(ops[i]); i++;
      }
      out.push.apply(out, dels.concat(ins));
    }
    return out;
  }

  /**
   * Group ops into hunks with `context` unchanged lines around each change.
   * context = Infinity -> one hunk with everything.
   */
  function buildHunks(ops, context) {
    if (context === undefined) context = 3;
    var changed = [];
    for (var i = 0; i < ops.length; i++) if (ops[i].type !== 'eq') changed.push(i);
    if (changed.length === 0) return [];
    if (context === Infinity) return [{ start: 0, end: ops.length }];

    var hunks = [];
    var cur = null;
    for (var c = 0; c < changed.length; c++) {
      var s = Math.max(0, changed[c] - context);
      var e = Math.min(ops.length, changed[c] + context + 1);
      if (cur && s <= cur.end) cur.end = Math.max(cur.end, e);
      else { cur = { start: s, end: e }; hunks.push(cur); }
    }
    return hunks;
  }

  /** Common prefix / suffix split, for highlighting the changed part of a modified line. */
  function inlineSplit(oldText, newText) {
    var p = 0;
    var max = Math.min(oldText.length, newText.length);
    while (p < max && oldText.charAt(p) === newText.charAt(p)) p++;
    var s = 0;
    while (s < max - p && oldText.charAt(oldText.length - 1 - s) === newText.charAt(newText.length - 1 - s)) s++;
    return {
      old: [oldText.substring(0, p), oldText.substring(p, oldText.length - s), oldText.substring(oldText.length - s)],
      new: [newText.substring(0, p), newText.substring(p, newText.length - s), newText.substring(newText.length - s)]
    };
  }

  function stats(ops) {
    var add = 0, del = 0;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === 'ins') add++;
      else if (ops[i].type === 'del') del++;
    }
    return { added: add, removed: del };
  }

  var api = { diffLines: diffLines, buildHunks: buildHunks, inlineSplit: inlineSplit, stats: stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XamlDiff = api;
})(typeof self !== 'undefined' ? self : this);
