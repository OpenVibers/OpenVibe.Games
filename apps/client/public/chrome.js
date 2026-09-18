/**
 * OpenVibe.Games — the shared network chrome (navbar + footer) on every page.
 *
 * The navbar and footer themselves come from openvibe.network/shared/*.js,
 * loaded by each page's <head>; this file only tells them who we are: the
 * site's links, where sign-in/sign-out live, and the session the game keeps
 * in the `ovg_sso` cookie / localStorage entry (set by /auth/callback).
 *
 * Pages configure it with `window.__ovgChrome = { page, title, collapsible }`
 * before this script runs:
 *   page         'portal' | 'play' | 'editor'
 *   title        recorded to the signed-in user's network history (play only)
 *   collapsible  the chrome folds away once the game starts (the `ovg:playing`
 *                event) and a small floating button brings it back.
 *   toggleFromStart  show that button immediately (the editor), not only after
 *                `ovg:playing`.
 */
;(function () {
  'use strict'
  var NETWORK = 'https://openvibe.network'
  var cfg = window.__ovgChrome || {}
  var local = ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1
  var onPlayHost = location.hostname.indexOf('play.') === 0
  var PORTAL = local || !onPlayHost ? '/' : 'https://openvibe.games/'
  var PLAY = local ? '/play' : onPlayHost ? '/' : 'https://play.openvibe.games/'
  var EDITOR = local || !onPlayHost ? '/editor' : 'https://openvibe.games/editor'

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
    try {
      return m ? decodeURIComponent(m[1]) : null
    } catch (e) {
      return m ? m[1] : null
    }
  }
  /** The openvibe.network access token this site holds, if any. */
  function sessionToken() {
    var t = null
    try {
      t = localStorage.getItem('ovg_sso')
    } catch (e) {
      /* storage unavailable */
    }
    return t || cookie('ovg_sso') || undefined
  }

  var here = location.pathname + location.search
  var links = [
    { label: 'Games', href: PORTAL },
    { label: 'Scraplandia', href: PLAY },
  ]
  var footerLinks = [
    {
      heading: 'Games',
      items: [
        { label: 'All games', href: PORTAL },
        { label: 'Play Scraplandia', href: PLAY },
        { label: 'Map editor', href: EDITOR },
      ],
    },
    {
      heading: 'Account',
      items: [
        { label: 'Sign in', href: '/auth/login?next=' + encodeURIComponent(here) },
        { label: 'Sign out', href: '/auth/logout?next=' + encodeURIComponent(location.pathname) },
        { label: 'Themes', href: NETWORK + '/themes' },
      ],
    },
  ]

  function initNavbar() {
    var opts = {
      service: 'games',
      apiBase: NETWORK,
      token: sessionToken(),
      // Same-origin fallback: resolves the ovg_sso cookie server-side when the
      // token is not readable here (or the Network rejects it client-side).
      sessionUrl: '/auth/me',
      loginUrl: '/auth/login?next=' + encodeURIComponent(here),
      onLogout: function () {
        location.href = '/auth/logout?next=' + encodeURIComponent(location.pathname)
      },
      links: links,
      menu: { after: [{ label: 'Map editor', href: EDITOR, icon: 'fa-map' }] },
      // One prompt=none attempt per tab when the browser says it has an OpenVibe account.
      silentLogin: '/auth/login?silent=1&next={url}',
    }
    if (cfg.page === 'play') opts.history = { type: 'game', title: cfg.title || 'Scraplandia' }
    window.OpenVibeNavbar.init(opts)
  }

  function initFooter() {
    if (!document.getElementById('ov-footer')) return
    window.OpenVibeFooter.init({
      service: 'games',
      variant: cfg.page === 'portal' ? 'full' : 'compact',
      links: footerLinks,
      mount: '#ov-footer',
    })
  }

  // ── Collapsible chrome for the game / editor pages ─────────────────────
  // The canvas is sized by CSS below the navbar, so showing or hiding the
  // chrome is a class flip plus a resize event for the engine.
  function setupCollapse() {
    var stage = document.getElementById('stage')
    if (!stage) return
    var btn = document.createElement('button')
    btn.id = 'ovg-chrome-toggle'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Show or hide the OpenVibe navigation')
    btn.innerHTML = '<span class="ovg-chrome-toggle-mark">☰</span> OpenVibe'
    // The game page reveals it once play starts; the editor has it from the start.
    btn.hidden = !cfg.toggleFromStart
    function apply(hidden) {
      document.body.classList.toggle('ovg-chrome-hidden', hidden)
      btn.classList.toggle('is-hidden', hidden)
      btn.title = hidden ? 'Show the OpenVibe navigation' : 'Hide the OpenVibe navigation'
      window.dispatchEvent(new Event('resize'))
    }
    btn.addEventListener('click', function () {
      apply(!document.body.classList.contains('ovg-chrome-hidden'))
    })
    stage.appendChild(btn)
    window.addEventListener('ovg:playing', function () {
      btn.hidden = false
      apply(true)
    })
  }

  var tries = 0
  function boot() {
    if (!window.OpenVibeNavbar || !window.OpenVibeFooter) {
      // The shared scripts are deferred; if the Network is unreachable the
      // page simply runs without its chrome.
      if (++tries < 60) setTimeout(boot, 100)
      return
    }
    try {
      initNavbar()
    } catch (e) {
      /* navbar optional */
    }
    try {
      initFooter()
    } catch (e) {
      /* footer optional */
    }
  }
  if (cfg.collapsible) setupCollapse()
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
