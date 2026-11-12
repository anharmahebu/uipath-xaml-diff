/*
 * xaml-tree.js
 * 1) Builds an activity tree from a UiPath XAML document (for the Studio-like view).
 * 2) Diffs two trees per activity: added / removed / modified / moved / unchanged.
 *
 * Node shape:
 *   { uid, id, type, typeArg, displayName, annotation,
 *     props: [{name, value}], slots: [{name, params, children: [Node]}],
 *     parent, slotName }
 */
(function (root) {
  'use strict';

  var XO = (typeof module !== 'undefined' && module.exports) ? require('./xaml-outline.js') : root.XamlOutline;
  var H = XO.helpers;

  var NON_ACTIVITY = {
    'Literal': 1, 'VisualBasicValue': 1, 'VisualBasicReference': 1, 'CSharpValue': 1, 'CSharpReference': 1,
    'AssignOperation': 1, 'Variable': 1, 'DelegateInArgument': 1, 'DelegateOutArgument': 1,
    'ActivityAction': 1, 'ActivityFunc': 1, 'String': 1, 'Boolean': 1, 'Int32': 1, 'Null': 1
  };

  var KNOWN_ACTIVITY = {
    'Sequence': 1, 'If': 1, 'Assign': 1, 'While': 1, 'DoWhile': 1, 'Flowchart': 1, 'FlowStep': 1,
    'FlowDecision': 1, 'FlowSwitch': 1, 'StateMachine': 1, 'State': 1, 'Transition': 1, 'TryCatch': 1,
    'Catch': 1, 'Switch': 1, 'Pick': 1, 'PickBranch': 1, 'Parallel': 1, 'ParallelForEach': 1,
    'ForEach': 1, 'Throw': 1, 'Rethrow': 1, 'Delay': 1, 'InvokeMethod': 1, 'WriteLine': 1
  };

  function cleanType(n) {
    return H.localName(n).replace(/`\d+$/, '');
  }

  function idRefOf(el) {
    return H.attr(el, 'sap2010:WorkflowViewState.IdRef') || H.attr(el, 'sap:WorkflowViewState.IdRef');
  }

  function isActivityElement(el) {
    if (H.isPropertyElement(el)) return false;
    var t = cleanType(el);
    if (H.ARG_DIR[t] || NON_ACTIVITY[t] || H.TRANSPARENT[t]) return false;
    return !!(idRefOf(el) || H.attr(el, 'DisplayName') !== null || KNOWN_ACTIVITY[t]);
  }

  function joinLines(lines) {
    return (lines || []).join('\n');
  }

  // "scg:Dictionary(x:String, sd:DataRow)" -> "Dictionary(String, DataRow)"
  function shortType(t) {
    return String(t || '').replace(/\b[A-Za-z_][\w]*:(?=[A-Za-z_])/g, '');
  }

  // Collect activities inside a property element, unwrapping ActivityAction / collections.
  function collect(el, out) {
    var kids = H.elementChildren(el);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var t = cleanType(k);
      if (isActivityElement(k)) {
        out.activities.push(k);
      } else if (t === 'ActivityAction' || t === 'ActivityFunc' || H.TRANSPARENT[t]) {
        collect(k, out);
      } else if (H.isPropertyElement(k) && /\.(Argument\d*|Result)$/.test(H.localName(k))) {
        var da = H.elementChildren(k);
        for (var d = 0; d < da.length; d++) {
          out.params.push((H.attr(da[d], 'Name') || '?') + ': ' + (H.attr(da[d], 'x:TypeArguments') || '?'));
        }
      } else if (H.isPropertyElement(k) && /\.Handler$/.test(H.localName(k))) {
        collect(k, out);
      } else {
        out.others.push(k);
      }
    }
    return out;
  }

  function Builder() {
    this.uid = 0;
  }

  Builder.prototype.node = function (type, displayName) {
    return {
      uid: ++this.uid, id: null, type: type, typeArg: null, displayName: displayName || '',
      annotation: '', props: [], slots: [], variables: [], parent: null, slotName: null
    };
  };

  Builder.prototype.addSlot = function (node, name, params, activities) {
    var slot = { name: name, params: params || [], children: [] };
    for (var i = 0; i < activities.length; i++) {
      var c = this.activity(activities[i]);
      c.parent = node;
      c.slotName = name;
      slot.children.push(c);
    }
    node.slots.push(slot);
    return slot;
  };

  Builder.prototype.defaultSlot = function (node) {
    for (var i = 0; i < node.slots.length; i++) if (node.slots[i].name === '') return node.slots[i];
    var s = { name: '', params: [], children: [] };
    node.slots.push(s);
    return s;
  };

  Builder.prototype.propertyElement = function (node, el) {
    var name = H.propName(el);
    var kids = H.elementChildren(el);

    if (name === 'Variables') {
      node.variables = kids.map(function (v) {
        var def = H.attr(v, 'Default');
        if (def === null) {
          // <Variable.Default><Literal .../></Variable.Default>
          var dk = H.elementChildren(v).filter(function (x) { return H.propName(x) === 'Default'; })[0];
          if (dk) { var ex = H.argumentExpression(dk); def = ex ? joinLines(ex) : null; }
          else def = null;
        } else {
          def = joinLines(H.formatValue(def));
        }
        return { name: H.attr(v, 'Name') || '?', type: shortType(H.attr(v, 'x:TypeArguments') || '?'), def: def };
      });
      var vars = node.variables.map(function (v) {
        return v.name + ': ' + v.type + (v.def !== null ? ' = ' + v.def : '');
      });
      if (vars.length) node.props.push({ name: 'Variables', value: vars.join('\n') });
      return;
    }

    if (name === 'Arguments') {
      for (var a = 0; a < kids.length; a++) {
        var dir = H.ARG_DIR[cleanType(kids[a])] || 'arg';
        var key = H.attr(kids[a], 'x:Key') || String(a + 1);
        var ex = H.argumentExpression(kids[a]);
        node.props.push({ name: dir + ' ' + key, value: ex ? joinLines(ex) : XO.elementToText(kids[a]) });
      }
      return;
    }

    if (name === 'AssignOperations') {
      var ops = collect(el, { activities: [], params: [], others: [] }).others;
      for (var o = 0; o < ops.length; o++) {
        var to = null, val = null;
        var parts = H.elementChildren(ops[o]);
        for (var p = 0; p < parts.length; p++) {
          var arg = H.elementChildren(parts[p])[0];
          if (!arg) continue;
          if (H.propName(parts[p]) === 'To') to = H.argumentExpression(arg);
          if (H.propName(parts[p]) === 'Value') val = H.argumentExpression(arg);
        }
        node.props.push({ name: (to ? joinLines(to) : 'op ' + (o + 1)) + ' =', value: val ? joinLines(val) : XO.elementToText(ops[o]) });
      }
      return;
    }

    if (kids.length === 0) {
      node.props.push({ name: name, value: joinLines(H.formatValue(H.ownText(el))) });
      return;
    }

    var found = collect(el, { activities: [], params: [], others: [] });
    if (found.activities.length) {
      this.addSlot(node, name, found.params, found.activities);
      if (found.others.length) {
        node.props.push({ name: name + ' (other)', value: found.others.map(XO.elementToText).join('\n') });
      }
      return;
    }

    if (kids.length === 1) {
      var e = H.argumentExpression(H.ARG_DIR[cleanType(kids[0])] ? kids[0] : el);
      if (e) { node.props.push({ name: name, value: joinLines(e) }); return; }
    }
    node.props.push({ name: name, value: kids.map(XO.elementToText).join('\n') });
  };

  Builder.prototype.activity = function (el) {
    var node = this.node(cleanType(el), H.attr(el, 'DisplayName') || '');
    node.id = idRefOf(el);
    node.typeArg = H.attr(el, 'x:TypeArguments');
    var note = H.attr(el, 'sap2010:Annotation.AnnotationText') || H.attr(el, 'sap:Annotation.AnnotationText');
    node.annotation = note ? joinLines(H.dedentLines(note)) : '';

    var at = el.attributes;
    for (var i = 0; i < at.length; i++) {
      var n = at[i].name;
      if (n === 'DisplayName' || n === 'x:TypeArguments' || /Annotation\.AnnotationText$/.test(n)) continue;
      if (H.isNoiseAttr(n, at[i].value)) continue;
      node.props.push({ name: n, value: joinLines(H.formatValue(at[i].value)) });
    }

    var kids = H.elementChildren(el);
    var argNo = 0;
    for (var k = 0; k < kids.length; k++) {
      var c = kids[k];
      if (H.isPropertyElement(c)) {
        this.propertyElement(node, c);
      } else if (isActivityElement(c)) {
        var child = this.activity(c);
        child.parent = node;
        child.slotName = '';
        this.defaultSlot(node).children.push(child);
      } else if (cleanType(c) === 'ActivityAction' || cleanType(c) === 'ActivityFunc') {
        // e.g. <Catch><ActivityAction>...</ActivityAction></Catch>: the handler body
        var found = collect(c, { activities: [], params: [], others: [] });
        this.addSlot(node, '', found.params, found.activities);
      } else {
        argNo++;
        var dir = H.ARG_DIR[cleanType(c)];
        var key = H.attr(c, 'x:Key');
        var ex = H.argumentExpression(c);
        node.props.push({
          name: (dir || cleanType(c)) + ' ' + (key || '#' + argNo),
          value: ex ? joinLines(ex) : XO.elementToText(c)
        });
      }
    }
    return node;
  };

  /**
   * @returns {{root: Node|null, error: string|null}}
   */
  function buildTree(xamlText, parse) {
    var text = String(xamlText || '').replace(/^﻿/, '');
    if (text.trim() === '') return { root: null, error: null };
    var doc;
    try { doc = parse(text); } catch (e) { return { root: null, error: 'XML parse error: ' + e.message }; }
    var rootEl = doc && doc.documentElement;
    if (!rootEl || H.localName(rootEl) === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
      return { root: null, error: 'XML parse error: file is not valid XAML/XML.' };
    }

    var b = new Builder();
    var wf = b.node('Workflow', H.attr(rootEl, 'x:Class') || H.localName(rootEl));
    wf.id = '__workflow__';
    wf.arguments = [];
    wf.imports = [];

    // Imports (namespaces) are designer noise for the outline, but Studio shows them in a tab.
    var raw = rootEl.childNodes;
    for (var r = 0; r < raw.length; r++) {
      if (raw[r].nodeType !== 1 || !/NamespacesForImplementation$/.test(raw[r].nodeName)) continue;
      var coll = H.elementChildren(raw[r])[0];
      if (!coll) {
        // elementChildren drops noise-named children; read the collection directly
        var rc = raw[r].childNodes;
        for (var q = 0; q < rc.length; q++) if (rc[q].nodeType === 1) { coll = rc[q]; break; }
      }
      if (coll) {
        var items = coll.childNodes;
        for (var it = 0; it < items.length; it++) {
          if (items[it].nodeType === 1) wf.imports.push(H.ownText(items[it]).trim());
        }
      }
    }

    var kids = H.elementChildren(rootEl);
    var main = [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (H.localName(c) === 'Members') {
        var props = H.elementChildren(c);
        for (var p = 0; p < props.length; p++) {
          var at = H.attr(props[p], 'Type') || '?';
          var m = at.match(/^(InArgument|OutArgument|InOutArgument)\((.*)\)$/);
          wf.arguments.push({
            name: H.attr(props[p], 'Name') || '?',
            direction: m ? { InArgument: 'In', OutArgument: 'Out', InOutArgument: 'In/Out' }[m[1]] : 'Property',
            type: shortType(m ? m[2] : at)
          });
          wf.props.push({ name: 'Argument ' + (H.attr(props[p], 'Name') || '?'), value: at });
        }
      } else if (H.isPropertyElement(c)) {
        // root-level property elements other than noise (rare)
        wf.props.push({ name: H.propName(c), value: XO.elementToText(c) });
      } else {
        main.push(c);
      }
    }
    b.addSlot(wf, '', [], main);
    return { root: wf, error: null };
  }

  // ---------------------------------------------------------------- diff

  function walk(node, fn) {
    if (!node) return;
    fn(node);
    for (var s = 0; s < node.slots.length; s++) {
      for (var c = 0; c < node.slots[s].children.length; c++) walk(node.slots[s].children[c], fn);
    }
  }

  function slotByName(node, name) {
    for (var i = 0; i < node.slots.length; i++) if (node.slots[i].name === name) return node.slots[i];
    return null;
  }

  function propsMap(node) {
    var m = {};
    node.props.forEach(function (p) { m[p.name] = p.value; });
    return m;
  }

  // LCS over two key arrays, returns pairs [i, j].
  function lcsPairs(ka, kb) {
    var n = ka.length, m = kb.length;
    if (!n || !m) return [];
    var w = m + 1;
    var t = new Uint32Array((n + 1) * w);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        t[i * w + j] = ka[i] === kb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    var out = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { out.push([i, j]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
    return out;
  }

  /**
   * Diff two trees. Either root may be null (file added / removed).
   * @returns {{
   *   oldInfo: Object<uid, {status, other, changedProps, subtreeChanged}>,
   *   newInfo: Object<uid, {...}>,
   *   counts: {added, removed, modified, moved}
   * }}
   */
  function diffTrees(oldRoot, newRoot) {
    var oldInfo = {}, newInfo = {};
    var o2n = {}, n2o = {};
    var oldNodes = [], newNodes = [];
    walk(oldRoot, function (n) { oldNodes.push(n); });
    walk(newRoot, function (n) { newNodes.push(n); });
    var byUidOld = {}, byUidNew = {};
    oldNodes.forEach(function (n) { byUidOld[n.uid] = n; });
    newNodes.forEach(function (n) { byUidNew[n.uid] = n; });

    function link(a, b) { o2n[a.uid] = b; n2o[b.uid] = a; }

    // 1) IdRef match (same type, unique id on both sides)
    var idOld = {}, idNew = {};
    function countIds(list, map) {
      list.forEach(function (n) { if (n.id) map[n.id] = (map[n.id] || []).concat([n]); });
    }
    countIds(oldNodes, idOld);
    countIds(newNodes, idNew);
    Object.keys(idOld).forEach(function (id) {
      var a = idOld[id], b = idNew[id];
      if (a && b && a.length === 1 && b.length === 1 && a[0].type === b[0].type) link(a[0], b[0]);
    });
    if (oldRoot && newRoot && !o2n[oldRoot.uid]) link(oldRoot, newRoot);

    // 2) Top-down: match remaining children of matched parents, per slot.
    var queue = [];
    oldNodes.forEach(function (n) { if (o2n[n.uid]) queue.push(n); });
    while (queue.length) {
      var a = queue.shift();
      var b = o2n[a.uid];
      a.slots.forEach(function (sa) {
        var sb = slotByName(b, sa.name);
        if (!sb) return;
        var ua = sa.children.filter(function (c) { return !o2n[c.uid]; });
        var ub = sb.children.filter(function (c) { return !n2o[c.uid]; });
        if (!ua.length || !ub.length) return;
        var key = function (c) { return c.type + '\u0000' + c.displayName; };
        lcsPairs(ua.map(key), ub.map(key)).forEach(function (p) {
          link(ua[p[0]], ub[p[1]]);
          queue.push(ua[p[0]]);
        });
        // same type, exactly one left on each side -> treat as the same activity
        var ra = ua.filter(function (c) { return !o2n[c.uid]; });
        var rb = ub.filter(function (c) { return !n2o[c.uid]; });
        var types = {};
        ra.forEach(function (c) { types[c.type] = (types[c.type] || 0) + 1; });
        rb.forEach(function (c) { types[c.type] = (types[c.type] || 0) + 100; });
        Object.keys(types).forEach(function (t) {
          if (types[t] === 101) {
            var x = ra.filter(function (c) { return c.type === t; })[0];
            var y = rb.filter(function (c) { return c.type === t; })[0];
            link(x, y);
            queue.push(x);
          }
        });
      });
    }

    // 3) Status
    var counts = { added: 0, removed: 0, modified: 0, moved: 0 };

    oldNodes.forEach(function (n) {
      var other = o2n[n.uid];
      oldInfo[n.uid] = { status: other ? 'unchanged' : 'removed', other: other || null, changedProps: {}, subtreeChanged: false };
      if (!other) counts.removed++;
    });
    newNodes.forEach(function (n) {
      var other = n2o[n.uid];
      newInfo[n.uid] = { status: other ? 'unchanged' : 'added', other: other || null, changedProps: {}, subtreeChanged: false };
      if (!other) counts.added++;
    });

    // modified: own properties differ
    newNodes.forEach(function (n) {
      var o = n2o[n.uid];
      if (!o) return;
      var changed = {};
      var any = false;
      if (o.displayName !== n.displayName) { changed['DisplayName'] = 1; any = true; }
      if ((o.annotation || '') !== (n.annotation || '')) { changed['Annotation'] = 1; any = true; }
      if ((o.typeArg || '') !== (n.typeArg || '')) { changed['TypeArguments'] = 1; any = true; }
      var pa = propsMap(o), pb = propsMap(n);
      Object.keys(pa).concat(Object.keys(pb)).forEach(function (k) {
        if (pa[k] !== pb[k]) { changed[k] = 1; any = true; }
      });
      var slotsA = o.slots.map(function (s) { return s.name + '(' + s.params.join(',') + ')'; }).join('|');
      var slotsB = n.slots.map(function (s) { return s.name + '(' + s.params.join(',') + ')'; }).join('|');
      if (slotsA !== slotsB && o.slots.length && n.slots.length) {
        // only parameter changes matter here; added/removed child activities are shown on the children
        var paramsA = o.slots.map(function (s) { return s.params.join(','); }).join('|');
        var paramsB = n.slots.map(function (s) { return s.params.join(','); }).join('|');
        if (paramsA !== paramsB) { changed['Delegate parameters'] = 1; any = true; }
      }
      if (any) {
        newInfo[n.uid].status = 'modified';
        oldInfo[o.uid].status = 'modified';
        newInfo[n.uid].changedProps = changed;
        oldInfo[o.uid].changedProps = changed;
        counts.modified++;
      }
    });

    // moved: different parent / slot, or order changed among matched siblings
    var movedNew = {};
    newNodes.forEach(function (n) {
      var o = n2o[n.uid];
      if (!o || !n.parent || !o.parent) return;
      if (o2n[o.parent.uid] !== n.parent || o.slotName !== n.slotName) movedNew[n.uid] = 1;
    });
    newNodes.forEach(function (p) {
      p.slots.forEach(function (s) {
        var seq = s.children.filter(function (c) { return n2o[c.uid] && !movedNew[c.uid]; });
        if (seq.length < 2) return;
        var oldSlot = slotByName(n2o[p.uid] || { slots: [] }, s.name);
        if (!oldSlot) return;
        var oldIndex = {};
        oldSlot.children.forEach(function (c, i) { oldIndex[c.uid] = i; });
        var idx = seq.map(function (c) { return oldIndex[n2o[c.uid].uid]; });
        // longest increasing subsequence: everything outside it was moved
        var keep = lisIndexes(idx);
        seq.forEach(function (c, i) { if (!keep[i]) movedNew[c.uid] = 1; });
      });
    });
    Object.keys(movedNew).forEach(function (uid) {
      var info = newInfo[uid];
      info.moved = true;
      var o = n2o[uid];
      oldInfo[o.uid].moved = true;
      counts.moved++;
    });

    // subtreeChanged flags (post-order)
    function mark(node, info) {
      var changed = info[node.uid].status !== 'unchanged' || !!info[node.uid].moved;
      node.slots.forEach(function (s) {
        s.children.forEach(function (c) { if (mark(c, info)) changed = true; });
      });
      info[node.uid].subtreeChanged = changed;
      return changed;
    }
    if (oldRoot) mark(oldRoot, oldInfo);
    if (newRoot) mark(newRoot, newInfo);

    return { oldInfo: oldInfo, newInfo: newInfo, counts: counts };
  }

  // indexes (into arr) that belong to one longest increasing subsequence
  function lisIndexes(arr) {
    var n = arr.length;
    var len = new Array(n), prev = new Array(n);
    var best = 0, bestEnd = -1;
    for (var i = 0; i < n; i++) {
      len[i] = 1; prev[i] = -1;
      for (var j = 0; j < i; j++) {
        if (arr[j] < arr[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      }
      if (len[i] > best) { best = len[i]; bestEnd = i; }
    }
    var keep = {};
    for (var k = bestEnd; k >= 0; k = prev[k]) keep[k] = true;
    return keep;
  }

  var api = { buildTree: buildTree, diffTrees: diffTrees, walk: walk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XamlTree = api;
})(typeof self !== 'undefined' ? self : this);
