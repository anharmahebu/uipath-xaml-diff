// Adds a floating "XAML Diff" button on GitHub pull request pages.
// Only the URL is used (no GitHub DOM selectors), so layout changes do not break it.
(function () {
  'use strict';

  var PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/|$)/;
  var BTN_ID = 'uipath-xaml-diff-btn';

  function current() {
    var m = location.pathname.match(PR_PATH);
    return m ? { owner: m[1], repo: m[2], pr: m[3] } : null;
  }

  function ensureButton() {
    var pr = current();
    var btn = document.getElementById(BTN_ID);
    if (!pr) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.textContent = 'XAML Diff';
      btn.title = 'Open readable UiPath XAML diff for this pull request';
      btn.addEventListener('click', function () {
        var p = current();
        if (p) chrome.runtime.sendMessage({ type: 'openViewer', owner: p.owner, repo: p.repo, pr: p.pr });
      });
      document.body.appendChild(btn);
    }
  }

  ensureButton();
  // GitHub navigates without full page loads; re-check periodically and on history events.
  setInterval(ensureButton, 1000);
  window.addEventListener('popstate', ensureButton);
  document.addEventListener('turbo:load', ensureButton);
})();
