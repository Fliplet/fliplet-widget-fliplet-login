(function() {
  var Fliplet = window.Fliplet || {};

  Fliplet.Login = (function() {
    var storageName = 'fliplet_login_component';
    var skipSetupStorageName = 'skipFlipletAccountSetup';

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
     * Get latest user data
     * @returns {Promise} Promise is resolved when user data is returned
     */
    function getUserData() {
      return Fliplet.App.Storage.get(storageName).then(function(storage) {
        storage = storage || {};

        return Fliplet.API.request({
          url: 'v1/user',
          headers: {
            'Auth-token': storage.auth_token
          }
        });
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

        return data.mustLinkTwoFactor
          || data.mustUpdateProfile
          || _.get(data, 'mustReviewAgreements', []).length
          || _.get(data, 'policy.password.mustBeChanged');
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
            return Promise.resolve(response);
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
        return userMustSetupAccount(response).then(function(setupRequired) {
          return new Promise(function(resolve, reject) {
            if (setupRequired) {
              goToAccountSetup().then(resolve).catch(reject);
            } else {
              resolve();
            }
          });
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
      setSkipSetupStorage: setSkipSetupStorage
    };
  }());

  var cacheKey = 'accountValidation';

  Fliplet.Cache.get({
    key: cacheKey,
    expire: 60 * 60 * 12 // Keep cache for half a day
  }, function onFetchData() {
    return Fliplet.Login.validateAccount().catch(function() {
      // Validation was not completed, clear cache to make sure the check continues
      Fliplet.Cache.remove(cacheKey);
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
