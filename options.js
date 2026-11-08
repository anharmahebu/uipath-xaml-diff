(function () {
  'use strict';

  var input = document.getElementById('token');
  var msg = document.getElementById('msg');

  function show(text, ok) {
    msg.textContent = text;
    msg.className = ok ? 'ok' : 'err';
  }

  chrome.storage.local.get({ githubToken: '' }, function (v) {
    input.value = v.githubToken || '';
  });

  document.getElementById('save').addEventListener('click', function () {
    chrome.storage.local.set({ githubToken: input.value.trim() }, function () { show('Saved.', true); });
  });

  document.getElementById('clear').addEventListener('click', function () {
    input.value = '';
    chrome.storage.local.remove('githubToken', function () { show('Token removed.', true); });
  });

  document.getElementById('test').addEventListener('click', function () {
    var token = input.value.trim();
    if (!token) { show('Enter a token first.', false); return; }
    show('Testing ...', true);
    fetch('https://api.github.com/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    }).then(function (res) {
      if (res.ok) return res.json().then(function (u) { show('Token works. Signed in as ' + u.login + '. Remember to click Save.', true); });
      show('GitHub returned ' + res.status + '. The token is invalid or expired.', false);
    }).catch(function (e) { show('Request failed: ' + e.message, false); });
  });
})();
