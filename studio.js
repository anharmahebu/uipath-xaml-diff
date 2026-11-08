/*
 * studio.js
 * Studio-like review layout for one XAML file:
 *   Outline (left) | Designer canvas (center) | Properties (right)
 *   Variables · Arguments · Imports (bottom) + Before/After toggle + zoom.
 *
 * Canvas shows AFTER by default. Deleted activities stay at their old position as red "ghost" cards.
 * Changed fields are highlighted inside the card with the previous value struck through.
 * Depends on XamlTree (lib/xaml-tree.js).
 */
(function (root) {
  'use strict';

  var DEPTH_LIMIT = 3; // nested containers deeper than this start collapsed ("Double-click to view")

  // Own glyphs + color groups (not UiPath artwork).
  var ICONS = {
    Workflow: ['⧉', 'g-flow'], Sequence: ['▤', 'g-flow'], Flowchart: ['⬚', 'g-flow'], StateMachine: ['⬚', 'g-flow'],
    If: ['◇', 'g-ctrl'], Switch: ['⋔', 'g-ctrl'], While: ['⟲', 'g-ctrl'], DoWhile: ['⟲', 'g-ctrl'],
    ForEach: ['⟳', 'g-ctrl'], ParallelForEach: ['⟳', 'g-ctrl'], ForEachRow: ['⟳', 'g-ctrl'], Break: ['⏹', 'g-ctrl'], Continue: ['⏭', 'g-ctrl'],
    TryCatch: ['⚠', 'g-err'], Catch: ['⚠', 'g-err'], Throw: ['⛔', 'g-err'], Rethrow: ['⛔', 'g-err'],
    Assign: ['A=', 'g-data'], MultipleAssign: ['A≡', 'g-data'], AddDataRow: ['＋', 'g-data'], BuildDataTable: ['▦', 'g-data'],
    DeserializeJson: ['{}', 'g-data'], SerializeJson: ['{}', 'g-data'], InvokeCode: ['</>', 'g-data'], InvokeMethod: ['ƒ', 'g-data'],
    LogMessage: ['✎', 'g-log'], WriteLine: ['✎', 'g-log'], MessageBox: ['💬', 'g-log'], Comment: ['//', 'g-log'],
    InvokeWorkflowFile: ['▶', 'g-invoke'], Delay: ['⏱', 'g-ctrl'],
    ReadRange: ['▦', 'g-excel'], WriteRange: ['▦', 'g-excel'], AppendRange: ['▦', 'g-excel'],
    ExcelReadRange: ['▦', 'g-excel'], ExcelWriteRange: ['▦', 'g-excel'], ExcelApplicationScope: ['▦', 'g-excel'],
    ReadTextFile: ['▭', 'g-file'], WriteTextFile: ['▭', 'g-file'], CopyFile: ['▭', 'g-file'], Delete: ['▭', 'g-file'],
    HttpClient: ['⇄', 'g-invoke'], GetRobotAsset: ['🔑', 'g-invoke'], GetUsernamePasswordX: ['🔑', 'g-invoke'], GetCredential: ['🔑', 'g-invoke'],
    VerifyExpressionWithOperator: ['✔', 'g-test'], VerifyExpression: ['✔', 'g-test']
  };

  var OUTPUT_PROPS = { 'To': 1, 'Result': 1, 'Content': 1, 'JsonObject': 1, 'Credential': 1, 'Password': 1, 'Username': 1, 'CurrentIndex': 1, 'Output': 1 };
  var COMMON_PROPS = { 'DisplayName': 1, 'Annotation': 1, 'ContinueOnError': 1, 'Private': 1, 'TimeoutMS': 1, 'DelayBefore': 1, 'DelayAfter': 1 };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function prop(node, name) {
    if (!node) return null;
    for (var i = 0; i < node.props.length; i++) if (node.props[i].name === name) return node.props[i].value;
    return null;
  }

  function unquote(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /^".*"$/s.test(s) ? s.slice(1, -1) : s;
  }

  function iconOf(type) {
    return ICONS[type] || ['◻', 'g-other'];
  }

  function render(file, parse, opts) {
    opts = opts || {};
    var A = XamlTree.buildTree(file.oldText, parse);
    var B = XamlTree.buildTree(file.newText, parse);
    var wrap = el('div', 'sv');
    if (A.error || B.error) {
      wrap.appendChild(el('div', 'parse-error', (A.error ? 'Before: ' + A.error + '  ' : '') + (B.error ? 'After: ' + B.error : '')));
      return { element: wrap, counts: null };
    }
    var D = XamlTree.diffTrees(A.root, B.root);

    // ------------------------------------------------------------ view model
    // VM node: { key, node, ghost, side, status, moved, parent, slots:[{name, params, children:[VM]}], anyChange }
    function infoFor(node, oldSide) { return (oldSide ? D.oldInfo : D.newInfo)[node.uid]; }

    function buildVM(side) {
      var byKey = {};
      var list = [];
      function make(node, ghost, parent) {
        var oldSide = ghost || side === 'old';
        var info = infoFor(node, oldSide);
        var v = {
          key: (oldSide ? 'o' : 'n') + node.uid, node: node, ghost: ghost, side: side, parent: parent,
          status: ghost ? 'removed' : info.status, moved: !!info.moved, other: ghost ? null : info.other, slots: []
        };
        byKey[v.key] = v;
        list.push(v);

        var names = node.slots.map(function (s) { return s.name; });
        var counterpart = (!ghost && side === 'new') ? info.other : null;
        if (counterpart) counterpart.slots.forEach(function (s) { if (names.indexOf(s.name) < 0) names.push(s.name); });

        names.forEach(function (name) {
          var mine = node.slots.filter(function (s) { return s.name === name; })[0];
          var theirs = counterpart ? counterpart.slots.filter(function (s) { return s.name === name; })[0] : null;
          var kids = (mine ? mine.children : []).map(function (c) { return { n: c, ghost: ghost }; });
          if (theirs) {
            // insert removed old children after the counterpart of their previous kept sibling
            var after = {}; // new uid -> [old ghosts]
            var head = [];
            var prevKept = null;
            theirs.children.forEach(function (oc) {
              var oi = D.oldInfo[oc.uid];
              if (oi.status === 'removed') {
                if (prevKept) (after[prevKept] = after[prevKept] || []).push(oc);
                else head.push(oc);
              } else if (oi.other && mine && mine.children.indexOf(oi.other) >= 0) {
                prevKept = oi.other.uid;
              }
            });
            var merged = head.map(function (g) { return { n: g, ghost: true }; });
            kids.forEach(function (k) {
              merged.push(k);
              (after[k.n.uid] || []).forEach(function (g) { merged.push({ n: g, ghost: true }); });
            });
            // ghosts whose anchor is not in this slot anymore (anchor moved away)
            Object.keys(after).forEach(function (uid) {
              if (!kids.some(function (k) { return String(k.n.uid) === uid; })) {
                after[uid].forEach(function (g) { merged.push({ n: g, ghost: true }); });
              }
            });
            kids = merged;
          }
          var params = (mine || theirs).params;
          v.slots.push({ name: name, params: params, children: kids.map(function (k) { return make(k.n, k.ghost, v); }) });
        });

        var own = v.status !== 'unchanged' || v.moved;
        var childChange = v.slots.some(function (s) { return s.children.some(function (c) { return c.anyChange; }); });
        var otherSub = false;
        if (!ghost && info.other) otherSub = (oldSide ? D.newInfo : D.oldInfo)[info.other.uid].subtreeChanged;
        v.anyChange = own || childChange || otherSub;
        return v;
      }
      var r = side === 'old' ? A.root : B.root;
      var top = r ? make(r, false, null) : null;
      return { root: top, byKey: byKey, list: list };
    }

    var VM = { new: buildVM('new'), old: buildVM('old') };

    // ------------------------------------------------------------ state
    var st = {
      side: file.status === 'removed' ? 'old' : 'new',
      canvasKey: null,               // VM key of drilled-in root (null = workflow main)
      expanded: {},                  // node-identity -> true/false (manual)
      expandAll: opts.mode === 'full' ? true : null,
      sel: null,                     // {o: uid|null, n: uid|null}
      zoom: 1,
      onlyChangedOutline: true,
      onlyChangedProps: false,
      bottomTab: 'variables',
      bottomOpen: true,
      allScopes: false,
      reveal: null,                  // VM key to force-expand path to
      outlineOpen: readPref('xd.outlineOpen', true),
      propsOpen: readPref('xd.propsOpen', true)
    };

    function readPref(k, def) {
      try { var v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch (e) { return def; }
    }
    function writePref(k, v) {
      try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    // identity across sides: prefer new uid, else old uid
    function ident(v) {
      if (!v) return null;
      if (v.side === 'new' && !v.ghost) return 'n' + v.node.uid;
      if (v.side === 'old' && v.other) return 'n' + v.other.uid;
      return 'o' + v.node.uid;
    }
    function pairOf(v) {
      if (v.side === 'new' && !v.ghost) return { n: v.node.uid, o: v.other ? v.other.uid : null };
      return { o: v.node.uid, n: v.other ? v.other.uid : null };
    }
    function vmForSel(side) {
      if (!st.sel) return null;
      var m = VM[side].byKey;
      if (side === 'new') return (st.sel.n && m['n' + st.sel.n]) || (st.sel.o && m['o' + st.sel.o]) || null;
      return (st.sel.o && m['o' + st.sel.o]) || null;
    }
    function nodesOfSel() {
      if (!st.sel) return { o: null, n: null };
      var o = null, n = null;
      if (st.sel.o) XamlTree.walk(A.root, function (x) { if (x.uid === st.sel.o) o = x; });
      if (st.sel.n) XamlTree.walk(B.root, function (x) { if (x.uid === st.sel.n) n = x; });
      return { o: o, n: n };
    }

    // ------------------------------------------------------------ layout
    var top = el('div', 'sv-top');
    var crumbs = el('div', 'sv-crumbs');
    top.appendChild(crumbs);
    var topRight = el('div', 'sv-top-right');
    var prevBtn = el('button', 'sv-link', '◀ Prev change');
    var posLbl = el('span', 'sv-pos');
    var nextBtn = el('button', 'sv-link', 'Next change ▶');
    var expBtn = el('button', 'sv-link', 'Expand All');
    var colBtn = el('button', 'sv-link', 'Collapse All');
    [prevBtn, posLbl, nextBtn, el('span', 'sv-sep', '|'), expBtn, colBtn].forEach(function (x) { topRight.appendChild(x); });
    top.appendChild(topRight);

    var grid = el('div', 'sv-grid');
    var outline = el('div', 'sv-outline');
    var canvasWrap = el('div', 'sv-canvas-wrap');
    var canvas = el('div', 'sv-canvas');
    canvasWrap.appendChild(canvas);
    var props = el('div', 'sv-props');
    grid.appendChild(outline);
    grid.appendChild(canvasWrap);
    grid.appendChild(props);

    var bottom = el('div', 'sv-bottom');
    var statusBar = el('div', 'sv-status');

    var center = el('div', 'sv-center');
    center.appendChild(top);
    center.appendChild(grid);
    wrap.appendChild(center);
    wrap.appendChild(bottom);
    wrap.appendChild(statusBar);

    // ------------------------------------------------------------ collapsible side panels
    function applyGrid() {
      grid.style.gridTemplateColumns =
        (st.outlineOpen ? 'var(--sv-outline-w, 240px)' : '28px') + ' minmax(0, 1fr) ' +
        (st.propsOpen ? 'var(--sv-props-w, 330px)' : '28px');
      outline.classList.toggle('closed', !st.outlineOpen);
      props.classList.toggle('closed', !st.propsOpen);
    }

    function togglePanel(which) {
      if (which === 'outline') { st.outlineOpen = !st.outlineOpen; writePref('xd.outlineOpen', st.outlineOpen); drawOutline(); }
      else { st.propsOpen = !st.propsOpen; writePref('xd.propsOpen', st.propsOpen); drawProps(); }
      applyGrid();
    }

    // panel title with a collapse button; side = 'left' | 'right'
    function panelTitle(text, which, side) {
      var t = el('div', 'sv-panel-title');
      t.appendChild(el('span', null, text));
      var b = el('button', 'sv-pin', side === 'left' ? '«' : '»');
      b.title = 'Collapse ' + text;
      b.addEventListener('click', function () { togglePanel(which); });
      t.appendChild(b);
      return t;
    }

    // collapsed panel: thin vertical strip like Studio's side tabs
    function panelStrip(container, text, which, badge) {
      var s = el('button', 'sv-strip');
      s.title = 'Show ' + text;
      s.appendChild(el('span', 'sv-strip-text', text));
      if (badge) s.appendChild(el('span', 'sv-strip-badge', badge));
      s.addEventListener('click', function () { togglePanel(which); });
      container.appendChild(s);
    }

    // ------------------------------------------------------------ helpers for the canvas
    function mainOf(side) {
      var r = VM[side].root;
      if (!r) return null;
      var s = r.slots[0];
      return s && s.children.length === 1 ? s.children[0] : r;
    }

    function canvasRoot() {
      var side = st.side;
      if (st.canvasKey) {
        var v = VM[side].byKey[st.canvasKey];
        if (v) return v;
      }
      return mainOf(side);
    }

    function chainTo(v) {
      var c = [];
      for (var p = v; p; p = p.parent) c.unshift(p);
      return c;
    }

    function isContainer(v) {
      return v.slots.some(function (s) { return s.children.length; }) || v.node.slots.length > 0;
    }

    function isExpanded(v, depth, forced) {
      if (forced[v.key]) return true;
      var id = ident(v);
      if (st.expanded.hasOwnProperty(id)) return st.expanded[id];
      if (st.expandAll === true) return true;
      if (st.expandAll === false) return false;
      return v.anyChange && depth < DEPTH_LIMIT;
    }

    function otherNodeOf(v) {
      // counterpart node on the other side (for field-level diff)
      if (v.ghost) return null;
      return v.other;
    }

    // value + previous value for a property of v
    function fieldVals(v, name) {
      var mine = prop(v.node, name);
      var o = otherNodeOf(v);
      if (!o || v.status === 'added' || v.status === 'removed') return { value: mine, other: null, changed: false };
      var theirs = prop(o, name);
      return { value: mine, other: theirs, changed: (mine || '') !== (theirs || '') };
    }

    function fieldBox(v, name, kind) {
      var f = fieldVals(v, name);
      var box = el('div', 'sf' + (f.changed ? ' changed' : '') + (kind === 'dropdown' ? ' dropdown' : ''));
      var val = el('div', 'sf-val');
      if (kind !== 'dropdown' && kind !== 'plain') val.appendChild(el('span', 'sf-brace', '{}'));
      var txt = el('span', 'sf-text', kind === 'dropdown' ? unquote(f.value) : (f.value === null ? '' : f.value));
      txt.title = f.value || '';
      val.appendChild(txt);
      if (kind === 'dropdown') val.appendChild(el('span', 'sf-caret', '▾'));
      box.appendChild(val);
      if (f.changed) {
        var prev = el('div', 'sf-prev ' + (st.side === 'new' ? 'was' : 'now'));
        prev.appendChild(el('span', 'sf-prev-lbl', st.side === 'new' ? 'was' : 'now'));
        var pt = el('span', 'sf-text', kind === 'dropdown' ? unquote(f.other) : (f.other === null ? '(empty)' : f.other));
        pt.title = f.other || '';
        prev.appendChild(pt);
        box.appendChild(prev);
      }
      box.addEventListener('click', function (ev) { ev.stopPropagation(); box.classList.toggle('open'); select(v); });
      return box;
    }

    function labeled(v, label, name, kind) {
      var row = el('div', 'sf-row');
      row.appendChild(el('div', 'sf-label', label));
      row.appendChild(fieldBox(v, name, kind));
      return row;
    }

    function assignRow(v, toName, toText, valueName) {
      var row = el('div', 'sf-assign');
      if (toName) row.appendChild(fieldBox(v, toName));
      else {
        var b = el('div', 'sf');
        var vv = el('div', 'sf-val');
        vv.appendChild(el('span', 'sf-brace', '{}'));
        vv.appendChild(el('span', 'sf-text', toText));
        b.appendChild(vv);
        row.appendChild(b);
      }
      row.appendChild(el('span', 'sf-eq', '='));
      row.appendChild(fieldBox(v, valueName));
      return row;
    }

    function argsTable(v) {
      var names = [];
      [v.node, otherNodeOf(v)].forEach(function (n) {
        if (n) n.props.forEach(function (p) { if (/^(in|out|io) /.test(p.name) && names.indexOf(p.name) < 0) names.push(p.name); });
      });
      var t = el('table', 'sf-args');
      var h = el('tr');
      ['Name', 'Direction', 'Value'].forEach(function (x) { h.appendChild(el('th', null, x)); });
      t.appendChild(h);
      names.forEach(function (nm) {
        var f = fieldVals(v, nm);
        var tr = el('tr', f.changed || (v.other && f.value === null) || (v.other && prop(v.other, nm) === null) ? 'changed' : '');
        var dir = nm.split(' ')[0];
        tr.appendChild(el('td', null, nm.substring(dir.length + 1)));
        tr.appendChild(el('td', null, { 'in': 'In', 'out': 'Out', 'io': 'In/Out' }[dir] || dir));
        var td = el('td');
        td.appendChild(el('div', 'sf-text', f.value === null ? '(removed)' : f.value));
        if (f.changed) td.appendChild(el('div', 'sf-text sf-prevtxt', (st.side === 'new' ? 'was: ' : 'now: ') + (f.other === null ? '(none)' : f.other)));
        tr.appendChild(td);
        t.appendChild(tr);
      });
      return t;
    }

    // designer body (fields) per activity type
    function designer(v) {
      var n = v.node, t = n.type;
      var b = el('div', 'sa-fields');
      var add = function (x) { b.appendChild(x); };
      if (t === 'Assign') {
        add(assignRow(v, 'To', null, 'Value'));
      } else if (t === 'MultipleAssign') {
        var names = [];
        [n, otherNodeOf(v)].forEach(function (x) {
          if (x) x.props.forEach(function (p) { if (/ =$/.test(p.name) && names.indexOf(p.name) < 0) names.push(p.name); });
        });
        names.forEach(function (nm) {
          var present = prop(n, nm) !== null;
          var row = assignRow(v, null, nm.replace(/ =$/, ''), nm);
          if (!present) row.classList.add('row-removed');
          else if (otherNodeOf(v) && prop(otherNodeOf(v), nm) === null && v.status !== 'added') row.classList.add('row-added');
          add(row);
        });
      } else if (t === 'LogMessage') {
        add(labeled(v, 'Log Level', 'Level', 'dropdown'));
        add(labeled(v, 'Message', 'Message'));
      } else if (t === 'InvokeWorkflowFile') {
        add(el('div', 'sf-label block', 'Workflow file name'));
        add(fieldBox(v, 'WorkflowFileName'));
        var argCount = n.props.filter(function (p) { return /^(in|out|io) /.test(p.name); }).length;
        var argChanged = n.props.concat(otherNodeOf(v) ? otherNodeOf(v).props : []).some(function (p) {
          return /^(in|out|io) /.test(p.name) && fieldVals(v, p.name).changed;
        }) || (otherNodeOf(v) && v.status !== 'added' && otherNodeOf(v).props.filter(function (p) { return /^(in|out|io) /.test(p.name); }).length !== argCount);
        var btns = el('div', 'sf-buttons');
        var ia = el('button', 'sf-btn' + (argChanged ? ' changed' : ''), 'Import Arguments');
        ia.appendChild(el('span', 'sf-count', String(argCount)));
        var ow = el('button', 'sf-btn', 'Open Workflow');
        ow.disabled = true;
        btns.appendChild(ia);
        btns.appendChild(ow);
        add(btns);
        var holder = el('div', 'sf-args-holder');
        holder.hidden = !argChanged;
        if (argChanged) holder.appendChild(argsTable(v));
        ia.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!holder.firstChild) holder.appendChild(argsTable(v));
          holder.hidden = !holder.hidden;
        });
        add(holder);
      } else if (t === 'If' || t === 'While' || t === 'FlowDecision') {
        add(labeled(v, 'Condition', 'Condition'));
      } else if (t === 'DoWhile') {
        // condition shown after the body (rendered by caller)
      } else if (t === 'ForEach' || t === 'ParallelForEach') {
        var row = el('div', 'sf-foreach');
        var slot = v.slots.filter(function (s) { return s.name === 'Body'; })[0];
        var item = slot && slot.params.length ? slot.params[0].split(':')[0] : 'item';
        row.appendChild(el('span', 'sf-kw', 'ForEach'));
        var ib = el('div', 'sf small');
        ib.appendChild(el('div', 'sf-val', item));
        row.appendChild(ib);
        row.appendChild(el('span', 'sf-kw', 'in'));
        row.appendChild(fieldBox(v, 'Values'));
        add(row);
      } else if (t === 'InvokeMethod') {
        add(labeled(v, 'TargetType', 'TargetType', 'plain'));
        add(labeled(v, 'MethodName', 'MethodName', 'plain'));
        n.props.filter(function (p) { return /^in #/.test(p.name); }).forEach(function (p, i) { add(labeled(v, 'Parameter ' + (i + 1), p.name)); });
      } else if (/Range$/.test(t)) {
        ['WorkbookPath', 'SheetName', 'Range', 'DataTable'].forEach(function (k) {
          if (prop(n, k) !== null || prop(otherNodeOf(v), k) !== null) add(labeled(v, k.replace('WorkbookPath', 'Workbook path').replace('SheetName', 'Sheet name'), k));
        });
      } else if (t === 'ReadTextFile' || t === 'WriteTextFile') {
        add(labeled(v, 'File name', 'FileName'));
        if (t === 'WriteTextFile') add(labeled(v, 'Text', 'Text'));
      } else if (t === 'DeserializeJson') {
        add(labeled(v, 'JSON String', 'JsonString'));
      } else if (t === 'AddDataRow') {
        add(labeled(v, 'ArrayRow', prop(n, 'ArrayRow') !== null ? 'ArrayRow' : 'DataRow'));
        add(labeled(v, 'DataTable', 'DataTable'));
      } else if (t === 'Throw') {
        add(labeled(v, 'Exception', 'Exception'));
      } else if (t === 'Delay') {
        add(labeled(v, 'Duration', 'Duration'));
      } else if (t === 'Catch') {
        if (n.typeArg) b.appendChild(el('div', 'sf-label block', 'Exception: ' + n.typeArg.replace(/^\w+:/, '')));
      } else if (!isContainer(v)) {
        var shown = 0;
        var names2 = [];
        [n, otherNodeOf(v)].forEach(function (x) {
          if (x) x.props.forEach(function (p) { if (p.name !== 'Variables' && !COMMON_PROPS[p.name] && names2.indexOf(p.name) < 0) names2.push(p.name); });
        });
        // changed fields first, then up to 4 in total
        names2.sort(function (a, c) { return (fieldVals(v, c).changed ? 1 : 0) - (fieldVals(v, a).changed ? 1 : 0); });
        names2.forEach(function (nm) {
          if (shown >= 4 && !fieldVals(v, nm).changed) return;
          shown++;
          add(labeled(v, nm, nm));
        });
        var rest = names2.length - shown;
        if (rest > 0) add(el('div', 'sf-more', '+' + rest + ' more in Properties'));
      }
      return b.childNodes.length ? b : null;
    }

    // ------------------------------------------------------------ canvas rendering
    function card(v, depth, forced) {
      var n = v.node;
      var cont = isContainer(v);
      var cls = 'sa st-' + v.status + (v.moved ? ' moved' : '') + (v.ghost ? ' ghost' : '') + (cont ? ' container' : '');
      var box = el('div', cls);
      box.dataset.key = v.key;
      if (st.sel && vmForSel(st.side) === v) box.classList.add('selected');

      var head = el('div', 'sa-head');
      var ic = iconOf(n.type);
      head.appendChild(el('span', 'sa-icon ' + ic[1], ic[0]));
      head.appendChild(el('span', 'sa-title', n.displayName || n.type));
      if (v.status === 'added') head.appendChild(el('span', 'sa-badge added', 'NEW'));
      if (v.status === 'removed') head.appendChild(el('span', 'sa-badge removed', 'DELETED'));
      if (v.status === 'modified') head.appendChild(el('span', 'sa-badge modified', 'CHANGED'));
      if (v.moved) head.appendChild(el('span', 'sa-badge moved', 'MOVED'));
      if (n.annotation) head.appendChild(el('span', 'sa-hicon', '🗨'));
      var expanded = cont ? isExpanded(v, depth, forced) : true;
      var chev = el('button', 'sa-chev', expanded ? '⌃' : '⌄');
      chev.title = expanded ? 'Collapse' : 'Expand';
      head.appendChild(chev);
      box.appendChild(head);

      chev.addEventListener('click', function (ev) {
        ev.stopPropagation();
        st.expanded[ident(v)] = !expanded;
        st.reveal = null; // manual toggle wins over "reveal selected"
        drawCanvas();
      });
      box.addEventListener('click', function (ev) { ev.stopPropagation(); select(v); });
      box.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        if (cont && v !== canvasRoot()) drill(v);
      });

      if (n.annotation) {
        var annChanged = v.status === 'modified' && v.other && (v.other.annotation || '') !== (n.annotation || '');
        box.appendChild(el('div', 'sa-note' + (annChanged ? ' changed' : ''), n.annotation));
      }

      if (!expanded) {
        var col = el('div', 'sa-collapsed');
        col.appendChild(el('div', null, 'Double-click to view'));
        if (v.anyChange) {
          var c = countIn(v);
          var chips = el('div', 'sa-chips');
          if (c.added) chips.appendChild(el('span', 'chip added', c.added + ' new'));
          if (c.modified) chips.appendChild(el('span', 'chip modified', c.modified + ' changed'));
          if (c.removed) chips.appendChild(el('span', 'chip removed', c.removed + ' deleted'));
          if (c.moved) chips.appendChild(el('span', 'chip moved', c.moved + ' moved'));
          col.appendChild(chips);
        }
        box.appendChild(col);
        return box;
      }

      var fields = designer(v);
      if (fields) box.appendChild(fields);

      if (cont) {
        var body = el('div', 'sa-body');
        var branching = v.slots.length > 1 && v.slots.every(function (s) { return s.name !== ''; }) &&
          (n.type === 'If' || v.slots.length === 2);
        if (branching) {
          var row = el('div', 'sa-branches');
          v.slots.forEach(function (s) { row.appendChild(slotBox(s, depth, forced, true)); });
          body.appendChild(row);
        } else {
          v.slots.forEach(function (s) { body.appendChild(slotBox(s, depth, forced, false)); });
        }
        box.appendChild(body);
        if (n.type === 'DoWhile') box.appendChild(labeled(v, 'Condition', 'Condition'));
      }
      return box;
    }

    function slotBox(s, depth, forced, branch) {
      var sb = el('div', 'sa-slot' + (branch ? ' branch' : ''));
      if (s.name !== '' && !(s.name === 'Body' && !branch)) {
        sb.appendChild(el('div', 'sa-slot-label', s.name + (s.params.length ? '  (' + s.params.join(', ') + ')' : '')));
      }
      var col = el('div', 'sa-col');
      if (!s.children.length) col.appendChild(el('div', 'sa-drop', 'Drop Activity Here'));
      s.children.forEach(function (c, i) {
        if (i === 0) col.appendChild(el('div', 'sa-plus', '⊕'));
        else col.appendChild(el('div', 'sa-arrow'));
        col.appendChild(card(c, depth + 1, forced));
      });
      sb.appendChild(col);
      return sb;
    }

    function countIn(v) {
      var c = { added: 0, modified: 0, removed: 0, moved: 0 };
      (function walkVm(x) {
        x.slots.forEach(function (s) {
          s.children.forEach(function (ch) {
            if (ch.status === 'added') c.added++;
            else if (ch.status === 'removed') c.removed++;
            else if (ch.status === 'modified') c.modified++;
            if (ch.moved) c.moved++;
            walkVm(ch);
          });
        });
      })(v);
      return c;
    }

    function drawCrumbs(rootV) {
      crumbs.textContent = '';
      var wfRoot = VM[st.side].root;
      var name = wfRoot ? wfRoot.node.displayName : '(none)';
      var first = el('button', 'sv-crumb', name);
      first.addEventListener('click', function () { st.canvasKey = null; drawCanvas(); });
      crumbs.appendChild(first);
      if (!rootV) return;
      var main = mainOf(st.side);
      chainTo(rootV).forEach(function (v) {
        if (v === wfRoot || v === main) return;
        crumbs.appendChild(el('span', 'sv-crumb-sep', '>'));
        var b = el('button', 'sv-crumb', v.node.displayName || v.node.type);
        b.addEventListener('click', function () { st.canvasKey = v.key; drawCanvas(); });
        crumbs.appendChild(b);
      });
    }

    function drawCanvas(scrollToSel) {
      canvas.textContent = '';
      canvas.style.zoom = st.zoom;
      var r = canvasRoot();
      drawCrumbs(r);
      if (!r) {
        canvas.appendChild(el('div', 'sv-empty', st.side === 'old' ? 'File did not exist before this change.' : 'File was deleted in this change.'));
        drawOutline();
        drawBottom();
        return;
      }
      var forced = {};
      forced[r.key] = true;
      if (st.reveal) {
        var target = VM[st.side].byKey[st.reveal];
        if (target) chainTo(target).forEach(function (x) { forced[x.key] = true; });
      }
      // the canvas root is shown expanded; when it is the main Sequence, show its body like Studio
      var main = mainOf(st.side);
      var inner = el('div', 'sv-flow');
      if (r === main && r.node.type === 'Sequence') {
        var holder = card(r, 0, forced);
        holder.classList.add('root-seq');
        inner.appendChild(holder);
      } else {
        inner.appendChild(card(r, 0, forced));
      }
      canvas.appendChild(inner);
      drawOutline();
      drawBottom();
      if (scrollToSel) {
        var sel = canvas.querySelector('.sa.selected');
        if (sel) {
          var top = sel.getBoundingClientRect().top - canvasWrap.getBoundingClientRect().top + canvasWrap.scrollTop - 60;
          canvasWrap.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          var left = sel.getBoundingClientRect().left - canvasWrap.getBoundingClientRect().left + canvasWrap.scrollLeft - 40;
          if (left > canvasWrap.clientWidth * 0.5 || left < 0) canvasWrap.scrollLeft = Math.max(0, left);
        }
      }
    }

    function drill(v) {
      st.canvasKey = v.key;
      st.reveal = null;
      drawCanvas();
      canvasWrap.scrollTop = 0;
    }

    // ------------------------------------------------------------ navigation / selection
    function navigate(v) {
      // choose a canvas root so that v is at most DEPTH_LIMIT containers deep
      var chain = chainTo(v);
      var main = mainOf(st.side);
      var start = chain.indexOf(main);
      var depthFromMain = chain.length - 1 - start;
      if (depthFromMain > DEPTH_LIMIT + 1) {
        st.canvasKey = chain[chain.length - 1 - DEPTH_LIMIT].key;
      } else {
        var cur = canvasRoot();
        if (chain.indexOf(cur) < 0) st.canvasKey = null;
      }
      st.reveal = v.key;
      select(v, true);
    }

    function select(v, scroll) {
      st.sel = pairOf(v);
      drawProps();
      Array.prototype.forEach.call(canvas.querySelectorAll('.sa.selected'), function (x) { x.classList.remove('selected'); });
      var cardEl = canvas.querySelector('.sa[data-key="' + v.key + '"]');
      if (scroll || !cardEl) drawCanvas(true);
      else {
        cardEl.classList.add('selected');
        drawOutline();
        drawBottom();
      }
    }

    // change list in canvas order (current side)
    function changeList() {
      var out = [];
      var r = VM[st.side].root;
      if (!r) return out;
      (function w(v) {
        if (v !== r && (v.status !== 'unchanged' || v.moved)) out.push(v);
        v.slots.forEach(function (s) { s.children.forEach(w); });
      })(r);
      return out;
    }

    function step(delta) {
      var list = changeList();
      if (!list.length) return;
      var cur = vmForSel(st.side);
      var i = cur ? list.indexOf(cur) : -1;
      i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
      posLbl.textContent = (i + 1) + ' / ' + list.length;
      navigate(list[i]);
    }

    prevBtn.addEventListener('click', function () { step(-1); });
    nextBtn.addEventListener('click', function () { step(1); });
    expBtn.addEventListener('click', function () { st.expandAll = true; st.expanded = {}; drawCanvas(); });
    colBtn.addEventListener('click', function () { st.expandAll = false; st.expanded = {}; drawCanvas(); });

    // ------------------------------------------------------------ outline panel
    function drawOutline() {
      outline.textContent = '';
      if (!st.outlineOpen) {
        var n = changeList().length;
        panelStrip(outline, 'Outline', 'outline', n ? String(n) : null);
        return;
      }
      outline.appendChild(panelTitle('Outline', 'outline', 'left'));
      var lbl = el('label', 'sv-filter');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = st.onlyChangedOutline;
      cb.addEventListener('change', function () { st.onlyChangedOutline = cb.checked; drawOutline(); });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' Only changed'));
      outline.appendChild(lbl);
      var r = VM[st.side].root;
      if (!r) return;
      var selV = vmForSel(st.side);
      var list = el('div', 'sv-tree');
      (function w(v, d) {
        if (st.onlyChangedOutline && !v.anyChange && v !== r) return;
        if (v !== r) {
          var row = el('div', 'sv-node st-' + v.status + (v.moved ? ' moved' : '') + (v === selV ? ' selected' : ''));
          row.style.paddingLeft = (6 + (d - 1) * 12) + 'px';
          var ic = iconOf(v.node.type);
          row.appendChild(el('span', 'sv-node-icon ' + ic[1], ic[0]));
          row.appendChild(el('span', 'sv-node-name', v.node.displayName || v.node.type));
          var dot = v.status === 'added' ? '●' : v.status === 'removed' ? '✕' : v.status === 'modified' ? '◐' : v.moved ? '↕' : '';
          if (dot) row.appendChild(el('span', 'sv-dot st-' + v.status + (v.moved ? ' moved' : ''), dot));
          row.title = v.node.type + (v.node.displayName ? ' · ' + v.node.displayName : '');
          row.addEventListener('click', function () { navigate(v); });
          list.appendChild(row);
        }
        v.slots.forEach(function (s) { s.children.forEach(function (c) { w(c, d + 1); }); });
      })(r, 0);
      if (!list.childNodes.length) list.appendChild(el('div', 'sv-muted', st.onlyChangedOutline ? 'No activity changes.' : 'Empty workflow.'));
      outline.appendChild(list);
    }

    // ------------------------------------------------------------ properties panel
    function drawProps() {
      props.textContent = '';
      if (!st.propsOpen) {
        panelStrip(props, 'Properties', 'props', null);
        return;
      }
      props.appendChild(panelTitle('Properties', 'props', 'right'));
      var ns = nodesOfSel();
      var o = ns.o, n = ns.n;
      var any = n || o;
      if (!any) {
        props.appendChild(el('div', 'sv-muted pad', 'Select an activity to see its properties.'));
        return;
      }
      var v = vmForSel(st.side) || vmForSel(st.side === 'new' ? 'old' : 'new');
      var head = el('div', 'sp-head');
      var ic = iconOf(any.type);
      head.appendChild(el('span', 'sa-icon ' + ic[1], ic[0]));
      var ht = el('div');
      ht.appendChild(el('div', 'sp-type', any.type + (any.typeArg ? '<' + any.typeArg.replace(/\b\w+:/g, '') + '>' : '')));
      var stt = v ? v.status : 'unchanged';
      ht.appendChild(el('div', 'sp-status st-' + stt, stt === 'unchanged' ? 'No change' : stt === 'removed' ? 'Deleted' : stt === 'added' ? 'New' : 'Changed'));
      head.appendChild(ht);
      props.appendChild(head);

      var lbl = el('label', 'sv-filter');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = st.onlyChangedProps;
      cb.addEventListener('change', function () { st.onlyChangedProps = cb.checked; drawProps(); });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' Only changed properties'));
      props.appendChild(lbl);

      var rows = [];
      var seen = {};
      function add(name, a, b) {
        if (seen[name]) return;
        seen[name] = 1;
        rows.push({ name: name, a: a, b: b });
      }
      add('DisplayName', o ? o.displayName : null, n ? n.displayName : null);
      if ((o && o.annotation) || (n && n.annotation)) add('Annotation', o ? o.annotation : null, n ? n.annotation : null);
      [n, o].forEach(function (x) {
        if (x) x.props.forEach(function (p) { if (p.name !== 'Variables') add(p.name, prop(o, p.name), prop(n, p.name)); });
      });

      var cats = { Common: [], Input: [], Output: [], Misc: [] };
      rows.forEach(function (r) {
        var c = COMMON_PROPS[r.name] ? 'Common'
          : (OUTPUT_PROPS[r.name] || /^(out|io) /.test(r.name)) ? 'Output'
          : /^(MethodName|TargetType|TargetObject|UnSafe|ArgumentsVariable)$/.test(r.name) ? 'Misc' : 'Input';
        cats[c].push(r);
      });
      var both = o && n;
      Object.keys(cats).forEach(function (c) {
        var list = cats[c].filter(function (r) { return !st.onlyChangedProps || (both && (r.a || '') !== (r.b || '')); });
        if (!list.length) return;
        var sec = el('div', 'sp-cat');
        sec.appendChild(el('div', 'sp-cat-title', c));
        list.forEach(function (r) {
          var changed = both && (r.a || '') !== (r.b || '');
          var row = el('div', 'sp-row' + (changed ? ' changed' : ''));
          row.appendChild(el('div', 'sp-name', r.name));
          var val = el('div', 'sp-val');
          if (changed) {
            val.appendChild(el('pre', 'sp-old', r.a === null ? '(not set)' : r.a));
            val.appendChild(el('pre', 'sp-new', r.b === null ? '(not set)' : r.b));
          } else {
            val.appendChild(el('pre', null, (n ? r.b : r.a) === null ? '' : (n ? r.b : r.a)));
          }
          row.appendChild(val);
          sec.appendChild(row);
        });
        props.appendChild(sec);
      });
      if (any.id && any.id.indexOf('__') !== 0) props.appendChild(el('div', 'sv-muted pad small', 'IdRef: ' + any.id));
    }

    // ------------------------------------------------------------ bottom panel
    function diffList(oldArr, newArr, keyFn, sameFn) {
      var out = [];
      var om = {};
      (oldArr || []).forEach(function (x) { om[keyFn(x)] = x; });
      var nm = {};
      (newArr || []).forEach(function (x) {
        nm[keyFn(x)] = x;
        var o = om[keyFn(x)];
        out.push({ item: x, old: o || null, status: !o ? 'added' : sameFn(o, x) ? 'unchanged' : 'modified' });
      });
      (oldArr || []).forEach(function (x) { if (!nm[keyFn(x)]) out.push({ item: x, old: x, status: 'removed' }); });
      return out;
    }

    function scopeChain() {
      var v = vmForSel(st.side) || canvasRoot();
      if (!v) return [];
      return chainTo(v).filter(function (x) { return x.node.variables.length || (x.other && x.other.variables.length); });
    }

    function allVarScopes() {
      var out = [];
      var r = VM[st.side].root;
      if (!r) return out;
      (function w(v) {
        if (v.node.variables.length || (v.other && v.other.variables.length)) out.push(v);
        v.slots.forEach(function (s) { s.children.forEach(w); });
      })(r);
      return out;
    }

    function drawBottom() {
      bottom.textContent = '';
      var tabs = el('div', 'sv-tabs');
      var oldRoot = A.root, newRoot = B.root;
      var argDiff = diffList(oldRoot ? oldRoot.arguments : [], newRoot ? newRoot.arguments : [],
        function (a) { return a.name; }, function (a, b) { return a.direction === b.direction && a.type === b.type; });
      var impDiff = diffList((oldRoot ? oldRoot.imports : []).map(function (s) { return { name: s }; }),
        (newRoot ? newRoot.imports : []).map(function (s) { return { name: s }; }),
        function (a) { return a.name; }, function () { return true; });

      var scopes = st.allScopes ? allVarScopes() : scopeChain();
      var varRows = [];
      scopes.forEach(function (v) {
        var mine = v.node.variables, theirs = v.other ? v.other.variables : (v.ghost ? null : []);
        var oldVars = st.side === 'new' ? (v.ghost ? mine : theirs) : mine;
        var newVars = st.side === 'new' ? (v.ghost ? [] : mine) : (v.other ? v.other.variables : []);
        if (v.status === 'added') oldVars = [];
        diffList(oldVars || [], newVars || [], function (x) { return x.name; },
          function (a, b) { return a.type === b.type && (a.def || '') === (b.def || ''); })
          .forEach(function (d) { d.scope = v.node.displayName || v.node.type; varRows.push(d); });
      });
      // changed variables first (stable order otherwise)
      varRows = varRows.map(function (d, i) { return { d: d, i: i }; })
        .sort(function (a, b) { return ((a.d.status === 'unchanged') - (b.d.status === 'unchanged')) || a.i - b.i; })
        .map(function (x) { return x.d; });
      argDiff.sort(function (a, b) { return (a.status === 'unchanged') - (b.status === 'unchanged'); });

      function changedCount(list) { return list.filter(function (x) { return x.status !== 'unchanged'; }).length; }
      var allVarChanges = 0;
      allVarScopes().forEach(function (v) {
        var a = v.other ? v.other.variables : [], b = v.node.variables;
        if (v.ghost || v.status === 'removed') { allVarChanges += b.length; return; }
        allVarChanges += changedCount(diffList(st.side === 'new' ? a : b, st.side === 'new' ? b : a,
          function (x) { return x.name; }, function (x, y) { return x.type === y.type && (x.def || '') === (y.def || ''); }));
      });

      [['variables', 'Variables', allVarChanges], ['arguments', 'Arguments', changedCount(argDiff)], ['imports', 'Imports', changedCount(impDiff)]]
        .forEach(function (t) {
          var b = el('button', 'sv-tab' + (st.bottomTab === t[0] && st.bottomOpen ? ' active' : ''), t[1]);
          if (t[2]) b.appendChild(el('span', 'sv-tab-count', String(t[2])));
          b.addEventListener('click', function () {
            if (st.bottomTab === t[0]) st.bottomOpen = !st.bottomOpen; else { st.bottomTab = t[0]; st.bottomOpen = true; }
            drawBottom();
          });
          tabs.appendChild(b);
        });
      tabs.appendChild(el('span', 'sv-spacer'));

      // Before / After + zoom (right side of the bar, like Studio's zoom area)
      var seg = el('span', 'sv-seg');
      ['old', 'new'].forEach(function (s) {
        var b = el('button', 'sv-seg-btn' + (st.side === s ? ' active' : ''), s === 'old' ? 'Before' : 'After');
        b.disabled = (s === 'old' && !A.root) || (s === 'new' && !B.root);
        b.addEventListener('click', function () { flip(s); });
        seg.appendChild(b);
      });
      tabs.appendChild(seg);
      var zoom = el('select', 'sv-zoom');
      [0.5, 0.67, 0.8, 0.9, 1].forEach(function (z) {
        var op = el('option', null, Math.round(z * 100) + '%');
        op.value = z;
        if (z === st.zoom) op.selected = true;
        zoom.appendChild(op);
      });
      zoom.addEventListener('change', function () { st.zoom = parseFloat(zoom.value); canvas.style.zoom = st.zoom; });
      tabs.appendChild(zoom);
      bottom.appendChild(tabs);

      if (!st.bottomOpen) return;
      var pane = el('div', 'sv-tabpane');
      if (st.bottomTab === 'variables') {
        var bar = el('div', 'sv-tabbar');
        var lbl = el('label', 'sv-filter inline');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.checked = st.allScopes;
        cb.addEventListener('change', function () { st.allScopes = cb.checked; drawBottom(); });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' All scopes (otherwise: variables in scope of the selected activity)'));
        bar.appendChild(lbl);
        pane.appendChild(bar);
        pane.appendChild(table(['Name', 'Variable type', 'Scope', 'Default'], varRows, function (d) {
          return [d.item.name, typeCell(d), d.scope, defCell(d)];
        }));
      } else if (st.bottomTab === 'arguments') {
        pane.appendChild(table(['Name', 'Direction', 'Argument type'], argDiff, function (d) {
          return [d.item.name, chg(d, 'direction'), chg(d, 'type')];
        }));
      } else {
        var changedOnly = impDiff.filter(function (d) { return d.status !== 'unchanged'; });
        pane.appendChild(el('div', 'sv-muted small pad', impDiff.length + ' namespace(s)' + (changedOnly.length ? ', ' + changedOnly.length + ' changed (shown first)' : ', no changes')));
        pane.appendChild(table(['Namespace'], changedOnly.concat(impDiff.filter(function (d) { return d.status === 'unchanged'; })), function (d) { return [d.item.name]; }));
      }
      bottom.appendChild(pane);
    }

    function chg(d, field) {
      if (d.status === 'modified' && d.old[field] !== d.item[field]) return { old: d.old[field], now: d.item[field] };
      return d.item[field];
    }
    function typeCell(d) { return chg(d, 'type'); }
    function defCell(d) {
      if (d.status === 'modified' && (d.old.def || '') !== (d.item.def || '')) return { old: d.old.def || '', now: d.item.def || '' };
      return d.item.def || '';
    }

    function table(headers, rows, cells) {
      var t = el('table', 'sv-table');
      var h = el('tr');
      headers.forEach(function (x) { h.appendChild(el('th', null, x)); });
      t.appendChild(h);
      if (!rows.length) {
        var tr0 = el('tr');
        var td0 = el('td', 'sv-muted', 'None');
        td0.colSpan = headers.length;
        tr0.appendChild(td0);
        t.appendChild(tr0);
      }
      rows.forEach(function (d) {
        var tr = el('tr', 'st-' + d.status);
        cells(d).forEach(function (c, i) {
          var td = el('td');
          if (c && typeof c === 'object') {
            td.appendChild(el('div', 'sp-old', c.old));
            td.appendChild(el('div', 'sp-new', c.now));
          } else {
            td.textContent = c;
          }
          if (i === 0 && d.status !== 'unchanged') {
            td.appendChild(el('span', 'sa-badge ' + d.status, d.status === 'added' ? 'NEW' : d.status === 'removed' ? 'DELETED' : 'CHANGED'));
          }
          tr.appendChild(td);
        });
        t.appendChild(tr);
      });
      return t;
    }

    function flip(side) {
      if (side === st.side) return;
      var cur = vmForSel(st.side);
      var root = st.canvasKey ? VM[st.side].byKey[st.canvasKey] : null;
      st.side = side;
      // keep the drilled-in container if it exists on the other side
      if (root) {
        var other = null;
        if (side === 'old') other = root.ghost ? VM.old.byKey['o' + root.node.uid] : (root.other ? VM.old.byKey['o' + root.other.uid] : null);
        else other = root.other ? VM.new.byKey['n' + root.other.uid] : null;
        st.canvasKey = other ? other.key : null;
      }
      var target = vmForSel(side);
      st.reveal = target ? target.key : null;
      drawCanvas(!!target);
      drawProps();
      drawStatus();
      if (!target && cur) statusMsg((side === 'old' ? 'This activity is new, it does not exist in Before.' : 'This activity was deleted, it does not exist in After.'));
    }

    function statusMsg(t) {
      statusBar.textContent = t;
      setTimeout(function () { drawStatus(); }, 3000);
    }

    function drawStatus() {
      statusBar.textContent = '';
      var c = D.counts;
      [['added', c.added + ' new'], ['modified', c.modified + ' changed'], ['removed', c.removed + ' deleted'], ['moved', c.moved + ' moved']]
        .forEach(function (x) { statusBar.appendChild(el('span', 'chip ' + x[0], x[1])); });
      statusBar.appendChild(el('span', 'sv-muted small', '  ·  Click = select · Double-click container = open · Viewing: ' + (st.side === 'new' ? 'AFTER' : 'BEFORE')));
    }

    // ------------------------------------------------------------ init
    var total = changeList().length;
    posLbl.textContent = total ? '– / ' + total : 'no changes';
    prevBtn.disabled = nextBtn.disabled = !total;
    applyGrid();
    drawCanvas();
    drawProps();
    drawStatus();

    return { element: wrap, counts: D.counts };
  }

  root.XamlStudio = { render: render };
})(typeof self !== 'undefined' ? self : this);
