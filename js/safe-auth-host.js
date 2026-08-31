/**
 * Validation for the `authHost` parameter used by the one-shot authState
 * exchange (DEV-1633).
 *
 * Lives in its own file, and takes the app's API origin as an argument rather
 * than reading it from the widget scope, so it is a pure function that can be
 * exercised directly by test/safe-auth-host.test.js. js/build.js cannot be
 * loaded outside a browser (it calls Fliplet.Widget.instance at module scope),
 * and this is the one piece of that file that most needs committed coverage:
 * a missing allowlist here was one of the two blocking findings that caused
 * the original DEV-1572 revert.
 */
(function(root, factory) {
  var api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.FlipletLoginAuthHost = api;
  }
}(typeof self !== 'undefined' ? self : this, function() {
  /**
   * Validates `authHost` before it is ever used as a request target.
   *
   * On the same-tab leg authHost arrives on the page query string, which the
   * user (or anyone who can get them to open a crafted link) controls. The
   * exchange sends the session's Authorization header to that host and feeds
   * the response straight into handleAuthSuccess — which shape-validates the
   * user but cannot validate its authenticity. An unvalidated host therefore
   * buys an attacker both credential exfiltration and session fixation, so
   * anything not provably Fliplet-owned is discarded and the caller falls
   * back to the app's own API host (same-region behaviour).
   *
   * @param {String} value - untrusted authHost from the query string
   * @param {String} appOrigin - the app's own API origin (trusted)
   * @returns {String|null} the accepted origin, or null to fall back
   */
  function safeAuthHost(value, appOrigin) {
    if (!value || !appOrigin) return null;

    try {
      var u = new URL(value);
      var app = new URL(appOrigin);

      // The app's own API origin is always accepted: it is the fallback target
      // regardless, and on dev environments / local stacks it is not a
      // fliplet.com host (e.g. https://api.fliplet.test).
      if (u.origin === app.origin) return u.origin;

      // Every rule below matches on u.hostname, which carries no port, while
      // the function returns u.origin, which does. Without this an attacker
      // who satisfies a hostname rule can still redirect the redemption to an
      // arbitrary port on that host (https://api.fliplet.com:31337).
      if (u.port !== '' && u.port !== app.port) return null;

      // Production and staging regional API hosts. The legitimate target set
      // is small and known — api.fliplet.com plus one label per region
      // (us.api, ca.api, staging.api, staging-us.api…) — so this matches those
      // rather than all of *.fliplet.com, which would also cover
      // apps.fliplet.com and the 13 *.studio-apps.fliplet.com origins. This
      // call carries the Authorization header and feeds handleAuthSuccess, so
      // the narrower set is worth the specificity. New regions are covered
      // automatically.
      //
      // Matching on the parsed hostname (not the raw string) means
      // "https://evil.com/?x=.fliplet.com" and "https://fliplet.com.evil.com"
      // both fail. The optional label must end in a dot, so "xapi.fliplet.com"
      // fails too.
      // The cdn[.-] exclusion is load-bearing, not defensive padding. The CDN
      // origins in config/production.json are cdn.api.fliplet.com and
      // cdn-staging.api.fliplet.com — a single label under api.fliplet.com,
      // structurally identical to a region. Without the lookahead they satisfy
      // this rule and receive the Authorization header. Their regional
      // siblings (us.cdn / ca.cdn) carry two labels and are already excluded.
      if (u.protocol === 'https:' && /^(?!cdn[.-])([a-z0-9-]+\.)?api\.fliplet\.com$/i.test(u.hostname)) {
        return u.origin;
      }

      // Regional siblings of the app's own API host, for dev environments and
      // local stacks whose regions are NOT fliplet.com hosts — e.g.
      // us.api.fliplet.test alongside api.fliplet.test. Without this the US
      // host is rejected off-production and the exchange silently falls back
      // to the app's own (wrong-region) host, which masks cross-region bugs in
      // exactly the environments used to test for them.
      //
      // Deliberately scoped OFF production. On fliplet.com the rule above is
      // the whole allowlist, and this one would undo its narrowness: the real
      // CDN origins in config/production.json (cdn.api.fliplet.com,
      // us.cdn.api.fliplet.com, ca.cdn.api.fliplet.com) are all subdomains of
      // api.fliplet.com, so a bare suffix check hands them the Authorization
      // header — the exact shape the rule above exists to prevent.
      //
      // Exactly ONE label, so it cannot walk down an arbitrary depth of
      // subdomains, and the suffix is derived from the app's own host, so a
      // crafted authHost cannot widen it. It never falls back to a
      // registrable-domain guess (which would wrongly allow any *.co.uk for a
      // custom domain on a public suffix).
      if (u.protocol === app.protocol
        && !/(^|\.)fliplet\.com$/i.test(app.hostname)
        && /^[a-z0-9-]+$/i.test(u.hostname.slice(0, Math.max(0, u.hostname.length - app.hostname.length - 1)))
        && u.hostname.length > app.hostname.length
        && u.hostname.slice(-(app.hostname.length + 1)) === '.' + app.hostname) {
        return u.origin;
      }

      return null;
    } catch (err) {
      return null;
    }
  }

  return { safeAuthHost: safeAuthHost };
}));
