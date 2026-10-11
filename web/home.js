// The home page: points "Add to Chrome" at the store page set in config.js.
(function () {
  'use strict';

  function start() {
    var config = window.TABFOLD_CONFIG || {};
    var store = '';
    try {
      var url = new URL(String(config.STORE_URL || ''));
      if (url.protocol === 'https:') store = url.href;
    } catch (error) {
      store = '';
    }
    if (!store) return;
    var links = document.querySelectorAll('[data-store-link]');
    for (var i = 0; i < links.length; i++) links[i].href = store;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
