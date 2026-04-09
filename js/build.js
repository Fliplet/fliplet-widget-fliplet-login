Fliplet.Widget.instance('login', function(data) {
  var _this = this;

  /**
   * LOGIN_FLAG_KEY flag will be utilized by App List component to
   * identify whether user has navigated from fliplet login screen
   */
  var LOGIN_FLAG_KEY = 'login_flag';

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
    // an apps-host-proxied URL (e.g. https://apps.fliplet.test/...) which
    // doesn't serve the /v1/auth/* routes. primaryApiUrl is the canonical
    // API host (e.g. https://api.fliplet.test/) — prefer it when available.
    return Fliplet.Env.get('primaryApiUrl') || Fliplet.Env.get('apiUrl');
  }

  function getApiOrigin() {
    try {
      return new URL(getApiHost()).origin;
    } catch (err) {
      return getApiHost().replace(/\/$/, '');
    }
  }

  function getAppId() {
    return Fliplet.Env.get('appId');
  }

  function buildLoginUrl(returnMode, origin) {
    var params = [];
    params.push('return=' + encodeURIComponent(returnMode));
    if (origin) params.push('origin=' + encodeURIComponent(origin));
    var appId = getAppId();
    if (appId) params.push('appId=' + encodeURIComponent(String(appId)));

    var apiHost = getApiHost();
    if (apiHost.charAt(apiHost.length - 1) !== '/') apiHost += '/';

    return apiHost + 'v1/auth/login?' + params.join('&');
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
   * Open the unified sign-in page in a popup window (desktop / mobile web).
   * The popup postMessages the auth token back to the opener on success;
   * the widget listens for the message, then runs handleAuthSuccess.
   */
  function openSignInPopup() {
    var width = 480;
    var height = 720;
    var left = Math.max(0, Math.floor((window.screen.width - width) / 2));
    var top = Math.max(0, Math.floor((window.screen.height - height) / 2));
    var origin = window.location.origin;
    var loginUrl = buildLoginUrl('postmessage', origin);
    var apiOrigin = getApiOrigin();
    var pollClosed;

    function cleanup() {
      window.removeEventListener('message', onMessage);
      if (pollClosed) {
        clearInterval(pollClosed);
        pollClosed = null;
      }
    }

    function onMessage(event) {
      // Strict origin check — only accept messages from the API host
      if (event.origin !== apiOrigin) return;
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'fliplet-login-success') {
        cleanup();
        handleAuthSuccess(event.data);
      } else if (event.data.type === 'fliplet-login-error') {
        Fliplet.UI.Toast.error(event.data.message || T('widgets.login.fliplet.errors.unableLogin'));
      }
    }

    // Register the listener BEFORE opening the popup to avoid a race
    // where the popup loads instantly and postMessages before we're ready.
    window.addEventListener('message', onMessage);

    var popup = window.open(
      loginUrl,
      'fliplet-login',
      'width=' + width + ',height=' + height
        + ',top=' + top + ',left=' + left
        + ',resizable=yes,scrollbars=yes,menubar=no,toolbar=no'
    );

    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      cleanup();
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.popupBlocked'));
      hideLoadingState();
      return;
    }

    showLoadingState();

    pollClosed = setInterval(function() {
      if (popup.closed) {
        cleanup();
        // Popup closed without completing — re-enable the button.
        // No toast: closing the popup is a normal user action, not an error.
        hideLoadingState();
      }
    }, 500);
  }

  /**
   * Open the unified sign-in page in an InAppBrowser (Cordova native).
   * The popup navigates to /v1/auth/return-token on success; we intercept
   * that navigation, capture the token, and close the IAB.
   */
  function openSignInIAB() {
    var loginUrl = buildLoginUrl('callback', null);
    var callbackPrefix = getApiOrigin() + '/v1/auth/return-token';

    showLoadingState();

    Fliplet.Navigate.url({
      url: loginUrl,
      inAppBrowser: true,
      onload: function(event) {
        if (!event || !event.url) return;

        if (event.url.indexOf(callbackPrefix) === 0) {
          var qs = parseQueryString(event.url);

          if (qs.token) {
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
        // No toast: cancelling is a normal action.
        hideLoadingState();
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Convergence point: both desktop and mobile flows call this with
  // { token, user }. Reuses the existing post-login glue verbatim.
  // ──────────────────────────────────────────────────────────────────────

  function handleAuthSuccess(data) {
    if (!data || !data.token || !data.user) {
      Fliplet.UI.Toast.error(T('widgets.login.fliplet.errors.unableLogin'));
      hideLoadingState();
      return;
    }

    showLoadingState();

    return Fliplet.Login.updateUserStorage({
      id: data.user.id,
      region: data.token.substr(0, 2),
      userRoleId: data.user.userRoleId,
      authToken: data.token,
      email: data.user.email,
      legacy: data.user.legacy
    }).then(function() {
      return Fliplet.Hooks.run('login', {
        passport: 'fliplet',
        userProfile: data.user
      });
    }).then(function() {
      return Fliplet.Login.validateAccount({ data: data });
    }).then(function() {
      Fliplet.Analytics.trackEvent({
        category: 'login_fliplet',
        action: 'login_pass'
      });

      // Set the login flag so the App List component knows the user
      // arrived from the login screen.
      return Fliplet.Storage.set(LOGIN_FLAG_KEY, true);
    }).then(function() {
      // Reset the button state BEFORE attempting navigation. When the
      // navigation succeeds, the widget unmounts and the reset is a no-op.
      // When `disableSecurity` is true (preview / dev mode), navigation
      // is intentionally skipped — without this reset, the button would
      // be stuck on "Waiting for sign-in…" forever.
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
  // Already-signed-in detection: skip the button entirely if a session is
  // already cached. Unchanged from the previous widget version.
  // ──────────────────────────────────────────────────────────────────────

  function initSession() {
    var preserveSession;

    Fliplet.User.getCachedSession()
      .then(function(session) {
        preserveSession = session;

        var passport = session && session.accounts && session.accounts.flipletLogin;

        if (passport) {
          session.user = Fliplet.Utils.extend(session.user, passport[0]);
          session.user.type = null;
        }

        if (!session || !session.user || session.user.type !== null) {
          return Promise.reject(T('widgets.login.fliplet.errors.sessionNotFound'));
        }

        return Fliplet.Login.updateUserStorage({
          id: session.user.id,
          region: session.auth_token.substr(0, 2),
          userRoleId: session.user.userRoleId,
          authToken: session.user.auth_token,
          email: session.user.email,
          legacy: session.legacy
        });
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

        // Ensures that in preview mode only when no passport is found, user is prompted to login screen
        var hasSessionNoPassport = preserveSession && !preserveSession.server || !preserveSession.server.passports || !Object.keys(preserveSession.server.passports).length;
        var isSourceStudio = preserveSession && preserveSession.client && preserveSession.client.source === 'studio';

        if (isSourceStudio && hasSessionNoPassport) {
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

      if (Fliplet.Env.get('platform') === 'web') {
        openSignInPopup();
      } else {
        openSignInIAB();
      }
    });

    if (Fliplet.Env.get('platform') === 'web') {
      initSession();

      if (Fliplet.Env.get('interact')) {
        // Disable the button in edit mode to prevent accidental clicks
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
