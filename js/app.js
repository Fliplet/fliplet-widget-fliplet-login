(function() {
  var Fliplet = window.Fliplet || {};

  Fliplet.Login = (function() {
    var ORG_ADMIN_ROLE_ID = 1; // This role ID is assigned to Fliplet Studio user who is an organization admin
    var FLIPLET_ADMIN_ROLE_ID = 1; // This is user role ID which is only assigned to Fliplet Staff
    var storageName = 'fliplet_login_component';
    var skipSetupStorageName = 'skipFlipletAccountSetup';

    // Master app and production app IDs for the deployed Dev Environment Dashboards.
    var DEV_ENVIRONMENT_APPS = {
      'https://env.fliplet.com/': [436446, 436447],
      'https://staging-apps.fliplet.com/': [511849, 511850],
      'https://apps.fliplet.test/': [11, 12]
    };

    /**
     * Creates user profile data
     * @param {Object} data - Input data
     * @param {Number} data.id - User ID
     * @param {String} data.region - Data region
     * @returns {Object} User profile data
     */
    function createUserProfile(data) {
      data = data || {};

      if (!data.id || !data.region) {
        console.warn('Could not create user object for Fliplet.Profile');

        return;
      }

      return {
        type: 'fliplet',
        id: data.id,
        region: data.region
      };
    }

    /**
     * Update local storage values with user data
     * @param {Object} data - Input data
     * @param {Number} data.id - User ID
     * @param {String} data.region - Data region
     * @param {Number} data.userRoleId - User system role ID
     * @param {String} data.authToken - User auth token
     * @param {String} data.email - User email
     * @returns {Promise} Promise is resolved with local storages are updated
     */
    function updateUserStorage(data) {
      data = data || {};

      var user = createUserProfile({
        region: data.region,
        id: data.id
      });

      var promises = [
        Fliplet.App.Storage.set(storageName, {
          userRoleId: data.userRoleId,
          auth_token: data.authToken,
          email: data.email
        }),
        Fliplet.Profile.set({
          email: data.email,
          user: user
        })
      ];

      return Promise.all(promises);
    }

    /**
     * Get latest user data and attach organization data to it
     * @returns {Promise} Promise is resolved when user data is returned
     */
    function getUserData() {
      var storage;

      return Fliplet.App.Storage.get(storageName).then(function(response) {
        storage = response || {};

        return Fliplet.API.request({
          url: 'v1/user',
          headers: {
            'Auth-token': storage.auth_token
          }
        });
      }).then(function(response) {
        // Add organization data to response
        return Fliplet.API.request({
          url: 'v1/organizations',
          headers: {
            'Auth-token': storage.auth_token
          }
        }).then(function(data) {
          _.set(response, 'userOrganizations', _.get(data, 'organizations', []));

          return response;
        });
      });
    }

    /**
     * Verify that the given user is allowed to access the current app when it
     * is a Dev Environment Dashboard (Fliplet Admins only). Logs the user out
     * and rejects on failure; resolves silently otherwise.
     * @param {Object} user - User object exposing userRoleId
     * @returns {Promise} Resolves if allowed, rejects with i18n error if not
     */
    function verifyUserForDevEnvApp(user) {
      var allowedAppIds = DEV_ENVIRONMENT_APPS[Fliplet.Env.get('appsUrl')];
      var isDevEnvApp = Array.isArray(allowedAppIds)
        && allowedAppIds.indexOf(Fliplet.Env.get('appId')) !== -1;

      if (!isDevEnvApp || !user || user.userRoleId === FLIPLET_ADMIN_ROLE_ID) {
        return Promise.resolve();
      }

      // Tear down the session so the user isn't left authenticated-but-blocked
      return Fliplet.Session.logout().catch(function(err) {
        console.warn('[verifyUserForDevEnvApp] Failed to log out blocked user:', err);
      }).then(function() {
        var error = new Error(T('widgets.login.fliplet.errors.userNotAFlipletAdmin'));

        error.code = 'USER_NOT_FLIPLET_ADMIN';

        return Promise.reject(error);
      });
    }

    function isOrganizationAdmin(data) {
      return !!_.find(data.userOrganizations, {
        organizationUser: {
          organizationRoleId: ORG_ADMIN_ROLE_ID
        }
      });
    }

    /**
     * Determines whether the user needs to set up their account
     * @param {Object} data - User data
     * @param {Boolean} data.mustLinkTwoFactor - Whether the user needs to set up 2FA
     * @param {Boolean} data.mustUpdateAgreements - Whether the user needs to agree to the latest terms of use
     * @param {Boolean} data.policy.password.mustBeChanged - Whether the user needs to change their password
     * @returns {Promise<Boolean>} If TRUE, the user must set up their account
     */
    function userMustSetupAccount(data) {
      return Fliplet.Storage.get(skipSetupStorageName).then(function(skip) {
        if (skip) {
          return false;
        }

        data = data || {};

        var ssoCredential = _.find(data.credentialTypes, function(credential) {
          return credential.type.indexOf('sso-') === 0;
        });
        var userIsLinkedToSso = !!(ssoCredential && _.keys(_.get(data, 'user.preferences.sso')).length);
        var mustLinkTwoFactor = !userIsLinkedToSso && data.mustLinkTwoFactor;
        var agreements = data.mustReviewAgreements || [];
        var hasAgreementsToReview = agreements.length
          && (!_.isEqual(agreements, ['tos']) || isOrganizationAdmin(data));
        var passwordMustBeChanged = !userIsLinkedToSso && _.get(data, 'policy.password.mustBeChanged');

        return mustLinkTwoFactor
          || data.mustUpdateProfile
          || hasAgreementsToReview
          || passwordMustBeChanged;
      });
    }

    /**
     * Takes the user to set up their account in an in-app browser
     * @returns {Promise} Promise is resolved if or when the account is correctly set up
     */
    function goToAccountSetup() {
      return Fliplet.App.Storage.get(storageName).then(function(storage) {
        storage = storage || {};

        var defaultShare = Fliplet.Navigate.defaults.disableShare;

        Fliplet.Navigate.defaults.disableShare = true;

        return new Promise(function(resolve, reject) {
          Fliplet.Navigate.url({
            url: (Fliplet.Env.get('primaryApiUrl') || Fliplet.Env.get('apiUrl')) + 'v1/auth/redirect?auth_token=' + storage.auth_token + '&utm_source=com.fliplet.login',
            inAppBrowser: true,
            onclose: function() {
              validateAccount().then(resolve).catch(reject);
            }
          }).then(function() {
            Fliplet.Navigate.defaults.disableShare = defaultShare;
          });
        });
      });
    }

    /**
     *
     * @param {Object} options - A map of options for the function
     * @param {Object} [options.data=false] - User data
     * @param {Boolean} [updateUserStorage=false] - If TRUE, the local user storage will be updated after the latest data is retrieved
     * @returns {Promise} Promise is resolved when the account is validated or set up is completed
     */
    function validateAccount(options) {
      options = options || {};

      var getData;

      if (options.data) {
        getData = Promise.resolve(options.data);
      } else {
        // User data is not present, get the latest user data
        getData = getUserData().then(function(response) {
          if (!options.updateUserStorage) {
            return response;
          }

          return updateUserStorage({
            id: response.user.id,
            region: response.region,
            userRoleId: response.user.userRoleId,
            authToken: response.user.auth_token,
            email: response.user.email,
            legacy: response.user.legacy
          }).then(function() {
            return response;
          });
        });
      }

      return getData.then(function(response) {
        return verifyUserForDevEnvApp(_.get(response, 'user')).then(function() {
          return response;
        });
      }).then(function(response) {
        return userMustSetupAccount(response).then(function(setupRequired) {
          if (setupRequired) {
            return goToAccountSetup();
          }
        }).then(function() {
          Fliplet.Hooks.run('flipletAccountValidated');
        });
      });
    }

    /**
     * Set a storage value that indicates the account setup flags should be ignored
     * @param {Boolean} value - If TRUE, account setup flags will be ignored
     * @returns {Promise<Boolean>} Promise is resolved with the storage value is set
     */
    function setSkipSetupStorage(value) {
      return Fliplet.App.Storage.set(skipSetupStorageName, !!value);
    }

    return {
      updateUserStorage: updateUserStorage,
      validateAccount: validateAccount,
      verifyUserForDevEnvApp: verifyUserForDevEnvApp,
      setSkipSetupStorage: setSkipSetupStorage
    };
  }());

  var cacheKey = 'accountValidation';

  Fliplet.Cache.get({
    key: cacheKey,
    expire: 60 * 60 * 12 // Keep cache for half a day
  }, function onFetchData() {
    return Fliplet.Login.validateAccount().catch(function(error) {
      // Surface the admin-gate rejection to the user on boot — unlike the
      // login-time paths, this one has no UI handler upstream.
      if (error && error.code === 'USER_NOT_FLIPLET_ADMIN') {
        Fliplet.UI.Toast.error(error, { message: error.message });
      }

      return Promise.reject(error);
    });
  });

  Fliplet.Hooks.on('login', function(data) {
    data = data || {};

    // User logged in using another passport
    if (data.passport !== 'fliplet') {
      return;
    }

    // Clear cache to make sure account validation occurs
    Fliplet.Cache.remove(cacheKey);

    // Set app storage flag so validation results can be ignored for impersonated users
    Fliplet.Login.setSkipSetupStorage(_.get(data, 'userProfile.impersonatedFrom'));

    Fliplet.Hooks.on('flipletAccountValidated', function() {
      // When account is validated, set cache to avoid another immediate check on the next page
      Fliplet.Cache.set(cacheKey, true);
    });
  });
})();
