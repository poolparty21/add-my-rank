'use strict';

/**
 * Loads Vercel Web Analytics only on the public production host.
 *
 * Vercel serves /_vercel/insights/script.js once Web Analytics is enabled for
 * the project. Local previews and branch deployments stay untracked.
 */
(function () {
  var host = location.hostname;
  var production = host === 'add-my-rank.vercel.app' || host === 'addmyrank.com' || host === 'www.addmyrank.com';
  if (!production) return;

  window.va = window.va || function () {
    (window.vaq = window.vaq || []).push(arguments);
  };

  var script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  document.head.appendChild(script);
})();
