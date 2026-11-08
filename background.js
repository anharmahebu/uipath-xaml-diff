// Opens the viewer tab, either for a GitHub PR or in local-compare mode.

var PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function openViewer(params) {
  var qs = params ? '?' + new URLSearchParams(params).toString() : '';
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html' + qs) });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'openViewer') {
    openViewer({ owner: msg.owner, repo: msg.repo, pr: msg.pr });
  }
});

// Toolbar icon: PR page -> that PR, anywhere else -> local compare.
chrome.action.onClicked.addListener(function (tab) {
  var m = tab && tab.url ? tab.url.match(PR_RE) : null;
  if (m) openViewer({ owner: m[1], repo: m[2], pr: m[3] });
  else openViewer(null);
});
