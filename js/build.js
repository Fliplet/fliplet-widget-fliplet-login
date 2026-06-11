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
    _this.$container.find('.login-error-holder').html(Fliplet.Navigate.query.error).addClass('show');
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
      var stateSep = callback.indexOf('?') === -1 ? '?' : '&';

      callback = callback + stateSep + 'state=' + encodeURIComponent(state);
    }

    var params = ['return=callback', 'callback=' + encodeURIComponent(callback)];
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

  // Masks token / user / state query params before logging the URL,
  // so the token doesn't surface in remote log aggregators, support-
  // ticket screenshots, or screen recordings.
  function maskUrlForLogging(url) {
    try {
      var u = new URL(url);

      ['token', 'user', 'state'].forEach(function(key) {
        if (u.searchParams.has(key)) u.searchParams.set(key, '<redacted>');
      });

      return u.toString();
    } catch (err) {
      return url.split('?')[0];
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PS-1956 diagnostic logging. Temporary — routed through one function so
  // there is a single console call site (and a single eslint-disable). All
  // logs are prefixed so they can be grepped out of device logs, and tokens
  // are masked to the region+type prefix and last 4 chars (the secret hash
  // in the middle is never logged).
  // ──────────────────────────────────────────────────────────────────────

  function debug() {
    // eslint-disable-next-line no-console
    console.log.apply(console, ['[Fliplet.Login][PS-1956]'].concat([].slice.call(arguments)));
  }

  function maskToken(token) {
    if (typeof token !== 'string' || !token) {
      return String(token);
    }

    return token.length > 17 ? token.slice(0, 13) + '…' + token.slice(-4) : '<token>';
  }

  // Summarises a session object for logging without leaking secrets.
  function describeSession(session) {
    if (!session) {
      return null;
    }

    var passports = session.server && session.server.passports;

    return {
      id: session.id,
      userType: session.user && session.user.type,
      userEmail: session.user && session.user.email,
      source: session.client && session.client.source,
      passportKeys: passports ? Object.keys(passports) : [],
      hasFlipletLogin: !!(passports && passports.flipletLogin && passports.flipletLogin.length),
      authToken: maskToken(session.auth_token)
    };
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
   * Runs on widget mount. If the current URL has token + user query
   * params, we're on the return leg of a same-tab sign-in — extract
   * them, validate the state nonce and user shape, clean the URL, and
   * feed the result into handleAuthSuccess. Returns true if the return
   * was handled (success OR rejection) so the caller can skip the
   * normal session-restore path.
   */
  function handleSameTabReturn() {
    var q = Fliplet.Navigate.query;

    if (!q || !q.token) return false;

    // Always consume the stored state, even on rejection — burning the
    // nonce on first arrival prevents replay if an attacker manages to
    // deliver the same URL twice.
    var expectedState = consumeAuthState();

    function reject(reason) {
      // eslint-disable-next-line no-console -- security trace: state/shape rejections need to surface for incident triage
      console.warn('[Fliplet.Login] same-tab return rejected:', reason);
      cleanAuthReturnParamsFromUrl();
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));

      return true;
    }

    if (!expectedState || !q.state || q.state !== expectedState) {
      return reject('state nonce missing or mismatch');
    }

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

    debug('openSignInIAB: opening InAppBrowser', { loginUrl: maskUrlForLogging(loginUrl) });

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

      if (!token) return;

      iabHandled = true;

      debug('openSignInIAB: callback intercepted with token', {
        source: source,
        token: maskToken(token)
      });

      try {
        browser.close();
      } catch (err) {
        console.warn('[Fliplet.Login] failed to close IAB:', err);
      }

      // Single-shot consume — burn the nonce regardless of outcome.
      var expectedState = consumeAuthState();
      var returnedState = parsed.searchParams.get('state');

      function rejectIab(reason) {
        debug('openSignInIAB: IAB return REJECTED', { reason: reason });
        // eslint-disable-next-line no-console -- security trace: state/shape rejections need to surface for incident triage
        console.warn('[Fliplet.Login] IAB return rejected:', reason);
        Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
        hideLoadingState();
      }

      if (!expectedState || !returnedState || returnedState !== expectedState) {
        return rejectIab('state nonce missing or mismatch');
      }

      var user = null;

      try {
        user = JSON.parse(parsed.searchParams.get('user') || 'null');
      } catch (err) {
        return rejectIab('user payload failed to parse');
      }

      if (!isValidUserShape(user)) {
        return rejectIab('user payload failed shape validation');
      }

      handleAuthSuccess({ token: token, user: user });
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
    debug('handleAuthSuccess: START', {
      hasToken: !!(authResult && authResult.token),
      token: maskToken(authResult && authResult.token),
      userId: authResult && authResult.user && authResult.user.id,
      userEmail: authResult && authResult.user && authResult.user.email
    });

    if (!authResult || !authResult.token || !authResult.user) {
      debug('handleAuthSuccess: missing token/user -> abort with error toast');
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
      hideLoadingState();
      return;
    }

    // Stamp the in-memory auth token so subsequent API calls in this
    // chain (validateAccount, etc.) authenticate as the signed-in
    // user, not the app's bootstrap appToken. Fliplet.Auth.signIn()
    // (web popup) does this internally; the same-tab and native IAB
    // paths reach here with just a raw token in hand, so we set it
    // explicitly. Mirrors what initSession does at restore time.
    Fliplet.User.setAuthToken(authResult.token);

    showLoadingState();

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
    }).then(function() {
      return Fliplet.Hooks.run('login', {
        passport: 'fliplet',
        userProfile: authResult.user
      });
    }).then(function() {
      return Fliplet.Login.validateAccount({ data: authResult });
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
        debug('handleAuthSuccess: disableSecurity -> skip navigation, show success toast');
        console.log('Redirection to other screens is disabled when security isn\'t enabled.');
        return Fliplet.UI.Toast(T('widgets.login.fliplet.successToast.login'));
      }

      debug('handleAuthSuccess: NAVIGATE to target screen', { action: _this.data && _this.data.action });

      return Fliplet.Navigate.to(_this.data.action);
    }).catch(function(err) {
      debug('handleAuthSuccess: FAILED', { error: (err && err.message) || err });
      console.error('[Fliplet.Login] handleAuthSuccess failed:', err);

      Fliplet.Analytics.trackEvent({
        category: 'login_fliplet',
        action: 'login_fail'
      });

      var errorMessage = Fliplet.parseError(err, T('widgets.login.fliplet.errors.unableLogin'));
      _this.$container.find('.login-error-holder').html('<p>' + errorMessage + '</p>').addClass('show');
      hideLoadingState();
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

    debug('getPassportForToken: validating stored token against /v1/session', maskToken(token));

    return Fliplet.API.request({
      url: 'v1/session',
      headers: { 'Auth-token': token }
    }).then(function(response) {
      var session = response && response.session;

      debug('getPassportForToken: /v1/session returned', describeSession(session));

      var passport = getFlipletPassport(session);

      debug('getPassportForToken: passport on token session =', passport ? 'PRESENT' : 'NONE');

      return passport;
    }).catch(function(err) {
      // Invalid / expired token — treat as signed out.
      debug('getPassportForToken: /v1/session failed (token invalid/expired) ->', err && (err.message || err.status || err));

      return null;
    });
  }

  function initSession() {
    debug('initSession: START', { online: Fliplet.Navigator.isOnline() });

    Fliplet.User.getCachedSession()
      .catch(function(err) {
        // getCachedSession rejects when offline or before a session exists.
        debug('initSession: getCachedSession rejected ->', err && (err.message || err));

        return null;
      })
      .then(function(session) {
        debug('initSession: cached session =', describeSession(session));

        // 1. The cached session itself carries the passport (web / Studio
        //    preview, where getCachedSession() is the user's own session).
        var passport = getFlipletPassport(session);

        if (passport) {
          debug('initSession: PATH 1 - flipletLogin passport on cached session', {
            email: passport.email,
            authToken: maskToken(passport.authToken)
          });

          return { passport: passport, verified: true, session: session };
        }

        // 2. No passport on the cached session (native app-token session).
        //    The real login token is in App.Storage.
        debug('initSession: no passport on cached session, checking App.Storage');

        return Fliplet.App.Storage.get(FLIPLET_LOGIN_STORAGE_KEY).then(function(stored) {
          debug('initSession: App.Storage[fliplet_login_component] =', stored ? {
            email: stored.email,
            authToken: maskToken(stored.auth_token)
          } : null);

          if (!stored || !stored.auth_token) {
            debug('initSession: PATH 2a - no stored token -> not signed in');

            return { passport: null, session: session };
          }

          // Offline: can't reach the server, so trust the stored token as a
          // best effort (unverified).
          if (!Fliplet.Navigator.isOnline()) {
            debug('initSession: PATH 2b - offline, trusting stored token (unverified)');

            return { storedToken: stored.auth_token, verified: false, session: session };
          }

          // Online: confirm the stored token's session is actually signed in
          // (still has a flipletLogin passport). This rejects the app token,
          // and tokens left stale in storage after a logout.
          debug('initSession: PATH 2c - online, verifying stored token server-side');

          return getPassportForToken(stored.auth_token).then(function(tokenPassport) {
            if (!tokenPassport) {
              debug('initSession: stored token has NO flipletLogin passport -> not signed in');

              return { passport: null, session: session };
            }

            debug('initSession: stored token VERIFIED as signed in', { email: tokenPassport.email });

            return { passport: tokenPassport, verified: true, session: session };
          });
        });
      })
      .then(function(state) {
        var authToken = state.passport ? state.passport.authToken : state.storedToken;

        debug('initSession: resolved state', {
          signedIn: !!authToken,
          verified: !!state.verified,
          authToken: maskToken(authToken)
        });

        if (!authToken) {
          return Promise.reject(T('widgets.login.fliplet.errors.sessionNotFound'));
        }

        // Restore the user's real auth token so downstream API calls (and the
        // App List component) act as the signed-in user, not the app token.
        Fliplet.User.setAuthToken(authToken);

        if (!state.passport) {
          // Offline best-effort path: no fresh passport details to persist.
          return state;
        }

        return Fliplet.Login.updateUserStorage({
          id: state.passport.id,
          region: state.passport.region,
          userRoleId: state.passport.userRoleId,
          authToken: authToken,
          email: state.passport.email,
          legacy: state.passport.legacy
        }).then(function() {
          return state;
        });
      })
      .then(function(state) {
        if (!Fliplet.Navigator.isOnline()) {
          return state;
        }

        debug('initSession: running validateAccount');

        return Fliplet.Login.validateAccount({ updateUserStorage: true }).then(function() {
          debug('initSession: validateAccount resolved');

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

        debug('initSession: DECISION = NAVIGATE to target screen', { action: _this.data && _this.data.action });

        var navigate = Fliplet.Navigate.to(_this.data.action);

        if (typeof navigate === 'object' && typeof navigate.then === 'function') {
          showStart();
          return navigate;
        }
      })
      .catch(function(error) {
        debug('initSession: DECISION = SHOW LOGIN SCREEN', { reason: (error && error.message) || error });
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

      debug('login button clicked', {
        platform: Fliplet.Env.get('platform'),
        isWeb: isWeb,
        isStudioOrPreviewContext: isStudioOrPreviewContext(),
        online: Fliplet.Navigator.isOnline()
      });

      if (isWeb && !isStudioOrPreviewContext()) {
        debug('-> openSignInSameTab');
        openSignInSameTab();
      } else if (isWeb) {
        // Studio preview / interact / V3 app preview / any iframed
        // context: same-tab would hijack the parent iframe and the
        // auth-loader refuses framing via X-Frame-Options. Fall back
        // to the popup flow.
        debug('-> openSignInPopup');
        openSignInPopup();
      } else {
        debug('-> openSignInIAB (native)');
        openSignInIAB();
      }
    });

    debug('init', {
      platform: Fliplet.Env.get('platform'),
      interact: Fliplet.Env.get('interact'),
      preview: Fliplet.Env.get('preview'),
      mode: Fliplet.Env.get('mode'),
      disableSecurity: Fliplet.Env.get('disableSecurity'),
      online: Fliplet.Navigator.isOnline(),
      action: _this.data && _this.data.action
    });

    if (Fliplet.Env.get('platform') === 'web') {
      // Same-tab return leg: the auth-loader redirected back with
      // token + user in the query string. Process it before falling
      // through to the normal session restore.
      if (handleSameTabReturn()) {
        debug('web: handleSameTabReturn handled the return leg; skipping initSession');
        return;
      }

      debug('web: no return leg, running initSession');
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
      debug('native: waiting for deviceready to run initSession');
      document.addEventListener('deviceready', function() {
        debug('native: deviceready fired, running initSession');
        initSession();
      });
    }
  }

  Fliplet().then(function() {
    init();
  });
});
