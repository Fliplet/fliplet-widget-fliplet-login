var widgetId = Fliplet.Widget.getDefaultId();
var data = Fliplet.Widget.getData(widgetId) || {};
var appId = Fliplet.Env.get('appId');
var headingValue = data.heading || 'Welcome to the login of this app';

$('.password-show-checkbox').prop('checked', data.showPassword || false);
$('#login_heading').val(headingValue).trigger('change');

var page = Fliplet.Widget.getPage();
var omitPages = page ? [page.id] : [];

data.action = data.action || {};
data.action.omitPages = omitPages;

checkSecurityRules();

var linkActionProvider = Fliplet.Widget.open('com.fliplet.link', {
  // If provided, the iframe will be appended here,
  // otherwise will be displayed as a full-size iframe overlay
  selector: '#action',
  // Also send the data I have locally, so that
  // the interface gets repopulated with the same stuff
  data: data.action,
  // Events fired from the provider
  onEvent: function(event, data) {
    if (event === 'interface-validate') {
      Fliplet.Widget.toggleSaveButton(data.isValid === true);
    }
  }
});

// 1. Fired from Fliplet Studio when the external save button is clicked
Fliplet.Widget.onSaveRequest(function() {
  $('form').submit();
});

// 2. Fired when the user submits the form
$('form').submit(function(event) {
  event.preventDefault();
  linkActionProvider.forwardSaveRequest();
});

// 3. Fired when the provider has finished
linkActionProvider.then(function(result) {
  data.action = result.data;
  save(true);
});

function save(notifyComplete) {
  data.showPassword = $('.password-show-checkbox').is(':checked');
  data.heading = $('#login_heading').val();
  Fliplet.Widget.save(data).then(function() {
    if (notifyComplete) {
      Fliplet.Widget.complete();
      window.location.reload();
    } else {
      Fliplet.Studio.emit('reload-widget-instance', widgetId);
    }
  });
}

// Shows warning if security setting are not configured correctly
function checkSecurityRules() {
  Fliplet.API.request('v1/apps/' + appId).then(function(result) {
    if (!result || !result.app) {
      return;
    }

    var hooks = _.get(result.app, 'hooks', []);
    var isSecurityConfigured = _.some(hooks, function(hook) {
      return hook.script.indexOf(page.id) !== -1;
    });

    if (!hooks.length) {
      $('#security-alert span').text('app has no security rules configured to prevent unauthorized access.');
    }

    $('#security-alert').toggleClass('hidden', isSecurityConfigured);
  });
}

$('#login_heading').on('keyup change paste blur', $.debounce(function() {
  save();
}, 500));

// Open security overlay
$('#security-alert u').on('click', function() {
  Fliplet.Studio.emit('overlay', {
    name: 'app-settings',
    options: {
      title: 'App Settings',
      size: 'large',
      section: 'appSecurity',
      appId: appId
    }
  });
});
