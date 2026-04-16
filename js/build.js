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

  function buildCallbackLoginUrl(callback) {
    var apiHost = getApiHost();
    if (apiHost.charAt(apiHost.length - 1) !== '/') apiHost += '/';

    var params = ['return=callback', 'callback=' + encodeURIComponent(callback)];
    var appId = Fliplet.Env.get('appId');
    if (appId) params.push('appId=' + encodeURIComponent(String(appId)));

    return apiHost + 'v1/auth/login?' + params.join('&');
  }

  /**
   * Returns the current page URL with any auth-return sentinel params
   * (token / user / error) stripped, so repeat sign-ins don't accumulate
   * stale params in the callback URL. Uses the URL API — fine for web
   * where same-tab mode applies (all modern web browsers).
   */
  function buildSameTabCallbackUrl() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('token');
      url.searchParams.delete('user');
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
      url.searchParams.delete('error');
      window.history.replaceState({}, document.title, url.toString());
    } catch (err) {
      console.warn('[Fliplet.Login] failed to clean auth params from URL:', err);
    }
  }

  function parseQueryString(url) {
    var query = (url.split('?')[1] || '').split('#')[0];
    var pairs = query.split('&');
    var result = {};

    pairs.forEach(function(pair) {
      if (!pair) return;
      var idx = pair.indexOf('=');
      if (idx === -1) return;
      result[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    });

    return result;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sign-in flows
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Web sign-in: delegate to the Fliplet.Auth SDK, which opens the unified
   * sign-in page in a popup and handles the postMessage round-trip. On
   * success resolves with { user, token }; on failure rejects with an
   * Error (popup blocked, closed without completing, timed out, etc.).
   */
  function openSignInPopup() {
    showLoadingState();

    Fliplet.Auth.signIn().then(function(result) {
      handleAuthSuccess({ token: result.token, user: result.user });
    }).catch(function(err) {
      hideLoadingState();

      var message = (err && err.message) || T('widgets.login.fliplet.errors.unableLogin');

      // Don't toast for user-initiated cancellations (popup closed).
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

    var loginUrl = buildCallbackLoginUrl(buildSameTabCallbackUrl());

    window.location.assign(loginUrl);
  }

  /**
   * Runs on widget mount. If the current URL has token + user query
   * params, we're on the return leg of a same-tab sign-in — extract
   * them, clean the URL, and feed the result into handleAuthSuccess.
   * Returns true if the return was handled so the caller can skip the
   * normal session-restore path.
   */
  function handleSameTabReturn() {
    var q = Fliplet.Navigate.query;

    if (!q || !q.token) return false;

    var user = null;

    try {
      user = JSON.parse(q.user || 'null');
    } catch (err) {
      console.warn('[Fliplet.Login] failed to parse user from same-tab return:', err);
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
    var callbackPrefix = getApiOrigin() + '/v1/auth/return-token';
    var loginUrl = buildCallbackLoginUrl(callbackPrefix);
    var iabHandled = false;

    showLoadingState();

    Fliplet.Navigate.url({
      url: loginUrl,
      inAppBrowser: true,
      onload: function(event) {
        if (!event || !event.url) return;
        if (iabHandled) return;

        if (event.url.indexOf(callbackPrefix) === 0) {
          var qs = parseQueryString(event.url);

          if (qs.token) {
            iabHandled = true;
            try {
              if (event.iab && typeof event.iab.close === 'function') {
                event.iab.close();
              }
            } catch (err) {
              console.warn('[Fliplet.Login] failed to close IAB:', err);
            }

            var user = null;

            try {
              user = JSON.parse(qs.user || 'null');
            } catch (err) {
              console.warn('[Fliplet.Login] failed to parse user from callback:', err);
            }

            handleAuthSuccess({ token: qs.token, user: user });
          }
        }
      },
      onclose: function() {
        // User closed the IAB before completing — re-enable the button.
        hideLoadingState();
      }
    });
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
  // Already-signed-in detection: skip the button entirely if a Fliplet
  // user session is already stored locally for this app.
  //
  // Reads from the Fliplet.App.Storage entry that Fliplet.Login.updateUserStorage
  // (and Fliplet.Auth.signIn) writes after a successful sign-in. This is
  // the same pattern core.js uses in getOrganizations and similar call
  // sites — `fliplet_login_component.auth_token` is the source of truth
  // for "this user is signed in to the app" and persists across page
  // reloads (App.Storage is durable per-app).
  //
  // Intentionally does NOT use Fliplet.User.getCachedSession(). On a full
  // page reload, Fliplet bootstrap calls /v1/session with the server-injected
  // appToken bearer and overwrites the cached session with the appToken's
  // session — so getCachedSession() always reports `user.type === 'appToken'`
  // on subsequent loads, regardless of whether the user is signed in.
  // ──────────────────────────────────────────────────────────────────────

  function initSession() {
    Fliplet.App.Storage.get(FLIPLET_LOGIN_STORAGE_KEY)
      .then(function(stored) {
        if (!stored || !stored.auth_token) {
          return Promise.reject(T('widgets.login.fliplet.errors.sessionNotFound'));
        }

        // Restore the auth token in window.ENV so any subsequent API calls
        // from this page (including those Fliplet.Login.validateAccount
        // makes via Fliplet.API.request) authenticate as the signed-in user
        // and not as the app's bootstrap appToken.
        Fliplet.User.setAuthToken(stored.auth_token);

        return stored;
      })
      .then(function() {
        if (!Fliplet.Navigator.isOnline()) {
          return;
        }

        return Fliplet.Login.validateAccount({ updateUserStorage: true });
      })
      .then(function() {
        if (Fliplet.Env.get('disableSecurity')) {
          return Promise.reject(T('widgets.login.fliplet.warnings.noRedirectWithoutSecurity'));
        }

        if (Fliplet.Env.get('interact')) {
          return Promise.reject(T('widgets.login.fliplet.warnings.noRedirectWhenEditing'));
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

      if (Fliplet.Env.get('platform') === 'web' && !Fliplet.Env.get('interact')) {
        openSignInSameTab();
      } else if (Fliplet.Env.get('platform') === 'web') {
        // Studio interact mode: the button is normally disabled below,
        // but keep the popup flow as a defensive fallback.
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
