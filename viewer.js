(function () {
  'use strict';

  var API = 'https://api.github.com';
  var state = { files: [], mode: 'changes', view: 'studio' };
  var VIEWS = { studio: 1, sidebyside: 1, text: 1 };

  // ---------- helpers ----------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function setStatus(msg, isError) {
    var s = document.getElementById('status');
    if (!msg) { s.hidden = true; return; }
    s.hidden = false;
    s.textContent = msg;
    s.className = 'status' + (isError ? ' error' : '');
  }

  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function outlineOf(text) {
    if (text === null || text === undefined) return { lines: [], error: null };
    return XamlOutline.xamlToOutline(text, parseXml);
  }

  function isXaml(name) {
    return /\.xaml$/i.test(name);
  }

  function getToken() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ githubToken: '' }, function (v) { resolve(v.githubToken || ''); });
    });
  }

  // ---------- GitHub API ----------

  function apiFetch(token, path, accept) {
    var headers = {
      'Accept': accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(API + path, { headers: headers }).then(function (res) {
      if (res.ok) return accept && accept.indexOf('raw') >= 0 ? res.text() : res.json();
      return res.text().then(function (body) {
        var hint = '';
        if (res.status === 404) hint = token
          ? 'Not found. Check that the token has access to this repository (Contents: Read, Pull requests: Read).'
          : 'Not found. If the repository is private, set a GitHub token in Options.';
        else if (res.status === 401) hint = 'Token is invalid or expired. Update it in Options.';
        else if (res.status === 403) hint = 'Forbidden or rate limited. Set a GitHub token in Options (no-token limit is 60 requests/hour).';
        var err = new Error('GitHub API ' + res.status + ' for ' + path + '\n' + hint + (body ? '\n\n' + body.slice(0, 300) : ''));
        err.status = res.status;
        throw err;
      });
    });
  }

  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  function fetchContent(token, repoFullName, path, ref) {
    return apiFetch(token, '/repos/' + repoFullName + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(ref),
      'application/vnd.github.raw+json');
  }

  function fetchAllFiles(token, base) {
    var all = [];
    function page(n) {
      return apiFetch(token, base + '/files?per_page=100&page=' + n).then(function (list) {
        all = all.concat(list);
        if (list.length === 100 && n < 30) return page(n + 1);
        return all;
      });
    }
    return page(1);
  }

  function loadPullRequest(owner, repo, pr) {
    var token;
    var base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/pulls/' + encodeURIComponent(pr);
    setStatus('Loading pull request #' + pr + ' ...');
    return getToken().then(function (t) {
      token = t;
      return Promise.all([apiFetch(token, base), fetchAllFiles(token, base)]);
    }).then(function (res) {
      var info = res[0];
      var files = res[1];
      renderSummary(info, files, owner, repo);

      var xaml = files.filter(function (f) { return isXaml(f.filename) || (f.previous_filename && isXaml(f.previous_filename)); });
      if (xaml.length === 0) {
        setStatus('This pull request has no .xaml changes.');
        return;
      }
      setStatus('Loading ' + xaml.length + ' XAML file(s) ...');

      var baseRepo = info.base.repo.full_name;
      var headRepo = info.head.repo ? info.head.repo.full_name : null;

      return Promise.all(xaml.map(function (f) {
        var oldPath = f.previous_filename || f.filename;
        var needOld = f.status !== 'added';
        var needNew = f.status !== 'removed';
        var pOld = needOld ? fetchContent(token, baseRepo, oldPath, info.base.sha) : Promise.resolve(null);
        var pNew = !needNew ? Promise.resolve(null)
          : headRepo ? fetchContent(token, headRepo, f.filename, info.head.sha)
          : Promise.reject(new Error('Head repository is no longer available (deleted fork).'));
        return Promise.all([pOld, pNew]).then(function (texts) {
          return { name: f.filename, oldName: f.previous_filename || null, status: f.status, oldText: texts[0], newText: texts[1], error: null };
        }, function (err) {
          return { name: f.filename, oldName: f.previous_filename || null, status: f.status, oldText: null, newText: null, error: err.message };
        });
      })).then(function (loaded) {
        state.files = loaded;
        setStatus(null);
        renderFiles();
      });
    }).catch(function (err) {
      setStatus(err.message, true);
    });
  }

  // ---------- rendering ----------

  function renderSummary(info, files, owner, repo) {
    var s = document.getElementById('summary');
    s.textContent = '';
    var h = el('h1');
    var a = el('a', 'link', info.title + ' #' + info.number);
    a.href = info.html_url;
    a.target = '_blank';
    h.appendChild(a);
    s.appendChild(h);
    s.appendChild(el('div', 'meta',
      owner + '/' + repo + '  ·  ' + info.base.ref + ' ← ' + info.head.label + '  ·  ' + files.length + ' file(s) changed'));
    var other = files.filter(function (f) { return !isXaml(f.filename); }).map(function (f) { return f.filename; });
    if (other.length) {
      s.appendChild(el('div', 'skipped', 'Not shown here (non-XAML, use GitHub diff): ' + other.join(', ')));
    }
    document.title = 'XAML Diff · ' + repo + ' #' + info.number;
  }

  function classify(text) {
    if (/^\/\/ /.test(text)) return 'c-note';
    if (/^[A-Za-z_][\w.]*(<[^>]*>)? "/.test(text) || /^Workflow /.test(text)) return 'c-activity';
    if (/^[A-Za-z]+( \([^)]*\))?:$/.test(text)) return 'c-label';
    return '';
  }

  function indent(depth) {
    return new Array(depth + 1).join('    ');
  }

  function codeCell(line, parts) {
    var td = el('td', 'code');
    var span = el('span', classify(line.text));
    span.appendChild(document.createTextNode(indent(line.depth)));
    if (parts && parts[1]) {
      span.appendChild(document.createTextNode(parts[0]));
      span.appendChild(el('mark', null, parts[1]));
      span.appendChild(document.createTextNode(parts[2]));
    } else {
      span.appendChild(document.createTextNode(line.text));
    }
    td.appendChild(span);
    return td;
  }

  function row(type, aNo, bNo, line, parts) {
    var tr = el('tr', type === 'eq' ? '' : type);
    tr.appendChild(el('td', 'ln', aNo === null ? '' : String(aNo + 1)));
    tr.appendChild(el('td', 'ln', bNo === null ? '' : String(bNo + 1)));
    tr.appendChild(el('td', 'sign', type === 'ins' ? '+' : type === 'del' ? '−' : ''));
    tr.appendChild(codeCell(line, parts));
    return tr;
  }

  function sepRow(text) {
    var tr = el('tr', 'sep');
    var td = el('td', null, text);
    td.colSpan = 4;
    tr.appendChild(td);
    return tr;
  }

  // Fixed column widths: with table-layout:fixed the first row decides widths,
  // and a colspan separator row would otherwise split them evenly.
  function diffTable() {
    var table = el('table', 'diff');
    var cg = el('colgroup');
    ['col-ln', 'col-ln', 'col-sign', 'col-code'].forEach(function (c) { cg.appendChild(el('col', c)); });
    table.appendChild(cg);
    return table;
  }

  function renderDiffTable(oldLines, newLines, ops) {
    var table = diffTable();
    var tbody = el('tbody');
    table.appendChild(tbody);
    var hunks = XamlDiff.buildHunks(ops, state.mode === 'full' ? Infinity : 3);
    var prevEnd = 0;

    hunks.forEach(function (h) {
      if (h.start > prevEnd) tbody.appendChild(sepRow('⋯ ' + (h.start - prevEnd) + ' unchanged line(s)'));
      var i = h.start;
      while (i < h.end) {
        var op = ops[i];
        if (op.type === 'eq') {
          tbody.appendChild(row('eq', op.a, op.b, oldLines[op.a]));
          i++;
          continue;
        }
        // change block: dels then ins (diff.js reorders them); pair them for inline highlight
        var dels = [], ins = [];
        while (i < h.end && ops[i].type === 'del') dels.push(ops[i++]);
        while (i < h.end && ops[i].type === 'ins') ins.push(ops[i++]);
        var pairs = Math.min(dels.length, ins.length);
        var splits = [];
        for (var p = 0; p < pairs; p++) {
          var ol = oldLines[dels[p].a], nl = newLines[ins[p].b];
          splits.push(ol.depth === nl.depth ? XamlDiff.inlineSplit(ol.text, nl.text) : null);
        }
        dels.forEach(function (d, k) { tbody.appendChild(row('del', d.a, null, oldLines[d.a], splits[k] ? splits[k].old : null)); });
        ins.forEach(function (n, k) { tbody.appendChild(row('ins', null, n.b, newLines[n.b], splits[k] ? splits[k].new : null)); });
      }
      prevEnd = h.end;
    });
    if (hunks.length && prevEnd < ops.length) tbody.appendChild(sepRow('⋯ ' + (ops.length - prevEnd) + ' unchanged line(s)'));
    return table;
  }

  function renderFile(f) {
    var box = el('div', 'file');
    var head = el('div', 'file-head');
    box.appendChild(head);
    head.appendChild(el('span', 'name', f.oldName && f.oldName !== f.name ? f.oldName + ' → ' + f.name : f.name));
    if (f.status && f.status !== 'modified') head.appendChild(el('span', 'badge ' + f.status, f.status));

    var body = el('div', 'file-body');
    box.appendChild(body);
    head.addEventListener('click', function () { box.classList.toggle('collapsed'); });

    if (f.error) {
      body.appendChild(el('div', 'parse-error', f.error));
      return box;
    }

    if (state.view === 'studio' || state.view === 'sidebyside') {
      var v = state.view === 'studio'
        ? XamlStudio.render(f, parseXml, { mode: state.mode })
        : XamlVisual.render(f, state.mode, parseXml);
      if (v.counts) {
        var c = v.counts;
        var parts = [];
        if (c.added) parts.push(['stat-add', c.added + ' added']);
        if (c.modified) parts.push(['stat-mod', c.modified + ' changed']);
        if (c.removed) parts.push(['stat-del', c.removed + ' removed']);
        if (c.moved) parts.push(['stat-mov', c.moved + ' moved']);
        if (!parts.length) parts.push(['muted', 'no logical change']);
        parts.forEach(function (p) { head.appendChild(el('span', p[0], p[1])); });
      }
      body.appendChild(v.element);
      return box;
    }

    var o = outlineOf(f.oldText);
    var n = outlineOf(f.newText);
    if (o.error || n.error) {
      body.appendChild(el('div', 'parse-error', (o.error ? 'Before: ' + o.error + '  ' : '') + (n.error ? 'After: ' + n.error : '')));
      return box;
    }

    var ops = XamlDiff.diffLines(o.lines, n.lines);
    var st = XamlDiff.stats(ops);
    head.appendChild(el('span', 'stat-add', '+' + st.added));
    head.appendChild(el('span', 'stat-del', '−' + st.removed));

    if (st.added === 0 && st.removed === 0) {
      body.appendChild(el('div', 'empty', 'No logical change (only designer layout / formatting changed).'));
      if (state.mode === 'full') {
        // show the whole outline as unchanged lines
        var t = diffTable();
        var tb = el('tbody');
        t.appendChild(tb);
        ops.forEach(function (op) { tb.appendChild(row('eq', op.a, op.b, o.lines[op.a])); });
        body.appendChild(t);
      }
      return box;
    }

    body.appendChild(renderDiffTable(o.lines, n.lines, ops));
    return box;
  }

  function renderFiles() {
    var root = document.getElementById('files');
    root.textContent = '';
    state.files.forEach(function (f) { root.appendChild(renderFile(f)); });
  }

  // ---------- local compare ----------

  function readFile(input) {
    var file = input.files && input.files[0];
    if (!file) return Promise.resolve(null);
    return file.text().then(function (t) { return { name: file.name, text: t }; });
  }

  function setupLocal() {
    document.getElementById('local').hidden = false;
    document.getElementById('summary').appendChild(el('div', 'meta',
      'Open a GitHub pull request page and click the "XAML Diff" button, or compare local files below.'));
    document.getElementById('btnCompare').addEventListener('click', function () {
      Promise.all([readFile(document.getElementById('fileOld')), readFile(document.getElementById('fileNew'))]).then(function (r) {
        var a = r[0], b = r[1];
        if (!a && !b) { setStatus('Pick at least one file.', true); return; }
        setStatus(null);
        var status = !a ? 'added' : !b ? 'removed' : 'modified';
        var name = a && b && a.name !== b.name ? a.name + ' → ' + b.name : (b || a).name;
        state.files = [{ name: name, oldName: null, status: status, oldText: a ? a.text : null, newText: b ? b.text : null, error: null }];
        renderFiles();
      });
    });
  }

  // ---------- init ----------

  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () {
      state.mode = r.value;
      if (state.files.length) renderFiles();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name="view"]'), function (r) {
    r.addEventListener('change', function () {
      state.view = r.value;
      chrome.storage.local.set({ viewMode: r.value });
      if (state.files.length) renderFiles();
    });
  });

  // remember Visual / Text choice
  chrome.storage.local.get({ viewMode: 'studio' }, function (v) {
    state.view = VIEWS[v.viewMode] ? v.viewMode : 'studio';
    var r = document.querySelector('input[name="view"][value="' + state.view + '"]');
    if (r) r.checked = true;
    if (state.files.length) renderFiles();
  });

  var params = new URLSearchParams(location.search);
  if (params.get('owner') && params.get('repo') && params.get('pr')) {
    loadPullRequest(params.get('owner'), params.get('repo'), params.get('pr'));
  } else {
    setupLocal();
  }
})();
