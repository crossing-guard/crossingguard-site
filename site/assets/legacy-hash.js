// Links shared before the site had real pages point at Home with a fragment
// that now lives on /agents/. Forward those three; everything else is untouched.
(function () {
  var moved = { '#spontaneous-memory': 1, '#agent-roles': 1, '#framework-configuration': 1 };
  if (moved[window.location.hash]) window.location.replace('/agents/' + window.location.hash);
})();
