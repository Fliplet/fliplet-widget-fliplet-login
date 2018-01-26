$('[data-login-id]').each(function() {
  var _this = this,
    errorMessage = '<p>Unable to login. Try again later.</p>',
    loginOptions,
    LABELS = {
      loginDefault: 'Log in',
      loginProcessing: 'Logging in...',
      authDefault: 'Authenticate',
      authProcessing: 'Authenticating...',
      sendDefault: 'Send new code',
      sendProcessing: 'Sending...'
    },
    TWO_FACTOR_ERROR_CODE = 428,
    ONE_TIME_2FA_OPTION = 'onetime';

  _this.$container = $(this);
  _this.id = _this.$container.attr('data-login-id');
  _this.data = Fliplet.Widget.getData(_this.id);
  _this.pvNameStorage = 'fliplet_login_component';
  _this.pvName = 'login_component_' + _this.id;

  document.addEventListener('offline', function() {
    _this.$container.addClass('login-offline');
    scheduleCheck();
  });

  if (Fliplet.Navigate.query.error) {
    _this.$container.find('.login-error-holder').html(Fliplet.Navigate.query.error);
  }

  // INITIATE FUNCTIONS
  function calculateElHeight(el) {
    if (el.hasClass('start')) {
      $('.state[data-state=auth]').removeClass('start').addClass('present');
    }
    var elementHeight = el.outerHeight();
    el.parents('.content-wrapper').css('height', elementHeight);
    el.css('overflow', 'auto');
  }

  $('.forgot-password').on('click', function() {
    var url;
    switch(Fliplet.Env.get('environment')) {
      case 'local': 
        url = 'http://studio.fliplet.local:8080/forgot-password';
        break;
      case 'staging':
        url = 'https://staging2.studio.fliplet.com/forgot-password';
        break;
      default:
        url = 'https://production.studio.fliplet.com/forgot-password';
    }

    Fliplet.Navigate.url(url);
  });

  $('.login-form').on('submit', function(e) {
    e.preventDefault();

    _this.$container.find('.btn-login').addClass('disabled');
    _this.$container.find('.btn-login').html(LABELS.loginProcessing);
    _this.$container.find('.login-error-holder').removeClass('show');
    _this.$container.find('.login-error-holder').html('');

    var userEmail = _this.$container.find('.login_email').val();
    var userPassword = _this.$container.find('.login_password').val();
    loginOptions = {
      email: userEmail,
      password: userPassword,
      session: true,
      passport: true
    };
    login(loginOptions).then(function(response) {
      _this.loginPV.userRoleId = response.userRoleId;
      _this.loginPV.auth_token = response.auth_token;
      _this.loginPV.email = response.email;

      return Fliplet.Security.Storage.update().then(function() {
        return Fliplet.App.Storage.set(_this.pvNameStorage, {
          userRoleId: response.userRoleId,
          auth_token: response.auth_token,
          email: response.email
        });
      });
    }).then(function() {
      _this.$container.find('.btn-login').removeClass('disabled');
      _this.$container.find('.btn-login').html(LABELS.loginDefault);

      if (Fliplet.Env.get('disableSecurity')) {
        return;
      }
      Fliplet.Navigate.to(_this.data.action);
    }).catch(function(err) {
      _this.$container.find('.btn-login').removeClass('disabled');
      _this.$container.find('.btn-login').html(LABELS.loginDefault);
      if (err && err.status === TWO_FACTOR_ERROR_CODE) {
        if (err.responseJSON.condition !== ONE_TIME_2FA_OPTION) {
          $('.two-factor-resend').removeClass('hidden');
        }
        $('.state.present').removeClass('present').addClass('past');
        $('.state[data-state=two-factor-code]').removeClass('future').addClass('present');
        calculateElHeight($('.state.present'));
        return;
      }
      if (err && err.responseJSON) {
        errorMessage = err.responseJSON.message;
      }
      _this.$container.find('.login-error-holder').html(errorMessage);
      _this.$container.find('.login-error-holder').addClass('show');
      calculateElHeight($('.state.present'));
    });

  });

  $('span.back').on('click', function() {
    $('.state.present').removeClass('present').addClass('future');
    $('.state.past').removeClass('past').addClass('present');
    calculateElHeight($('.state.present'));
  });

  $('.two-factor-resend').on('click', function() {
    var _that = $(this);
    $('.help-two-factor').addClass('hidden');
    _that.addClass('disabled');
    _that.html(LABELS.sendProcessing);

    calculateElHeight($('.state[data-state=two-factor-code]'));
    return login(loginOptions).catch(function(err) {
      if (err.status === TWO_FACTOR_ERROR_CODE) {
        _that.removeClass('disabled');
        _that.html(LABELS.sendDefault);
        $('.two-factor-sent').removeClass('hidden');
        calculateElHeight($('.state[data-state=two-factor-code]'));
        return;
      }
      _that.removeClass('disabled');
      _that.html(LABELS.sendDefault);
      $('.two-factor-enable-to-resend').removeClass('hidden');
      calculateElHeight($('.state[data-state=two-factor-code]'));
    });
  });

  $('.fliplet-two-factor').on('submit', function(e) {
    e.preventDefault();
    var twoFactorCode = $('.two-factor-code').val();
    _this.$container.find('.two-factor-btn').addClass('disabled');
    _this.$container.find('.two-factor-btn').html(LABELS.authProcessing);

    if (twoFactorCode === '') {
      $('.two-factor-not-valid').removeClass('hidden');
      calculateElHeight($('.state[data-state=two-factor-code]'));
      return;
    }
    $('.help-two-factor').addClass('hidden');
    loginOptions.twofactor = twoFactorCode;
    login(loginOptions).then(function(userData) {
      _this.loginPV.userRoleId = userData.userRoleId;
      _this.loginPV.auth_token = userData.auth_token;
      _this.loginPV.email = userData.email;
      return Fliplet.Security.Storage.update().then(function() {
        return Fliplet.App.Storage.set(_this.pvNameStorage, {
          auth_token: userData.auth_token,
          userRoleId: userData.userRoleId,
          email: userData.email
        });
      });
    }).then(function() {
      _this.$container.find('.two-factor-btn').removeClass('disabled');
      _this.$container.find('.two-factor-btn').html(LABELS.authDefault);

      if (Fliplet.Env.get('disableSecurity')) {
        return;
      }

      Fliplet.Navigate.to(_this.data.action);
    }).catch(function(error) {
      _this.$container.find('.two-factor-btn').removeClass('disabled');
      _this.$container.find('.two-factor-btn').html(LABELS.authDefault);
      $('.two-factor-not-valid').removeClass('hidden');
      calculateElHeight($('.state[data-state=two-factor-code]'));
    });
  });

  function showStart(){
    setTimeout(function(){
      $('[data-login-id="'+_this.id+'"] .login-loader-holder').fadeOut(100, function() {
        $('[data-login-id="'+_this.id+'"] .login-form-holder').fadeIn(300);
        calculateElHeight($('.state.start'));
      });
    }, 100);
  }

  function init() {
    _this.loginPV = {};
    Fliplet.User.getCachedSession()
      .then(function(session) {
        if (session && session.accounts && session.accounts.flipletLogin) {
          _this.loginPV = session.accounts.flipletLogin[0];

          if (!Fliplet.Navigator.isOnline() && !Fliplet.Env.get("disableSecurity")) {
            Fliplet.Navigate.to(_this.data.action);
            return;
          }

          validateWeb()
            .then(function() {
              if (Fliplet.Env.get('disableSecurity')) {
                console.warn('Fliplet Login component tried to navigate to a page, but security is disabled.');
                showStart();
                return;
              }

              Fliplet.Navigate.to(_this.data.action);
            }, function() {
              showStart();
            });
        }

        showStart();
      });
  }

  function validateWeb() {
    //validate token
    return request({
      method: 'GET',
      url: 'v1/user',
      token: _this.loginPV.auth_token
    });
  }

  function login(options) {
    return Fliplet.Session.run({
      method: 'POST',
      url: 'v1/auth/login',
      data: options
    });
  }

  function request(data) {
    //validate token
    return Fliplet.Navigator.onReady().then(function() {
      data.url = Fliplet.Env.get('apiUrl') + data.url;
      data.headers = data.headers || {};
      data.headers['Auth-token'] = data.token;
      return $.ajax(data);
    });
  }

  function scheduleCheck() {
    setTimeout(function() {
      if (Fliplet.Navigator.isOnline()) {
        _this.$container.removeClass('login-offline');
        return;
      }
      scheduleCheck();
    }, 500);
  }

  if (Fliplet.Env.get('platform') === 'web') {

    init();

    if (Fliplet.Env.get('interact')) {
      // Disables password fields in edit mode to avoid password autofill
      $('input[type="password"]').prop('disabled', true);
    }

    Fliplet.Studio.onEvent(function(event) {
      if (event.detail.event === 'reload-widget-instance') {
        setTimeout(function() {
          _this.$container.removeClass('hidden');
        }, 500);
      }
    });
    _this.$container.on("fliplet_page_reloaded", function() {
      if (Fliplet.Env.get('interact')) {
        setTimeout(function() {
          _this.$container.removeClass('hidden');
        }, 500);
      }
    });
  } else {
    document.addEventListener("deviceready", init);
  }
});
