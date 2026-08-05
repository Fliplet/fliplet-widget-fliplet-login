Fliplet.Widget.instance('login', function(data) {
  var _this = this;

  /**
   * LOGIN_FLAG_KEY flag will be utilized by App List component to
   * identify whether user has navigated from fliplet login screen
   */
  var LOGIN_FLAG_KEY = 'login_flag';

  /**
   * Fliplet.App.Storage key where the signed-in Fliplet user's details
   * are persisted. Used as the source of truth for "is the user signed
   * in to this app" on subsequent page loads.
   */
  var FLIPLET_LOGIN_STORAGE_KEY = 'fliplet_login_component';

  _this.$container = $(this);
  _this.data = data;

  // Do not track login related redirects
  if (typeof _this.data.action !== 'undefined') {
    _this.data.action.track = false;
  }

  document.addEventListener('offline', function() {
    _this.$container.addClass('login-offline');
    scheduleCheck();
  });

  if (Fliplet.Navigate.query.error) {
    // .text(), never .html(): the error is a URL query param, so .html()
    // would be a reflected XSS sink on every app's login screen.
    _this.$container.find('.login-error-holder').text(Fliplet.Navigate.query.error).addClass('show');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  function scheduleCheck() {
    setTimeout(function() {
      if (Fliplet.Navigator.isOnline()) {
        _this.$container.removeClass('login-offline');

        return;
      }

      scheduleCheck();
    }, 500);
  }

  function showStart() {
    setTimeout(function() {
      var $loginHolder = _this.$container.find('.login-loader-holder');

      $loginHolder.fadeOut(100, function() {
        _this.$container.find('.content-wrapper').show();
      });
    }, 100);
  }

  function getApiHost() {
    // Inside a published Fliplet app, Fliplet.Env.get('apiUrl') can return
    // an apps-host-proxied URL which doesn't serve the /v1/auth/* routes.
    // primaryApiUrl is the canonical API host — prefer it when available.
    return Fliplet.Env.get('primaryApiUrl') || Fliplet.Env.get('apiUrl');
  }

  function getApiOrigin() {
    try {
      return new URL(getApiHost()).origin;
    } catch (err) {
      var host = getApiHost();
      var match = host.match(/^(https?:\/\/[^/]+)/);

      return match ? match[1] : host.replace(/\/$/, '');
    }
  }

  function buildCallbackLoginUrl(callback, state) {
    var apiHost = getApiHost();

    if (apiHost.charAt(apiHost.length - 1) !== '/') apiHost += '/';

    // Attach the state nonce to the *callback* URL (not the login URL).
    // The auth-loader template appends `&token=...&user=...` onto whatever
    // callback URL we supply (see views/login.pug in fliplet-api), so any
    // query params we put here round-trip back unchanged. That's how the
    // state survives the redirect and lets us verify on return that this
    // is a callback for a sign-in we actually initiated.
    if (state) {
      // Insert the param BEFORE any #fragment. On a hash-routed app
      // (`https://app/page#/route`) appending to the end would push `state`
      // into the fragment, and the API then appends `token`/`user` there too
      // — none of which reach Fliplet.Navigate.query (it reads the query
      // string, not the fragment), breaking the same-tab return.
      var hashAt = callback.indexOf('#');
      var cbBase = hashAt === -1 ? callback : callback.slice(0, hashAt);
      var cbFrag = hashAt === -1 ? '' : callback.slice(hashAt);
      var stateSep = cbBase.indexOf('?') === -1 ? '?' : '&';

      callback = cbBase + stateSep + 'state=' + encodeURIComponent(state) + cbFrag;
    }

    // authExchange=1 asks the auth page for the state-exchange contract:
    // the return leg carries a one-shot authState instead of the session
    // token + user payload, keeping credentials out of URLs (and out of
    // host access logs, proxy logs, and browser history).
    var params = ['return=callback', 'callback=' + encodeURIComponent(callback), 'authExchange=1'];
    var appId = Fliplet.Env.get('appId');

    if (appId) params.push('appId=' + encodeURIComponent(String(appId)));

    return apiHost + 'v1/auth/login?' + params.join('&');
  }

  /**
   * Returns the current page URL with any auth-return sentinel params
   * (token / user / state / error) stripped, so repeat sign-ins don't
   * accumulate stale params in the callback URL. Uses the URL API —
   * fine for web where same-tab mode applies (all modern web browsers).
   */
  function buildSameTabCallbackUrl() {
    try {
      var url = new URL(window.location.href);

      url.searchParams.delete('token');
      url.searchParams.delete('user');
      url.searchParams.delete('state');
      url.searchParams.delete('authState');
      url.searchParams.delete('authHost');
      url.searchParams.delete('error');

      return url.toString();
    } catch (err) {
      return window.location.href;
    }
  }

  /**
   * Strips the auth-return params from the URL in place so the token
   * doesn't persist in the address bar / history / bookmarks.
   */
  function cleanAuthReturnParamsFromUrl() {
    if (!window.history || !window.history.replaceState) return;

    try {
      var url = new URL(window.location.href);

      url.searchParams.delete('token');
      url.searchParams.delete('user');
      url.searchParams.delete('state');
      url.searchParams.delete('authState');
      url.searchParams.delete('authHost');
      url.searchParams.delete('error');
      window.history.replaceState({}, document.title, url.toString());
    } catch (err) {
      console.warn('[Fliplet.Login] failed to clean auth params from URL:', err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // State nonce: defends the same-tab and IAB return legs against
  // session-fixation. We mint a random value before redirecting, stash
  // it in sessionStorage, and require the return URL to echo it back.
  // Single-shot — we consume the stored value on either success or
  // failure so a replay can't reuse the same nonce on a second arrival.
  // ──────────────────────────────────────────────────────────────────────

  var AUTH_STATE_STORAGE_KEY = 'fliplet_login_state';

  function generateAuthState() {
    var crypto = window.crypto || window.msCrypto;

    if (crypto && crypto.getRandomValues) {
      var bytes = new Uint8Array(16);

      crypto.getRandomValues(bytes);

      var hex = '';

      for (var i = 0; i < bytes.length; i++) {
        hex += (bytes[i] < 0x10 ? '0' : '') + bytes[i].toString(16);
      }

      return hex;
    }

    // Fallback — Math.random isn't cryptographically strong but a
    // missing crypto API is so rare in target browsers that we'd rather
    // degrade than disable the gate entirely.
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function storeAuthState(state) {
    try {
      window.sessionStorage.setItem(AUTH_STATE_STORAGE_KEY, state);
    } catch (err) {
      // eslint-disable-next-line no-console -- silent failure here means every subsequent return rejects with no debuggable cause
      console.warn('[Fliplet.Login] sessionStorage write failed, state check will reject return:', err);
    }
  }

  function consumeAuthState() {
    try {
      var stored = window.sessionStorage.getItem(AUTH_STATE_STORAGE_KEY);

      window.sessionStorage.removeItem(AUTH_STATE_STORAGE_KEY);

      return stored;
    } catch (err) {
      return null;
    }
  }

  // Validates the shape of the `user` object returned via the callback
  // URL. Combined with the state-nonce check, this rejects forged URLs
  // where an attacker controls the query string and tries to pin an
  // arbitrary {id, email, userRoleId} into the victim's stored session.
  function isValidUserShape(user) {
    return !!user
      && typeof user === 'object'
      && typeof user.id === 'number'
      && typeof user.email === 'string';
  }

  // Detects an app-token "user" — the synthetic account behind a Fliplet app's
  // bootstrap token (email like `token-eu-130990-494095-android-enterprise@fliplet.com`).
  // The callback `user` payload doesn't carry `type`, so we match the reserved
  // email pattern. A real sign-in must never resolve to one of these.
  function isAppTokenUser(user) {
    // Token names are user-supplied (spaces become dashes, but any other
    // punctuation survives into the email), so match anything between the
    // reserved `token-` prefix and the @fliplet.com domain.
    return !!user
      && typeof user.email === 'string'
      && /^token-[^@]*@fliplet\.com$/i.test(user.email);
  }

  // Validates `authHost` before it is ever used as a request target.
  // Implementation and rationale live in js/safe-auth-host.js, which is loaded
  // ahead of this file by widget.json so it can also be unit tested in Node.
  //
  // Resolved defensively: if the asset doesn't land, dereferencing it directly
  // would throw at widget init and take the whole login screen down. Falling
  // back to "reject everything" degrades to same-region sign-in, which is what
  // an unvalidatable authHost should do anyway.
  var safeAuthHost = (window.FlipletLoginAuthHost || {}).safeAuthHost || function() {
    console.warn('[Fliplet.Login] safe-auth-host asset missing; authHost will be ignored');

    return null;
  };

  // Masks token / user / state / authState / authHost query params before
  // logging the URL, so credentials don't surface in remote log aggregators,
  // support-ticket screenshots, or screen recordings. authHost is not itself
  // a credential, but it is masked alongside them so a log line can't be used
  // to confirm which region a given user's session lives in.
  function maskUrlForLogging(url) {
    try {
      var u = new URL(url);

      ['token', 'user', 'state', 'authState', 'authHost'].forEach(function(key) {
        if (u.searchParams.has(key)) u.searchParams.set(key, '<redacted>');
      });

      return u.toString();
    } catch (err) {
      return url.split('?')[0];
    }
  }

  /**
   * Detects whether the widget is running in a Studio editor, Studio
   * preview, or V3 app preview context — anywhere the auth-loader
   * shouldn't be loaded via a top-level redirect.
   *
   * Studio signals are the primary discriminator:
   *   - interact: true                   → Studio edit mode
   *   - mode === 'interact' | 'preview'  → Studio (legacy / non-V3)
   *   - preview: true                    → V3 app preview
   *
   * Iframe detection is a final safety net: any other embedding
   * context would hit X-Frame-Options on the auth-loader anyway.
   * Cross-origin iframes throw on `window.top` access; treat the
   * throw as "yes, we're iframed".
   */
  function isStudioOrPreviewContext() {
    if (Fliplet.Env.get('interact')) return true;
    if (Fliplet.Env.get('preview')) return true;

    var mode = Fliplet.Env.get('mode');

    if (mode === 'interact' || mode === 'preview') return true;

    try {
      if (window.self !== window.top) return true;
    } catch (err) {
      return true;
    }

    return false;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sign-in flows
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Web sign-in: delegate to the Fliplet.Auth SDK, which opens the unified
   * sign-in page in a popup and handles the postMessage round-trip. On
   * success resolves with { user, token }; on failure rejects with an
   * Error (popup blocked, closed without completing, timed out, etc.).
   *
   * Fliplet.Auth is shipped by the Fliplet runtime — if it's missing
   * (older runtime, build misconfiguration), fall back to the same-tab
   * flow rather than throwing `Cannot read properties of undefined`.
   */
  function openSignInPopup() {
    if (!window.Fliplet || !Fliplet.Auth || typeof Fliplet.Auth.signIn !== 'function') {
      // eslint-disable-next-line no-console -- surface the fallback so it isn't invisible during debugging
      console.warn('[Fliplet.Login] Fliplet.Auth.signIn unavailable; falling back to same-tab sign-in');
      openSignInSameTab();

      return;
    }

    showLoadingState();

    Fliplet.Auth.signIn().then(function(result) {
      handleAuthSuccess({ token: result.token, user: result.user });
    }).catch(function(err) {
      hideLoadingState();

      var message = (err && err.message) || T('widgets.login.fliplet.errors.unableLogin');

      // Don't toast for user-initiated cancellations (popup closed).
      // This pattern-matches on the SDK's current message wording; if
      // the SDK ever surfaces a structured `err.code === 'CANCELLED'`
      // (or similar), prefer that over the regex.
      if (/cancelled|closed/i.test(message)) {
        return;
      }

      Fliplet.UI.Toast.error(message);
    });
  }

  /**
   * Web same-tab sign-in: navigate the current tab to the unified
   * sign-in page with a callback URL that points back to this page.
   * The auth-loader does a top-level redirect back with token + user
   * in the query string; handleSameTabReturn() picks them up on the
   * next page load.
   *
   * Used only when the app is actually being viewed as a deployed web
   * app — Studio interact mode keeps the popup to avoid hijacking the
   * editor iframe.
   */
  function openSignInSameTab() {
    showLoadingState();

    var state = generateAuthState();

    storeAuthState(state);

    var loginUrl = buildCallbackLoginUrl(buildSameTabCallbackUrl(), state);

    window.location.assign(loginUrl);
  }

  /**
   * Swaps a one-shot authState (minted by the auth page via
   * POST /v1/session/authorize/state) for the signed-in session. The
   * authenticate middleware resolves ?state= into the session's
   * credentials server-side, so neither the session token nor the user
   * payload ever transits a URL that reaches logs or history.
   * @param {String} authState - One-shot state token from the return leg
   * @param {String} [authHost] - Host that minted the token. The token is
   *   single-use Redis and region-local, so it must be redeemed on its
   *   issuing host — which for a cross-region user differs from this app's
   *   API host. Absent only on rollout skew (old API); falls back to the
   *   app's own API host, i.e. the pre-existing same-region behaviour.
   * @returns {Promise<Object|null>} { token, user }, or null when the
   *   state is invalid, expired, or the session can't be resolved
   */
  function exchangeAuthState(authState, authHost) {
    if (!authState) {
      return Promise.resolve(null);
    }

    // Retarget via options.apiUrl — NOT by building an absolute options.url.
    // Fliplet.API.request prepends the API base to *every* url, absolute ones
    // included (core.js `options.url = apiUrl + options.url`), so an absolute
    // URL yields https://api.fliplet.com/https://us-api.fliplet.com/... → 404.
    // options.apiUrl replaces the base instead, which is the supported retarget
    // (added in DEV-667). Cores predating it ignore the option and fall back to
    // the app's own host — same-region behaviour, not a broken request.
    //
    // apiUrl is set unconditionally. Leaving it off does NOT fall back to the
    // canonical API host: Fliplet.API.request's default base is
    // Fliplet.Env.get('apiUrl'), which inside a published web app is the
    // apps-host-proxied URL (https://apps.fliplet.com/) rather than the API
    // host — the same distinction getApiHost() exists to paper over. Pinning it
    // to getApiOrigin() keeps the exchange on the host that serves these routes
    // and matches where the login URL itself was sent.
    var appOrigin = getApiOrigin();

    var opts = {
      url: 'v1/session?state=' + encodeURIComponent(authState),
      apiUrl: safeAuthHost(authHost, appOrigin) || appOrigin,
      // The state token must be the ONLY credential this call presents.
      //
      // core.js fills in Fliplet.User.getAuthToken() whenever Auth-token is
      // unset, and the API's loadUser keeps that ambient token when the state
      // fails to resolve (expired, already consumed, Redis blip) instead of
      // rejecting. The exchange would then return 200 with the device's
      // PREVIOUS session and sign the user in as the wrong identity, silently
      // — the exact opposite of what a failed exchange should do.
      //
      // Sending a deliberately invalid sentinel suppresses the fill-in, so an
      // unresolvable state has nothing to fall back to and correctly 401s.
      headers: { 'Auth-token': 'state' }
    };

    return Fliplet.API.request(opts).then(function(response) {
      var session = response && response.session;
      var user = session && session.user;

      if (!session || !session.auth_token || !user) {
        return null;
      }

      // Pass the user through whole rather than hand-picking fields. It is
      // already the server's own public projection (models/session.js
      // getPublic() omits auth_token), and it is the same object the legacy
      // token+user contract puts in the callback URL — so every path feeds
      // Fliplet.Hooks.run('login') an identically shaped userProfile.
      // Reducing it here silently dropped fields for deployed web/native
      // sign-ins only, which is exactly the kind of divergence a public hook
      // must not have.
      return {
        token: session.auth_token,
        user: user
      };
    }).catch(function(err) {
      // Log the status and the host that was actually targeted. Without them
      // CORS, network failure, an expired state and a wrong-region redemption
      // all collapse into the caller's single "exchange failed" warn — and the
      // cross-region path is precisely the one that cannot be falsified on a
      // local stack, so a production failure here needs to be diagnosable from
      // the log line alone.
      console.warn('[Fliplet.Login] authState exchange failed', {
        status: (err && (err.status || (err.response && err.response.status))) || 'none',
        apiUrl: opts.apiUrl,
        authHostAccepted: !!safeAuthHost(authHost, appOrigin),
        message: (err && err.message) || String(err)
      });

      return null;
    });
  }

  /**
   * Runs on widget mount. If the current URL has authState (or legacy
   * token + user) query params, we're on the return leg of a same-tab
   * sign-in — validate the state nonce, resolve the auth result (via the
   * one-shot exchange, or directly on the legacy contract), clean the
   * URL, and feed it into handleAuthSuccess. Returns true if the return
   * was handled (success OR rejection) so the caller can skip the
   * normal session-restore path.
   */
  function handleSameTabReturn() {
    var q = Fliplet.Navigate.query;

    if (!q || (!q.token && !q.authState)) return false;

    // Always consume the stored state, even on rejection — burning the
    // nonce on first arrival prevents replay if an attacker manages to
    // deliver the same URL twice.
    var expectedState = consumeAuthState();

    function reject(reason) {
      // eslint-disable-next-line no-console -- security trace: state/shape rejections need to surface for incident triage
      console.warn('[Fliplet.Login] same-tab return rejected:', reason);
      cleanAuthReturnParamsFromUrl();
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
      // Reveal the form so the user can retry: handleSameTabReturn makes
      // init() return before initSession() would show it, so without this
      // a failed return leaves the loader up indefinitely.
      showStart();

      return true;
    }

    if (!expectedState || !q.state || q.state !== expectedState) {
      return reject('state nonce missing or mismatch');
    }

    // Preferred contract: one-shot state exchange — no credentials in the URL.
    if (q.authState) {
      var authState = q.authState;
      var authHost = q.authHost;

      cleanAuthReturnParamsFromUrl();

      exchangeAuthState(authState, authHost).then(function(result) {
        if (!result || !isValidUserShape(result.user)) {
          reject('authState exchange failed or returned an invalid user');

          return;
        }

        handleAuthSuccess(result);
      }).catch(function() {
        // exchangeAuthState swallows its own request failure, so reaching here
        // means handleAuthSuccess threw. Without this the rejection is
        // unhandled: no toast, no showStart(), loader up indefinitely.
        reject('exchange threw');
      });

      return true;
    }

    // Legacy contract (token + user in the URL) — kept for rollout skew
    // between the widget and the auth page.
    var user = null;

    try {
      user = JSON.parse(q.user || 'null');
    } catch (err) {
      return reject('user payload failed to parse');
    }

    if (!isValidUserShape(user)) {
      return reject('user payload failed shape validation');
    }

    cleanAuthReturnParamsFromUrl();

    handleAuthSuccess({ token: q.token, user: user });

    return true;
  }

  /**
   * Cordova native sign-in: open the unified sign-in page in an
   * InAppBrowser. postMessage isn't usable between the app WebView and
   * the IAB, so we use a sentinel callback URL (the API's own
   * /v1/auth/return-token) and intercept the IAB navigation to capture
   * the auth result. Same contract the CLI / VSCode extension use.
   */
  function openSignInIAB() {
    var callbackBase = getApiOrigin() + '/v1/auth/return-token';
    var state = generateAuthState();
    var loginUrl = buildCallbackLoginUrl(callbackBase, state);
    var iabHandled = false;
    var pendingAuth = null;
    var fallbackTimer = null;

    // Pre-parse the expected callback URL once for strict origin +
    // pathname comparison. A prefix-match (`indexOf(...) === 0`) would
    // accept `/v1/auth/return-token-anything?token=...` — exact match
    // closes that.
    var expectedOrigin;
    var expectedPathname;

    try {
      var expectedUrl = new URL(callbackBase);

      expectedOrigin = expectedUrl.origin;
      expectedPathname = expectedUrl.pathname;
    } catch (err) {
      // eslint-disable-next-line no-console -- shouldn't happen (URL is built by us); if it does, it's the only signal of a real bug
      console.error('[Fliplet.Login] failed to parse callback URL:', err);

      return;
    }

    storeAuthState(state);
    showLoadingState();

    // Bypass Fliplet.Navigate.url and open the InAppBrowser directly.
    // The wrapper hardcodes `loadstart` for its own auth checks and
    // doesn't expose the IAB instance, so we can't intercept the
    // callback URL or close the IAB on success through it. Using the
    // Cordova plugin directly gives us `loadstart` (fires before the
    // API's fallback page paints) and direct `.close()` access.
    if (!window.cordova || !window.cordova.InAppBrowser) {
      console.error('[Fliplet.Login] cordova.InAppBrowser not available');
      hideLoadingState();

      return;
    }

    var options = 'location=no,enableViewportScale=yes,toolbarposition=top,fullscreen=yes';
    var browser = window.cordova.InAppBrowser.open(loginUrl, '_blank', options);

    function tryHandle(event, source) {
      if (!event || !event.url || iabHandled) return;
      // Mask token/user/state before logging — every IAB navigation
      // gets logged here and these URLs end up in remote log aggregators
      // and support-ticket screenshots.
      // eslint-disable-next-line no-console -- diagnostic trace for the Android loadstop vs iOS loadstart hop ordering; URL is masked
      console.log('[Fliplet.Login][IAB ' + source + ']', maskUrlForLogging(event.url));

      var parsed;

      try {
        parsed = new URL(event.url);
      } catch (err) {
        return;
      }

      if (parsed.origin !== expectedOrigin || parsed.pathname !== expectedPathname) return;

      var token = parsed.searchParams.get('token');
      var authState = parsed.searchParams.get('authState');
      var authHost = parsed.searchParams.get('authHost');
      // A failed mint on the auth page returns to this same callback carrying
      // only error+state. Without it in this guard the return is never marked
      // handled: the IAB stays open on the callback page and the app sits
      // behind it waiting for a result that never arrives.
      var error = parsed.searchParams.get('error');

      if (!token && !authState && !error) return;

      iabHandled = true;

      try {
        browser.close();
      } catch (err) {
        console.warn('[Fliplet.Login] failed to close IAB:', err);
      }

      // Single-shot consume — burn the nonce regardless of outcome.
      var expectedState = consumeAuthState();
      var returnedState = parsed.searchParams.get('state');

      function rejectIab(reason) {
        // eslint-disable-next-line no-console -- security trace: state/shape rejections need to surface for incident triage
        console.warn('[Fliplet.Login] IAB return rejected:', reason);
        Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
        // No showStart() here (unlike the same-tab reject): the IAB path never
        // hides the form, so hideLoadingState() is enough.
        hideLoadingState();
      }

      if (!expectedState || !returnedState || returnedState !== expectedState) {
        return rejectIab('state nonce missing or mismatch');
      }

      // Checked after the nonce so a crafted ?error= link can't drive this
      // path without a matching nonce. The server's message is logged rather
      // than shown: it arrives via the URL, and the localised toast already
      // says the same thing without rendering text from the query string.
      if (error) {
        return rejectIab('auth page reported an error: ' + error);
      }

      // Don't run the success path yet: on iOS a WebView navigation issued
      // while the IAB dismissal transition is in flight gets swallowed by
      // the native view-controller transition, so Navigate.to at the end of
      // handleAuthSuccess would silently do nothing. Resolve the auth result
      // as a promise (the exchange is an XHR from the app WebView) and let
      // onExit — which Cordova fires after close() completes on both
      // platforms — consume it once the IAB is fully gone.
      if (authState) {
        // Preferred contract: one-shot state exchange — no credentials in
        // the sentinel URL.
        pendingAuth = exchangeAuthState(authState, authHost).then(function(result) {
          if (!result || !isValidUserShape(result.user)) {
            rejectIab('authState exchange failed or returned an invalid user');

            return null;
          }

          return result;
        });
      } else {
        // Legacy contract (token + user in the URL) — kept for rollout skew
        // between the widget and the auth page.
        var user = null;

        try {
          user = JSON.parse(parsed.searchParams.get('user') || 'null');
        } catch (err) {
          return rejectIab('user payload failed to parse');
        }

        if (!isValidUserShape(user)) {
          return rejectIab('user payload failed shape validation');
        }

        pendingAuth = Promise.resolve({ token: token, user: user });
      }

      // Safety net if a plugin quirk drops the exit event: run the success
      // path anyway rather than stranding a completed sign-in. onExit clears
      // this timer on the normal path.
      fallbackTimer = setTimeout(runPendingAuth, 3000);
    }

    /**
     * Consumes the pending auth result exactly once (whichever of onExit or
     * the fallback timer gets there first) and runs the success path.
     * @returns {Boolean} TRUE if a pending result was consumed
     */
    function runPendingAuth() {
      if (!pendingAuth) {
        return false;
      }

      var auth = pendingAuth;

      pendingAuth = null;

      auth.then(function(result) {
        // A null result means the exchange already surfaced its rejection.
        if (result) {
          handleAuthSuccess(result);
        }
      }).catch(function(err) {
        // Same hazard the same-tab path guards against: a throw inside
        // handleAuthSuccess would otherwise be an unhandled rejection with no
        // toast and no showStart(), leaving the loader up indefinitely.
        console.warn('[Fliplet.Login] native auth completion threw:', err);
        Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
        hideLoadingState();
        showStart();
      });

      return true;
    }

    function onLoadStart(event) {
      tryHandle(event, 'loadstart');
    }

    function onLoadStop(event) {
      // Android WebView doesn't always fire `shouldOverrideUrlLoading`
      // for same-origin `location.href` redirects, so `loadstart` can
      // miss the final callback URL hop on Android (the API renders
      // its /v1/auth/return-token fallback page and the user gets
      // stranded). `loadstop` fires reliably on every navigation
      // completion on both platforms — it's the safety net. Both
      // listeners short-circuit via `iabHandled` so we only run the
      // success path once.
      tryHandle(event, 'loadstop');
    }

    function onExit() {
      browser.removeEventListener('loadstart', onLoadStart);
      browser.removeEventListener('loadstop', onLoadStop);
      browser.removeEventListener('exit', onExit);

      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }

      // Success path: the IAB is fully dismissed now, so the navigation at
      // the end of handleAuthSuccess can't be swallowed by the transition.
      if (runPendingAuth()) {
        return;
      }

      // Only reset the button if the user closed the IAB before
      // completing. On the success path handleAuthSuccess manages
      // its own loading state through navigation.
      if (!iabHandled) {
        hideLoadingState();
      }
    }

    browser.addEventListener('loadstart', onLoadStart);
    browser.addEventListener('loadstop', onLoadStop);
    browser.addEventListener('exit', onExit);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Convergence point: web and native flows both call this with
  // { token, user }. Runs the login hook, validates the account,
  // sets the app-list flag, and navigates to the configured next page.
  // ──────────────────────────────────────────────────────────────────────

  function handleAuthSuccess(authResult) {
    if (!authResult || !authResult.token || !authResult.user) {
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
      hideLoadingState();

      return;
    }

    // Defence in depth: the unified sign-in must never return an app token as
    // the signed-in user. In the native IAB the cookie jar is shared with the
    // app WebView, so a stale/missing server-side guard can auto-complete the
    // login as the app's bootstrap appToken (id 115416-style, email
    // token-…@fliplet.com). Navigating on that lands on the target screen,
    // which then rejects it ("Please login using your Fliplet Studio
    // credentials"). Catch it here and keep the user on the login form.
    if (isAppTokenUser(authResult.user)) {
      console.warn('[Fliplet.Login] handleAuthSuccess: returned user is an app token, not a real login — rejecting', {
        userId: authResult.user.id,
        userEmail: authResult.user.email
      });
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
      hideLoadingState();
      // Same-tab return path leaves the form hidden until showStart(); no-op
      // in popup/IAB contexts where it's already visible.
      showStart();

      return;
    }

    showLoadingState();

    // Attach the passport to the app's session BEFORE the token swap and
    // navigation, so the destination screen's security check and any app
    // list component already see the signed-in state when they load.
    return attachPassportToCurrentSession(authResult.token).then(function() {
      // Stamp the in-memory auth token so subsequent API calls in this
      // chain (validateAccount, etc.) authenticate as the signed-in
      // user, not the app's bootstrap appToken. Fliplet.Auth.signIn()
      // (web popup) does this internally; the same-tab and native IAB
      // paths reach here with just a raw token in hand, so we set it
      // explicitly. Mirrors what initSession does at restore time.
      Fliplet.User.setAuthToken(authResult.token);

      return refreshCachedSession();
    }).then(function() {
      // Note: Fliplet.Auth.signIn() already writes fliplet_login_component
      // and calls setAuthToken. The updateUserStorage call below is kept
      // for backwards compatibility with any consumer that reads a field
      // the SDK doesn't write.
      return Fliplet.Login.updateUserStorage({
        id: authResult.user.id,
        region: authResult.token.substr(0, 2),
        userRoleId: authResult.user.userRoleId,
        authToken: authResult.token,
        email: authResult.user.email,
        legacy: authResult.user.legacy
      });
    }).then(function() {
      return Fliplet.Hooks.run('login', {
        passport: 'fliplet',
        userProfile: authResult.user
      });
    }).then(function() {
      // No pre-fetched data: validateAccount treats options.data as the
      // getUserData envelope, so passing the callback's bare user made
      // verifyUserForDevEnvApp see no user (early-returning past the admin
      // gate) AND still missed the setup flags (the callback payload doesn't
      // carry them). updateUserStorage already ran above with the session
      // token, so getUserData() now fetches /v1/user and returns the real
      // envelope — the gate runs and the flags are populated. Matches the
      // restore path.
      return Fliplet.Login.validateAccount();
    }).then(function() {
      Fliplet.Analytics.trackEvent({
        category: 'login_fliplet',
        action: 'login_pass'
      });

      return Fliplet.Storage.set(LOGIN_FLAG_KEY, true);
    }).then(function() {
      // Reset the button state BEFORE attempting navigation. When the
      // navigation succeeds, the widget unmounts and the reset is a no-op.
      // When `disableSecurity` is true (preview / dev mode), navigation
      // is intentionally skipped.
      hideLoadingState();

      if (Fliplet.Env.get('disableSecurity')) {
        console.log('Redirection to other screens is disabled when security isn\'t enabled.');

        return Fliplet.UI.Toast(T('widgets.login.fliplet.successToast.login'));
      }

      return Fliplet.Navigate.to(_this.data.action);
    }).catch(function(err) {
      console.error('[Fliplet.Login] handleAuthSuccess failed:', err);

      Fliplet.Analytics.trackEvent({
        category: 'login_fliplet',
        action: 'login_fail'
      });

      var errorMessage = Fliplet.parseError(err, T('widgets.login.fliplet.errors.unableLogin'));

      // Build the element and set content via .text() — parseError can echo
      // server-supplied strings, so .html() would be an injection sink.
      _this.$container.find('.login-error-holder')
        .empty()
        .append($('<p>').text(errorMessage))
        .addClass('show');
      hideLoadingState();
      // Same-tab return path leaves the form hidden until showStart(); no-op
      // in popup/IAB contexts where it's already visible.
      showStart();
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Loading state on the sign-in button
  // ──────────────────────────────────────────────────────────────────────

  function showLoadingState() {
    var $btn = _this.$container.find('.fliplet-login-button');

    if (!$btn.data('original-label')) {
      $btn.data('original-label', $btn.text().trim());
    }

    $btn.prop('disabled', true).addClass('loading');
    $btn.text(T('widgets.login.fliplet.actions.waitingForSignIn'));
  }

  function hideLoadingState() {
    var $btn = _this.$container.find('.fliplet-login-button');

    $btn.prop('disabled', false).removeClass('loading');

    var original = $btn.data('original-label');

    if (original) $btn.text(original);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Already-signed-in detection.
  //
  // The ONLY reliable "this user is signed in to the app" signal is a
  // `flipletLogin` passport on the session that the user's auth token
  // resolves to. Two facts drive the logic below:
  //
  //  - The cached/bootstrap session is NOT always the user's session. On
  //    native, Fliplet bootstrap re-fetches /v1/session with the server
  //    injected APP TOKEN on every load, so getCachedSession() returns the
  //    app-token session (`user.type === 'appToken'`, empty passports) even
  //    when the user is logged in. The user's real login token — whose
  //    session DOES carry the flipletLogin passport — lives in App.Storage.
  //    In web / Studio preview, getCachedSession() IS the user's session and
  //    carries the passport directly.
  //
  //  - A bare token check is not enough. /v1/user returns 200 for the app
  //    token and for a stale token whose passport was removed by logout
  //    (App.Storage is NOT cleared on logout), so trusting "a token exists"
  //    or "the token resolves to a user" navigates a signed-out user straight
  //    to the target screen. We must confirm the PASSPORT specifically.
  //
  // So: trust the cached session if it carries the passport (web/preview);
  // otherwise validate the App.Storage token's own session against the
  // server (native). App.Storage is trusted without validation only OFFLINE.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Extracts the signed-in user's flipletLogin passport from a session
   * object. Merges the stored credential (server.passports — has the
   * auth_token) with the validated public profile (accounts — has id /
   * email / userRoleId). Works for both getCachedSession() and a
   * /v1/session response. Returns a normalised object, or null when the
   * session carries no usable flipletLogin passport.
   * @param {Object} session - A session object (getPublic shape)
   * @returns {Object|null} Normalised passport details, or null
   */
  function getFlipletPassport(session) {
    if (!session) {
      return null;
    }

    var stored = session.server
      && session.server.passports
      && session.server.passports.flipletLogin;
    var validated = session.accounts && session.accounts.flipletLogin;

    var credential = Array.isArray(stored) ? stored[0] : stored;
    var profile = Array.isArray(validated) ? validated[0] : validated;

    credential = credential || {};
    profile = profile || {};

    // The user's real auth_token only lives on the stored credential. No
    // token means no usable passport — treat the session as signed out.
    if (!credential.auth_token) {
      return null;
    }

    return {
      id: profile.id,
      email: profile.email || credential.email,
      userRoleId: profile.userRoleId || credential.userRoleId,
      region: credential.region || credential.auth_token.substr(0, 2),
      authToken: credential.auth_token,
      legacy: profile.legacy
    };
  }

  /**
   * Asks the server whether the session behind a specific token carries a
   * flipletLogin passport. Used on native, where the cached session is the
   * app token: the real login token (from App.Storage) must be checked
   * directly. Resolves with normalised passport details, or null when the
   * token is invalid/expired or its session has been signed out (passport
   * removed by logout).
   * @param {String} token - The candidate user auth token
   * @returns {Promise<Object|null>} Passport details, or null
   */
  function getPassportForToken(token) {
    if (!token) {
      return Promise.resolve(null);
    }

    return Fliplet.API.request({
      url: 'v1/session',
      headers: { 'Auth-token': token }
    }).then(function(response) {
      return getFlipletPassport(response && response.session);
    }).catch(function() {
      // Invalid / expired token — treat as signed out.
      return null;
    });
  }

  /**
   * Copies the flipletLogin passport from the signed-in session onto the
   * app's CURRENT session. The unified sign-in happens on the auth page's
   * own session, but everything outside this widget (app list, protected
   * screen security) decides "signed in" by reading the current session —
   * without this step the passport is invisible to the rest of the app.
   * Uses the runtime's default credentials — the same ones the session
   * cache refresh below uses — so the copy targets the session the app is
   * actually running under right now (app sessions rotate when the served
   * page is re-fetched, so a token captured earlier can go stale). Must
   * run BEFORE Fliplet.User.setAuthToken swaps to the user's token.
   * Best-effort: on failure (e.g. a cross-region source session) sign-in
   * continues — screens with this widget still work via the stored token.
   * @param {String} token - The signed-in session's auth token
   * @returns {Promise} Always resolves
   */
  function attachPassportToCurrentSession(token) {
    return Fliplet.API.request({
      url: 'v1/session/providers/copy',
      method: 'POST',
      data: { source_session_auth_token: token }
    }).catch(function(err) {
      console.warn('[Fliplet.Login] failed to attach passport to the current session:', err);
    });
  }

  /**
   * Refreshes the persisted session cache so consumers reading
   * getCachedSession() (app list, security checks) see the passport
   * attached above without waiting for the 30-minute renewal.
   * @returns {Promise} Always resolves
   */
  function refreshCachedSession() {
    return Fliplet.User.getCachedSession({ force: true }).catch(function(err) {
      console.warn('[Fliplet.Login] failed to refresh the cached session:', err);
    });
  }

  function initSession() {
    Fliplet.User.getCachedSession()
      .catch(function() {
        // getCachedSession rejects when offline or before a session exists.
        return null;
      })
      .then(function(session) {
        // 1. The cached session itself carries the passport (web / Studio
        //    preview, where getCachedSession() is the user's own session).
        var passport = getFlipletPassport(session);

        if (passport) {
          return { passport: passport, verified: true, session: session };
        }

        // 2. No passport on the cached session (native app-token session).
        //    The real login token is in App.Storage.
        return Fliplet.App.Storage.get(FLIPLET_LOGIN_STORAGE_KEY).then(function(stored) {
          if (!stored || !stored.auth_token) {
            return { passport: null, session: session };
          }

          // Offline: can't reach the server, so trust the stored token as a
          // best effort (unverified).
          if (!Fliplet.Navigator.isOnline()) {
            return { storedToken: stored.auth_token, verified: false, session: session };
          }

          // Online: confirm the stored token's session is actually signed in
          // (still has a flipletLogin passport). This rejects the app token,
          // and tokens left stale in storage after a logout.
          return getPassportForToken(stored.auth_token).then(function(tokenPassport) {
            if (!tokenPassport) {
              return { passport: null, session: session };
            }

            return { passport: tokenPassport, verified: true, session: session, storedToken: stored.auth_token };
          });
        });
      })
      .then(function(state) {
        var authToken = state.passport ? state.passport.authToken : state.storedToken;

        if (!authToken) {
          return Promise.reject(T('widgets.login.fliplet.errors.sessionNotFound'));
        }

        // The passport was found via the stored token but is missing from
        // the app's own (cached) session — e.g. the app session rotated, or
        // the sign-in completed on a different session. Re-attach it so the
        // rest of the app sees the signed-in state.
        var needsSessionAttach = state.passport && !getFlipletPassport(state.session);

        // The copy endpoint resolves the SOURCE by session token — that's
        // what storage holds after a unified sign-in. Legacy storage holds
        // a user token, for which the copy fails softly and we continue.
        var attachPassport = needsSessionAttach
          ? attachPassportToCurrentSession(state.storedToken || authToken)
          : Promise.resolve();

        return attachPassport.then(function() {
          // Restore the user's real auth token so downstream API calls (and the
          // App List component) act as the signed-in user, not the app token.
          Fliplet.User.setAuthToken(authToken);

          return needsSessionAttach ? refreshCachedSession() : undefined;
        }).then(function() {
          return state;
        });
      })
      .then(function(state) {
        if (!state.passport) {
          // Offline best-effort path: no fresh passport details to persist.
          return state;
        }

        return Fliplet.App.Storage.get(FLIPLET_LOGIN_STORAGE_KEY).then(function(stored) {
          return Fliplet.Login.updateUserStorage({
            id: state.passport.id,
            region: state.passport.region,
            userRoleId: state.passport.userRoleId,
            // Keep the stored SESSION token when there is one: future restore
            // passes need it to re-attach the passport after the app session
            // rotates (the copy endpoint resolves its source by session token).
            authToken: (stored && stored.auth_token) || state.passport.authToken,
            email: state.passport.email,
            legacy: state.passport.legacy
          });
        }).then(function() {
          return state;
        });
      })
      .then(function(state) {
        if (!Fliplet.Navigator.isOnline()) {
          return state;
        }

        // Validate WITHOUT updateUserStorage: initSession already wrote
        // storage above with the session token, and updateUserStorage here
        // would overwrite it with /v1/user's bare user token (no session,
        // no passport) — leaving the next native restore signed out.
        return Fliplet.Login.validateAccount().then(function() {
          return state;
        });
      })
      .then(function(state) {
        if (Fliplet.Env.get('disableSecurity')) {
          return Promise.reject(T('widgets.login.fliplet.warnings.noRedirectWithoutSecurity'));
        }

        if (Fliplet.Env.get('interact')) {
          return Promise.reject(T('widgets.login.fliplet.warnings.noRedirectWhenEditing'));
        }

        // Preview/Studio guard: in preview, only navigate when we have a
        // server-verified passport — never on the offline best-effort path.
        var sourceIsStudio = state.session
          && state.session.client
          && state.session.client.source === 'studio';

        if ((isStudioOrPreviewContext() || sourceIsStudio) && !state.verified) {
          return Promise.reject('Preventing navigation to another screen in Preview mode.');
        }

        var navigate = Fliplet.Navigate.to(_this.data.action);

        if (typeof navigate === 'object' && typeof navigate.then === 'function') {
          showStart();

          return navigate;
        }
      })
      .catch(function(error) {
        console.warn(error);
        showStart();
      });
  }

  // ──────────────────────────────────────────────────────────────────────
  // init: wire up the button click and start the session check
  // ──────────────────────────────────────────────────────────────────────

  function init() {
    _this.$container.translate();

    _this.$container.find('.fliplet-login-button').on('click', function() {
      _this.$container.find('.login-error-holder').removeClass('show').empty();

      var isWeb = Fliplet.Env.get('platform') === 'web';

      if (isWeb && !isStudioOrPreviewContext()) {
        openSignInSameTab();
      } else if (isWeb) {
        // Studio preview / interact / V3 app preview / any iframed
        // context: same-tab would hijack the parent iframe and the
        // auth-loader refuses framing via X-Frame-Options. Fall back
        // to the popup flow.
        openSignInPopup();
      } else {
        openSignInIAB();
      }
    });

    if (Fliplet.Env.get('platform') === 'web') {
      // Same-tab return leg: the auth-loader redirected back with
      // token + user in the query string. Process it before falling
      // through to the normal session restore.
      if (handleSameTabReturn()) {
        return;
      }

      initSession();

      if (Fliplet.Env.get('interact')) {
        _this.$container.find('.fliplet-login-button').prop('disabled', true);
      }

      Fliplet.Studio.onEvent(function(event) {
        if (event.detail.event === 'reload-widget-instance') {
          setTimeout(function() {
            _this.$container.removeClass('hidden');
            showStart();
          }, 500);
        }
      });

      _this.$container.on('fliplet_page_reloaded', function() {
        if (Fliplet.Env.get('interact')) {
          setTimeout(function() {
            _this.$container.removeClass('hidden');
            showStart();
          }, 500);
        }
      });
    } else {
      document.addEventListener('deviceready', initSession);
    }
  }

  Fliplet().then(function() {
    init();
  });
});
