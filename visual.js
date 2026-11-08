/*
 * visual.js
 * Studio-like side-by-side view: Before | After activity designer + Properties panel.
 * Depends on XamlTree (lib/xaml-tree.js).
 */
(function (root) {
  'use strict';

  // Own glyphs per activity type (not UiPath icons).
  var ICONS = {
    Workflow: '⧉', Sequence: '▤', If: '◇', Assign: '＝', MultipleAssign: '≡', LogMessage: '✎',
    InvokeWorkflowFile: '↗', ForEach: '⟳', ParallelForEach: '⟳', While: '⟲', DoWhile: '⟲',
    TryCatch: '⚠', Catch: '⚠', Throw: '⛔', Rethrow: '⛔', InvokeMethod: 'ƒ', InvokeCode: '{}',
    ReadRange: '▦', WriteRange: '▦', AppendRange: '▦', ExcelReadRange: '▦', ExcelWriteRange: '▦',
    ReadTextFile: '▭', WriteTextFile: '▭', DeserializeJson: '{}', SerializeJson: '{}',
    AddDataRow: '＋', BuildDataTable: '▦', FilterDataTable: '⚲', Switch: '⋔', Flowchart: '⬚',
    FlowDecision: '◇', StateMachine: '⬚', State: '◯', Delay: '⏱', Break: '⏹', Continue: '⏭',
    HttpClient: '⇄', GetRobotAsset: '🔑', GetCredential: '🔑', GetUsernamePasswordX: '🔑',
    VerifyExpressionWithOperator: '✔', VerifyExpression: '✔', MessageBox: '💬', Comment: '//'
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function firstLine(v, max) {
    var s = String(v || '').split('\n')[0];
    max = max || 140;
    var more = String(v || '').indexOf('\n') >= 0;
    if (s.length > max) { s = s.substring(0, max - 1) + '…'; more = false; }
    return s + (more ? ' …' : '');
  }

  function prop(node, name) {
    for (var i = 0; i < node.props.length; i++) if (node.props[i].name === name) return node.props[i].value;
    return null;
  }

  // Short body text shown inside the card (full values are in the Properties panel).
  function summarize(node) {
    var t = node.type, out = [];
    var p = function (n) { return prop(node, n); };
    if (t === 'Workflow') {
      var args = node.props.filter(function (x) { return x.name.indexOf('Argument ') === 0; });
      if (args.length) out.push(args.length + ' argument(s): ' + args.map(function (a) { return a.name.substring(9); }).join(', '));
    } else if (t === 'Assign') {
      out.push(firstLine(p('To')) + ' = ' + firstLine(p('Value')));
    } else if (t === 'MultipleAssign') {
      var ops = node.props.filter(function (x) { return / =$/.test(x.name); });
      ops.slice(0, 6).forEach(function (o) { out.push(o.name + ' ' + firstLine(o.value, 100)); });
      if (ops.length > 6) out.push('+' + (ops.length - 6) + ' more');
    } else if (t === 'If' || t === 'While' || t === 'DoWhile' || t === 'FlowDecision') {
      if (p('Condition') !== null) out.push(firstLine(p('Condition')));
    } else if (t === 'LogMessage') {
      out.push('[' + String(p('Level') || '').replace(/"/g, '') + '] ' + firstLine(p('Message')));
    } else if (t === 'InvokeWorkflowFile') {
      out.push(String(p('WorkflowFileName') || '').replace(/"/g, ''));
      var n = node.props.filter(function (x) { return /^(in|out|io) /.test(x.name); }).length;
      if (n) out.push(n + ' argument(s)');
    } else if (t === 'ForEach' || t === 'ParallelForEach') {
      out.push('in ' + firstLine(p('Values')));
    } else if (t === 'InvokeMethod') {
      out.push(String(p('TargetType') || p('TargetObject') || '').replace(/"/g, '') + '.' + String(p('MethodName') || '').replace(/"/g, '') + '(…)');
    } else if (/Range$/.test(t)) {
      out.push([p('WorkbookPath'), p('SheetName')].filter(Boolean).map(function (x) { return firstLine(x, 80); }).join(' · '));
    } else if (t === 'ReadTextFile' || t === 'WriteTextFile') {
      out.push(firstLine(p('FileName')));
    } else if (t === 'AddDataRow') {
      out.push(firstLine(p('DataTable')) + ' ← ' + firstLine(p('ArrayRow') || p('DataRow'), 100));
    } else if (t === 'Catch') {
      if (node.typeArg) out.push(node.typeArg);
    } else if (!node.slots.length) {
      node.props.filter(function (x) { return x.name !== 'Variables'; }).slice(0, 2)
        .forEach(function (x) { out.push(x.name + ': ' + firstLine(x.value, 100)); });
    }
    return out.filter(function (s) { return s && s.trim(); });
  }

  function countActivities(node) {
    var n = 0;
    node.slots.forEach(function (s) {
      s.children.forEach(function (c) { n += 1 + countActivities(c); });
    });
    return n;
  }

  /**
   * Render one file as a Studio-like side-by-side diff.
   * @param {{oldText:string|null, newText:string|null, status:string}} file
   * @param {'changes'|'full'} mode
   * @param {function(string): Document} parse
   */
  function render(file, mode, parse) {
    var wrap = el('div', 'vd' + (mode === 'changes' ? ' compact' : ''));
    var A = XamlTree.buildTree(file.oldText, parse);
    var B = XamlTree.buildTree(file.newText, parse);
    if (A.error || B.error) {
      wrap.appendChild(el('div', 'parse-error', (A.error ? 'Before: ' + A.error + '  ' : '') + (B.error ? 'After: ' + B.error : '')));
      return { element: wrap, counts: null };
    }
    var D = XamlTree.diffTrees(A.root, B.root);

    var ctx = {
      mode: mode,
      info: { old: D.oldInfo, new: D.newInfo },
      cards: { old: {}, new: {} },
      expanders: { old: {}, new: {} },
      selected: null,
      props: null
    };

    // toolbar
    var bar = el('div', 'vd-toolbar');
    var c = D.counts;
    [['added', c.added + ' added'], ['modified', c.modified + ' changed'], ['removed', c.removed + ' removed'], ['moved', c.moved + ' moved']]
      .forEach(function (x) { bar.appendChild(el('span', 'vd-chip ' + x[0], x[1])); });
    var spacer = el('span', 'vd-spacer');
    bar.appendChild(spacer);
    var prevBtn = el('button', 'vd-btn', '◀ Prev change');
    var nextBtn = el('button', 'vd-btn', 'Next change ▶');
    var posLbl = el('span', 'vd-pos', '');
    bar.appendChild(prevBtn);
    bar.appendChild(posLbl);
    bar.appendChild(nextBtn);
    wrap.appendChild(bar);

    // grid
    var grid = el('div', 'vd-grid');
    wrap.appendChild(grid);
    var paneOld = pane('Before', A.root, 'old', file.status === 'added' ? 'File did not exist before this change.' : null);
    var paneNew = pane('After', B.root, 'new', file.status === 'removed' ? 'File was deleted in this change.' : null);
    grid.appendChild(paneOld);
    grid.appendChild(paneNew);
    var propsBox = el('div', 'vd-props');
    propsBox.appendChild(el('div', 'vd-props-empty', 'Click an activity to see its properties (Before → After).'));
    grid.appendChild(propsBox);
    ctx.props = propsBox;

    function pane(title, rootNode, side, emptyMsg) {
      var p = el('div', 'vd-pane ' + side);
      p.appendChild(el('div', 'vd-pane-title', title));
      var scroll = el('div', 'vd-scroll');
      p.appendChild(scroll);
      if (!rootNode) scroll.appendChild(el('div', 'vd-empty', emptyMsg || 'No content.'));
      else scroll.appendChild(card(rootNode, side));
      return p;
    }

    function card(node, side) {
      var info = ctx.info[side][node.uid];
      var status = info ? info.status : 'unchanged';
      var box = el('div', 'act st-' + status + (info && info.moved ? ' is-moved' : '') + (node.slots.length ? ' container' : ''));
      box.dataset.uid = node.uid;
      ctx.cards[side][node.uid] = box;

      var head = el('div', 'act-head');
      box.appendChild(head);
      var caret = el('span', 'act-caret', '');
      head.appendChild(caret);
      head.appendChild(el('span', 'act-icon', ICONS[node.type] || '◻'));
      head.appendChild(el('span', 'act-title', node.type === 'Workflow' ? node.displayName + '.xaml' : (node.displayName || node.type)));
      if (node.type !== 'Workflow') head.appendChild(el('span', 'act-type', node.type + (node.typeArg ? '<' + node.typeArg + '>' : '')));
      if (status === 'added') head.appendChild(el('span', 'act-badge added', 'NEW'));
      if (status === 'removed') head.appendChild(el('span', 'act-badge removed', 'DELETED'));
      if (status === 'modified') head.appendChild(el('span', 'act-badge modified', 'CHANGED'));
      if (info && info.moved) head.appendChild(el('span', 'act-badge moved', 'MOVED'));

      head.addEventListener('click', function (ev) {
        ev.stopPropagation();
        select(node, side, true);
      });

      if (node.annotation) box.appendChild(el('div', 'act-note', node.annotation));
      var sum = summarize(node);
      if (sum.length) {
        var s = el('div', 'act-summary');
        sum.forEach(function (line) { s.appendChild(el('div', null, line)); });
        box.appendChild(s);
      }

      var hasKids = node.slots.some(function (sl) { return sl.children.length; });
      if (!hasKids) return box;

      var body = el('div', 'act-body');
      box.appendChild(body);
      var rendered = false;
      // collapse only if nothing changed underneath on EITHER side (keeps both panes in sync)
      var otherInfo = info && info.other ? ctx.info[side === 'old' ? 'new' : 'old'][info.other.uid] : null;
      var anyChange = (info && info.subtreeChanged) || (otherInfo && otherInfo.subtreeChanged);
      var collapsed = ctx.mode === 'changes' && info && !anyChange && node.type !== 'Workflow';

      function fill() {
        if (rendered) return;
        rendered = true;
        var isBranching = node.slots.length > 1 && node.slots.every(function (sl) { return sl.name !== ''; });
        var holder = isBranching ? el('div', 'act-branches') : body;
        if (isBranching) body.appendChild(holder);
        node.slots.forEach(function (sl) {
          var slotBox = el('div', 'act-slot' + (isBranching ? ' branch' : ''));
          if (sl.name !== '') slotBox.appendChild(el('div', 'act-slot-label', sl.name + (sl.params.length ? ' (' + sl.params.join(', ') + ')' : '')));
          var list = el('div', 'act-list');
          if (!sl.children.length) list.appendChild(el('div', 'act-drop', '(empty)'));
          sl.children.forEach(function (ch) { list.appendChild(card(ch, side)); });
          slotBox.appendChild(list);
          holder.appendChild(slotBox);
        });
      }

      var folded = el('div', 'act-folded', '▸ ' + countActivities(node) + ' activities, no changes (click to expand)');
      function expand() {
        fill();
        body.hidden = false;
        folded.hidden = true;
        caret.textContent = '▾';
        box.classList.remove('is-collapsed');
      }
      function collapse() {
        body.hidden = true;
        folded.hidden = false;
        caret.textContent = '▸';
        box.classList.add('is-collapsed');
      }
      ctx.expanders[side][node.uid] = expand;
      caret.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (body.hidden) expand(); else collapse();
      });
      folded.addEventListener('click', function (ev) { ev.stopPropagation(); expand(); });
      box.appendChild(folded);
      if (collapsed) collapse(); else expand();
      return box;
    }

    // make sure the card for node is rendered (expand collapsed ancestors)
    function reveal(node, side) {
      var chain = [];
      for (var p = node.parent; p; p = p.parent) chain.unshift(p);
      chain.forEach(function (a) { var f = ctx.expanders[side][a.uid]; if (f) f(); });
      return ctx.cards[side][node.uid] || null;
    }

    function select(node, side, fromClick) {
      var otherSide = side === 'old' ? 'new' : 'old';
      var info = ctx.info[side][node.uid];
      var other = info ? info.other : null;
      Array.prototype.forEach.call(wrap.querySelectorAll('.act.selected'), function (x) { x.classList.remove('selected'); });
      var mine = reveal(node, side);
      var theirs = other ? reveal(other, otherSide) : null;
      if (mine) mine.classList.add('selected');
      if (theirs) theirs.classList.add('selected');
      if (!fromClick && mine) scrollInPane(mine);
      if (theirs) scrollInPane(theirs);
      var oldNode = side === 'old' ? node : other;
      var newNode = side === 'new' ? node : other;
      showProps(oldNode, newNode, info);
      ctx.selected = node;
    }

    function scrollInPane(card) {
      var sc = card.closest('.vd-scroll');
      if (!sc) return;
      var top = card.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 40;
      sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    function showProps(oldNode, newNode, info) {
      var box = ctx.props;
      box.textContent = '';
      var n = newNode || oldNode;
      var head = el('div', 'vd-props-head');
      head.appendChild(el('span', 'act-icon', ICONS[n.type] || '◻'));
      head.appendChild(el('span', 'vd-props-title', n.displayName || n.type));
      box.appendChild(head);
      var st = info ? info.status : 'unchanged';
      box.appendChild(el('div', 'vd-props-sub', n.type + (n.typeArg ? '<' + n.typeArg + '>' : '') +
        '  ·  ' + (st === 'unchanged' ? 'no change' : st) + (info && info.moved ? ' · moved' : '') +
        (n.id && n.id.indexOf('__') !== 0 ? '  ·  ' + n.id : '')));

      var rows = [];
      var seen = {};
      function add(name, a, b) {
        if (seen[name]) return;
        seen[name] = 1;
        rows.push({ name: name, a: a, b: b });
      }
      add('DisplayName', oldNode ? oldNode.displayName : null, newNode ? newNode.displayName : null);
      if ((oldNode && oldNode.annotation) || (newNode && newNode.annotation)) {
        add('Annotation', oldNode ? oldNode.annotation : null, newNode ? newNode.annotation : null);
      }
      var names = [];
      [newNode, oldNode].forEach(function (x) {
        if (x) x.props.forEach(function (p) { if (names.indexOf(p.name) < 0) names.push(p.name); });
      });
      names.forEach(function (nm) { add(nm, oldNode ? prop(oldNode, nm) : null, newNode ? prop(newNode, nm) : null); });

      var onlyChanged = el('label', 'vd-props-filter');
      var cb = el('input');
      cb.type = 'checkbox';
      onlyChanged.appendChild(cb);
      onlyChanged.appendChild(document.createTextNode(' Only changed properties'));
      box.appendChild(onlyChanged);

      var table = el('table', 'vd-props-table');
      var th = el('tr');
      ['Property', 'Before', 'After'].forEach(function (h) { th.appendChild(el('th', null, h)); });
      table.appendChild(th);
      rows.forEach(function (r) {
        var changed = (r.a || '') !== (r.b || '') && oldNode && newNode;
        var tr = el('tr', changed ? 'changed' : '');
        tr.appendChild(el('td', 'pn', r.name));
        tr.appendChild(valCell(r.a, !oldNode));
        tr.appendChild(valCell(r.b, !newNode));
        table.appendChild(tr);
      });
      box.appendChild(table);
      cb.addEventListener('change', function () { table.classList.toggle('only-changed', cb.checked); });
    }

    function valCell(v, missing) {
      var td = el('td', 'pv');
      if (missing) { td.appendChild(el('span', 'muted', '—')); return td; }
      td.appendChild(el('pre', null, v === null ? '' : v));
      return td;
    }

    // change navigation: changed new nodes in order, with removed old nodes at their slot position
    var changes = [];
    (function collect(newNode) {
      if (!newNode) return;
      var inf = D.newInfo[newNode.uid];
      if (inf.status !== 'unchanged' || inf.moved) changes.push({ node: newNode, side: 'new' });
      var oldNode = inf.other;
      // union of slot names: a slot can exist only on the old side (all its children deleted)
      var names = newNode.slots.map(function (s) { return s.name; });
      if (oldNode) oldNode.slots.forEach(function (s) { if (names.indexOf(s.name) < 0) names.push(s.name); });
      names.forEach(function (name) {
        if (oldNode) {
          oldNode.slots.forEach(function (os) {
            if (os.name !== name) return;
            os.children.forEach(function (oc) { if (D.oldInfo[oc.uid].status === 'removed') changes.push({ node: oc, side: 'old' }); });
          });
        }
        newNode.slots.forEach(function (s) { if (s.name === name) s.children.forEach(collect); });
      });
    })(B.root);
    if (!B.root && A.root) XamlTree.walk(A.root, function (n) { changes.push({ node: n, side: 'old' }); });

    var pos = -1;
    function go(delta) {
      if (!changes.length) return;
      pos = (pos + delta + changes.length) % changes.length;
      posLbl.textContent = (pos + 1) + ' / ' + changes.length;
      select(changes[pos].node, changes[pos].side, false);
    }
    posLbl.textContent = changes.length ? '– / ' + changes.length : 'no changes';
    prevBtn.disabled = nextBtn.disabled = !changes.length;
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });

    return { element: wrap, counts: D.counts, changes: changes.length };
  }

  root.XamlVisual = { render: render };
})(typeof self !== 'undefined' ? self : this);
