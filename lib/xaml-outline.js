/*
 * xaml-outline.js
 * Turns a UiPath XAML document into a readable, diff-friendly outline.
 *
 * The output is an array of { depth, text } lines. Designer noise is dropped:
 * ViewState, HintSize, IdRef, namespace/reference lists, xmlns, {x:Null}.
 *
 * Uses only basic DOM properties (nodeType, nodeName, attributes, childNodes),
 * so it works with the browser DOMParser and with @xmldom/xmldom in Node.
 */
(function (root) {
  'use strict';

  var ELEMENT = 1;
  var TEXT = 3;
  var CDATA = 4;

  // Elements that are pure designer / compiler noise.
  var NOISE_ELEMENT_SUFFIXES = [
    'WorkflowViewStateService.ViewState',
    'VirtualizedContainerService.HintSize',
    'WorkflowViewState.IdRef',
    'TextExpression.NamespacesForImplementation',
    'TextExpression.ReferencesForImplementation',
    'TextExpression.Namespaces',
    'TextExpression.References',
    'VisualBasic.Settings'
  ];

  // Attributes that are noise (matched against the full attribute name).
  function isNoiseAttr(name, value) {
    if (name === 'xmlns' || name.indexOf('xmlns:') === 0) return true;
    if (name === 'mc:Ignorable') return true;
    if (/WorkflowViewState\.IdRef$/.test(name)) return true;
    if (/HintSize$/.test(name)) return true;
    if (/VisualBasic\.Settings$/.test(name)) return true;
    if (value === '{x:Null}') return true;
    return false;
  }

  // Collection wrappers that are rendered transparently (children only).
  var TRANSPARENT = { 'List': 1, 'Collection': 1, 'Dictionary': 1 };

  // Argument-like elements whose content is an expression.
  var ARG_DIR = { 'InArgument': 'in', 'OutArgument': 'out', 'InOutArgument': 'io' };

  function localName(node) {
    var n = node.nodeName;
    var i = n.indexOf(':');
    return i >= 0 ? n.substring(i + 1) : n;
  }

  function isNoiseElement(node) {
    var n = node.nodeName;
    for (var i = 0; i < NOISE_ELEMENT_SUFFIXES.length; i++) {
      var s = NOISE_ELEMENT_SUFFIXES[i];
      if (n === s || n.slice(-s.length - 1) === '.' + s || n.slice(-s.length - 1) === ':' + s) return true;
    }
    return false;
  }

  function elementChildren(node) {
    var out = [];
    var c = node.childNodes;
    for (var i = 0; i < c.length; i++) {
      if (c[i].nodeType === ELEMENT && !isNoiseElement(c[i])) out.push(c[i]);
    }
    return out;
  }

  function ownText(node) {
    var s = '';
    var c = node.childNodes;
    for (var i = 0; i < c.length; i++) {
      if (c[i].nodeType === TEXT || c[i].nodeType === CDATA) s += c[i].nodeValue;
    }
    return s;
  }

  function attr(node, name) {
    var a = node.attributes;
    for (var i = 0; i < a.length; i++) if (a[i].name === name) return a[i].value;
    return null;
  }

  function isPropertyElement(node) {
    return localName(node).indexOf('.') >= 0;
  }

  function propName(node) {
    var l = localName(node);
    return l.substring(l.lastIndexOf('.') + 1);
  }

  // Strip common indentation and trailing spaces from a multi-line string.
  function dedentLines(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    var min = Infinity;
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      var m = lines[i].match(/^[ \t]*/)[0].length;
      if (m < min) min = m;
    }
    if (min === Infinity) min = 0;
    return lines.map(function (l, idx) {
      l = l.replace(/\s+$/, '');
      return idx === 0 ? l.trim() : l.substring(Math.min(min, l.match(/^[ \t]*/)[0].length));
    });
  }

  // A UiPath value: "[expr]" is a VB/C# expression, anything else is a literal.
  function formatValue(raw) {
    if (raw === null || raw === undefined) return [''];
    var v = String(raw);
    var t = v.trim();
    if (t.length >= 2 && t.charAt(0) === '[' && t.charAt(t.length - 1) === ']') {
      return dedentLines(t.substring(1, t.length - 1));
    }
    var lines = dedentLines(v);
    if (lines.length === 0) return ['""'];
    lines[0] = '"' + lines[0];
    lines[lines.length - 1] = lines[lines.length - 1] + '"';
    return lines;
  }

  // Expression carried by an argument element (InArgument, Literal, VisualBasicValue, ...).
  function argumentExpression(node) {
    var kids = elementChildren(node);
    if (kids.length === 0) return formatValue(ownText(node));
    var k = kids[0];
    var ln = localName(k);
    if (/^(VisualBasicValue|VisualBasicReference|CSharpValue|CSharpReference)$/.test(ln)) {
      return dedentLines(attr(k, 'ExpressionText') || '');
    }
    if (ln === 'Literal') {
      var lv = attr(k, 'Value');
      return lv === null ? formatValue(ownText(k)) : formatValue(lv);
    }
    return null; // complex content, caller renders it as a tree
  }

  function typeLabel(node) {
    var t = localName(node).replace(/`\d+$/, '');
    var ta = attr(node, 'x:TypeArguments');
    return ta ? t + '<' + ta + '>' : t;
  }

  function Outline() {
    this.lines = [];
  }

  Outline.prototype.push = function (depth, text) {
    this.lines.push({ depth: depth, text: text });
  };

  // "label = value" where value may span several lines.
  Outline.prototype.pushValue = function (depth, label, valueLines) {
    if (!valueLines || valueLines.length === 0) valueLines = [''];
    this.push(depth, label + valueLines[0]);
    for (var i = 1; i < valueLines.length; i++) this.push(depth + 2, valueLines[i]);
  };

  Outline.prototype.renderArgument = function (node, depth, labelOverride) {
    var dir = ARG_DIR[localName(node)];
    var key = attr(node, 'x:Key');
    var label = labelOverride !== undefined ? labelOverride
      : (key ? (dir ? dir + ' ' : '') + key + ' = ' : (dir ? dir + ': ' : ''));
    var expr = argumentExpression(node);
    if (expr) {
      this.pushValue(depth, label, expr);
    } else {
      this.push(depth, label.replace(/ = $/, ':').replace(/: $/, ':') || typeLabel(node) + ':');
      this.renderChildren(node, depth + 1);
    }
  };

  Outline.prototype.renderChildren = function (node, depth) {
    var kids = elementChildren(node);
    for (var i = 0; i < kids.length; i++) this.renderNode(kids[i], depth);
    if (kids.length === 0) {
      var t = ownText(node).trim();
      if (t) this.pushValue(depth, '', formatValue(t));
    }
  };

  Outline.prototype.renderProperty = function (node, depth) {
    var name = propName(node);
    var kids = elementChildren(node);

    if (name === 'Variables') {
      for (var i = 0; i < kids.length; i++) {
        var v = kids[i];
        var def = attr(v, 'Default');
        var line = 'var ' + (attr(v, 'Name') || '?') + ': ' + (attr(v, 'x:TypeArguments') || '?');
        if (def !== null) this.pushValue(depth, line + ' = ', formatValue(def));
        else this.push(depth, line);
      }
      return;
    }

    // Text-only property, e.g. <Foo.Bar>value</Foo.Bar>
    if (kids.length === 0) {
      this.pushValue(depth, name + ' = ', formatValue(ownText(node)));
      return;
    }

    // Single argument / literal value, e.g. <Assign.To><OutArgument>[x]</OutArgument></Assign.To>
    if (kids.length === 1 && (ARG_DIR[localName(kids[0])] || /^(Literal|VisualBasicValue|VisualBasicReference|CSharpValue|CSharpReference)$/.test(localName(kids[0])))
        && attr(kids[0], 'x:Key') === null) {
      var e = ARG_DIR[localName(kids[0])] ? argumentExpression(kids[0]) : argumentExpression(node);
      if (e) { this.pushValue(depth, name + ' = ', e); return; }
    }

    // Delegate body, e.g. <ForEach.Body><ActivityAction>...</ActivityAction></ForEach.Body>
    if (kids.length === 1 && /^ActivityAction|^ActivityFunc/.test(localName(kids[0]))) {
      var action = kids[0];
      var params = [];
      var body = [];
      var ak = elementChildren(action);
      for (var j = 0; j < ak.length; j++) {
        if (isPropertyElement(ak[j]) && /\.(Argument\d*|Result)$/.test(localName(ak[j]))) {
          var da = elementChildren(ak[j]);
          for (var d = 0; d < da.length; d++) {
            params.push((attr(da[d], 'Name') || '?') + ': ' + (attr(da[d], 'x:TypeArguments') || '?'));
          }
        } else {
          body.push(ak[j]);
        }
      }
      this.push(depth, name + (params.length ? ' (' + params.join(', ') + ')' : '') + ':');
      for (var b = 0; b < body.length; b++) this.renderNode(body[b], depth + 1);
      return;
    }

    this.push(depth, name + ':');
    for (var k = 0; k < kids.length; k++) this.renderNode(kids[k], depth + 1);
  };

  Outline.prototype.renderAssignOperation = function (node, depth) {
    var to = null, value = null;
    var kids = elementChildren(node);
    for (var i = 0; i < kids.length; i++) {
      var p = propName(kids[i]);
      var a = elementChildren(kids[i])[0];
      if (!a) continue;
      if (p === 'To') to = argumentExpression(a);
      if (p === 'Value') value = argumentExpression(a);
    }
    if (to && value) {
      this.pushValue(depth, to.join(' ') + ' = ', value);
    } else {
      this.push(depth, 'AssignOperation:');
      this.renderChildren(node, depth + 1);
    }
  };

  Outline.prototype.renderActivity = function (node, depth) {
    var ln = localName(node).replace(/`\d+$/, '');

    if (TRANSPARENT[ln]) { this.renderChildren(node, depth); return; }
    if (ln === 'AssignOperation') { this.renderAssignOperation(node, depth); return; }
    if (ARG_DIR[ln] || ln === 'Literal') { this.renderArgument(node, depth); return; }

    var display = attr(node, 'DisplayName');
    var header = typeLabel(node) + (display !== null ? ' "' + display + '"' : '');
    this.push(depth, header);

    var note = attr(node, 'sap2010:Annotation.AnnotationText') || attr(node, 'sap:Annotation.AnnotationText');
    if (note) {
      var nl = dedentLines(note);
      this.push(depth + 1, '// ' + nl[0]);
      for (var n = 1; n < nl.length; n++) this.push(depth + 1, '// ' + nl[n]);
    }

    var a = node.attributes;
    for (var i = 0; i < a.length; i++) {
      var name = a[i].name;
      if (name === 'DisplayName' || name === 'x:TypeArguments' || /Annotation\.AnnotationText$/.test(name)) continue;
      if (isNoiseAttr(name, a[i].value)) continue;
      this.pushValue(depth + 1, name + ' = ', formatValue(a[i].value));
    }

    var kids = elementChildren(node);
    for (var k = 0; k < kids.length; k++) {
      var c = kids[k];
      if (isPropertyElement(c)) this.renderProperty(c, depth + 1);
      else this.renderNode(c, depth + 1);
    }
    if (kids.length === 0) {
      var t = ownText(node).trim();
      if (t) this.pushValue(depth + 1, '', formatValue(t));
    }
  };

  Outline.prototype.renderNode = function (node, depth) {
    if (isNoiseElement(node)) return;
    if (isPropertyElement(node)) this.renderProperty(node, depth);
    else this.renderActivity(node, depth);
  };

  Outline.prototype.renderRoot = function (rootEl) {
    var cls = attr(rootEl, 'x:Class');
    this.push(0, 'Workflow ' + (cls || localName(rootEl)));
    var kids = elementChildren(rootEl);
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (localName(c) === 'Members') {
        var props = elementChildren(c);
        if (props.length) this.push(1, 'Arguments:');
        for (var p = 0; p < props.length; p++) {
          this.push(2, (attr(props[p], 'Name') || '?') + ': ' + (attr(props[p], 'Type') || '?'));
        }
      } else if (isPropertyElement(c)) {
        this.renderProperty(c, 1);
      } else {
        this.renderNode(c, 1);
      }
    }
  };

  /**
   * Parse XAML text into outline lines.
   * @param {string} xamlText
   * @param {function(string): Document} parse  e.g. s => new DOMParser().parseFromString(s, 'application/xml')
   * @returns {{lines: Array<{depth:number,text:string}>, error: (string|null)}}
   */
  function xamlToOutline(xamlText, parse) {
    var text = String(xamlText || '').replace(/^﻿/, '');
    if (text.trim() === '') return { lines: [], error: null };
    var doc;
    try {
      doc = parse(text);
    } catch (e) {
      return { lines: [], error: 'XML parse error: ' + (e && e.message ? e.message : e) };
    }
    var rootEl = doc && doc.documentElement;
    if (!rootEl || localName(rootEl) === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
      return { lines: [], error: 'XML parse error: file is not valid XAML/XML.' };
    }
    var o = new Outline();
    o.renderRoot(rootEl);
    return { lines: o.lines, error: null };
  }

  function outlineToText(lines, indent) {
    indent = indent || '  ';
    return lines.map(function (l) { return new Array(l.depth + 1).join(indent) + l.text; }).join('\n');
  }

  // Render any element subtree as outline text (used for complex property values).
  function elementToText(node) {
    var o = new Outline();
    o.renderNode(node, 0);
    return outlineToText(o.lines);
  }

  var api = {
    xamlToOutline: xamlToOutline,
    outlineToText: outlineToText,
    elementToText: elementToText,
    helpers: {
      localName: localName,
      attr: attr,
      elementChildren: elementChildren,
      ownText: ownText,
      isNoiseAttr: isNoiseAttr,
      isPropertyElement: isPropertyElement,
      propName: propName,
      dedentLines: dedentLines,
      formatValue: formatValue,
      argumentExpression: argumentExpression,
      ARG_DIR: ARG_DIR,
      TRANSPARENT: TRANSPARENT
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XamlOutline = api;
})(typeof self !== 'undefined' ? self : this);
