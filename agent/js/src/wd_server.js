/******************************************************************************
Copyright (c) 2012, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Google, Inc. nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/

var adb = require('adb');
var browser_base = require('browser_base');
var devtools = require('devtools');
var fs = require('fs');
var logger = require('logger');
var path = require('path');
var process_utils = require('process_utils');
var vm = require('vm');
var wd_sandbox = require('wd_sandbox');
var webdriver = require('selenium-webdriver');
var webdriver_http = require('selenium-webdriver/http');
var url = require('url');

/** Allow tests to stub out. */
exports.process = process;

var WD_CONNECT_TIMEOUT_MS_ = 120000;
var DEVTOOLS_CONNECT_TIMEOUT_MS_ = 10000;
var DETACH_TIMEOUT_MS_ = 2000;
var SUBMIT_TIMEOUT_MS_ = 5000;

/** Allow test access. */
exports.WAIT_AFTER_ONLOAD_MS = 10000;

var BLANK_PAGE_URL_ = 'data:text/html;charset=utf-8,';
var GHASTLY_ORANGE_ = '#DE640D';

// onDevToolsMessage_ log levels by message.method, defaults to 'debug'
var DEVTOOLS_METHOD_TO_LEVEL = {
  'Network.dataReceived': 'extra',
  'Network.loadingFinished': 'extra',
  'Network.requestServedFromCache': 'extra',
  'Network.requestServedFromMemoryCache': 'extra',
  'Network.requestWillBeSent': 'extra',
  'Network.responseReceived': 'extra',
  'Timeline.eventRecorded': 'extra',
  'Page.loadEventFired': 'info',
  'Inspector.detached': 'warn',
  'Network.loadingFailed': 'warn',
  'Page.javascriptDialogOpening': 'warn'
};

/**
 * The WebDriverServer is forked by agent_main via './wd_server.js', and is
 * responsible for a single device/browser's WebDriver server.
 *
 * The WebDriverServer and agent_main communicate via IPC messages.  We listen
 * for 'run' and 'abort' messages, and we send back 'done' and 'error' messages.
 *
 * @constructor
 * @return {WebDriverServer} singleton.
 */
function WebDriverServer() {
  'use strict';
  if (WebDriverServer.instance_) {
    return WebDriverServer.instance_;
  }
  WebDriverServer.instance_ = this;
  return this;
}

/** @return {WebDriverServer} singleton. */
WebDriverServer.getInstance = function() {
  'use strict';
  return new WebDriverServer();
};
/** Allow test access. */
exports.WebDriverServer = WebDriverServer;

/**
 * Register for IPC messages from agent_main.
 */
WebDriverServer.prototype.initIpc = function() {
  'use strict';
  exports.process.on('message', function(message) {
    var cmd = (message ? message.cmd : '');
    if ('run' === cmd) {
      this.init(message);
      this.connect();
    } else if ('abort' === cmd) {
      this.done_(new Error('abort'));
    } else {
      logger.error('Unrecognized IPC command %s, message: %j', cmd, message);
    }
  }.bind(this));
};

/**
 * init sets up the WebDriver server with all of the properties it needs to
 * complete a job. It also sets up an uncaught exception handler.
 * This is acts like a constructor
 *
 * @param  {Object} args the IPC message with test run parameters:
 *   #param {string} runNumber run number.
 *   #param {string=} runTempDir a directory for run-specific temporary files.
 *   #param {boolean=} exitWhenDone
 *   #param {number=} timeout in milliseconds.
 *   #param {Object} flags:
 *     #param {string=} browser browser_* class name.
 *     #param ... other browser properties, chromedriver.
 *   #param {Object} task:
 *     #param {string=} browser Selenium browser name, defaults to Chrome.
 *     #param {string=} script webdriverjs script.
 *     #param {string=} url non-script url.
 *     #param ... other task properties, e.g. video.
 */
WebDriverServer.prototype.init = function(args) {
  'use strict';
  if (!this.browser_) {
    // Only set on the first run:
    //
    // Prevent WebDriver calls in onAfterDriverAction/Error from recursive
    // processing in these functions, if they call a WebDriver method.
    // Set it to true before calling a WebDriver method (e.g. takeScreenshot),
    // to false upon completion of that method.
    this.actionCbRecurseGuard_ = false;
    this.app_ = webdriver.promise.controlFlow();
    process_utils.injectWdAppLogging('wd_server', this.app_);
    // Create the browser with the given args.
    this.browser_ = browser_base.createBrowser(this.app_, args);
    this.capabilities_ = undefined;
    this.devTools_ = undefined;
    this.isCacheCleared_ = false;
    this.sandboxApp_ = undefined;
    this.uncaughtExceptionHandler_ = this.onUncaughtException_.bind(this);
    this.wdSandbox_ = undefined;
  }
  // Reset every run:
  this.isDone_ = false;
  this.abortTimer_ = undefined;
  this.devToolsMessages_ = [];
  this.driver_ = undefined;
  this.exitWhenDone_ = args.exitWhenDone;
  this.isRecordingDevTools_ = false;
  this.pageLoadDonePromise_ = undefined;
  this.pcapFile_ = undefined;
  this.runNumber_ = args.runNumber;
  this.isCacheWarm_ = args.isCacheWarm;
  this.screenshots_ = [];
  this.task_ = args.task;
  this.testStartTime_ = undefined;
  this.timeoutTimer_ = undefined;
  this.timeout_ = args.timeout;
  this.videoFile_ = undefined;
  this.runTempDir_ = args.runTempDir || '';
  this.currentStep = null;     // reference pointer to the current step
  this.frameNavigatedScreenshot = true; // take a screenshot when frame navigated message has been received

  // Step for multistep measurements
  this.steps = [];

  this.tearDown_();
};

/**
 * Starts the WebDriver server and schedules a wait for it to be ready.
 *
 * @param {Object} browserCaps capabilities to be passed to Builder.build().
 * @private
 */
WebDriverServer.prototype.startWdServer_ = function(browserCaps) {
  'use strict';
  if (this.browser_.isRunning()) {
    throw new Error('Internal error: prior WD server running unexpectedly');
  }

  // Check for getCapabilities().webdriver? But then what -- exception anyway,
  // so the Browser's startWdServer may as well throw that exception.
  this.browser_.startWdServer(browserCaps);
  // The following needs to be scheduled() because getServerUrl() returns
  // the URL only after the startWdServer_() scheduled action finishes.
  this.app_.schedule('Wait for WD server to become ready', function() {
    var serverUrl = this.browser_.getServerUrl();
    logger.info('WD server URL: %s', serverUrl);
    return webdriver_http.util.waitForServer(serverUrl, WD_CONNECT_TIMEOUT_MS_)
        .then(function() {
      logger.info('WD server is ready');
    }.bind(this));
  }.bind(this));

  logger.debug('WD connect promise setup complete');
};

/**
 * @param {Object} browserCaps browser capabilities used to build the driver.
 * @private
 */
WebDriverServer.prototype.startChrome_ = function(browserCaps) {
  'use strict';
  if (this.browser_.isRunning()) {
    throw new Error('Internal error: prior Chrome running unexpectedly');
  }
  this.browser_.startBrowser(browserCaps, this.runNumber_ === 1);
  this.connectDevTools_();
};

/**
 * connectDevTools_ attempts to create a new devtools instance and attempts to
 * connect it to the webdriver server.
 *
 * @private
 */
WebDriverServer.prototype.connectDevTools_ = function() {
  'use strict';
  this.app_.wait(function() {
    var connected = new webdriver.promise.Deferred();
    var devToolsUrl = this.browser_.getDevToolsUrl();
    if (devToolsUrl) {  // Browser exit resets the URL to undefined.
      var devTools = new devtools.DevTools(devToolsUrl);
      devTools.connect(function() {
        this.devTools_ = devTools;
        this.devTools_.onMessage(this.onDevToolsMessage_.bind(this));
        connected.fulfill(true);
      }.bind(this), function() {
        connected.fulfill(false);
      });
    } else {
      connected.fulfill(false);
    }
    return connected.promise;
  }.bind(this), DEVTOOLS_CONNECT_TIMEOUT_MS_, 'Connect DevTools');
  if (1 === this.task_.timeline || 1 === this.task_['Capture Video']) {
    var timelineStackDepth = (this.task_.timelineStackDepth ?
        parseInt(this.task_.timelineStackDepth, 10) : 0);
    this.tracingCommand_('start', {maxCallStackDepth: timelineStackDepth});
  }
};

/**
 * @param {Error=} err error if the page load failed.
 * @private
 */
WebDriverServer.prototype.onPageLoad_ = function(err) {
  'use strict';
  if (this.pageLoadDonePromise_ && this.pageLoadDonePromise_.isPending()) {
    if (this.timeoutTimer_) {
      global.clearTimeout(this.timeoutTimer_);
      this.timeoutTimer_ = undefined;
    }
    if (this.abortTimer_) {
      global.clearTimeout(this.abortTimer_);
      this.abortTimer_ = undefined;
    }
    if (err) {
      logger.warn('Unable to load page: %s', err.message);
      this.pageLoadDonePromise_.reject(err);
    } else {
      this.pageLoadDonePromise_.fulfill(true);
    }
  }
};

/**
 * @param {Object} message DevTools message:
 *    #param {string} method e.g. 'Page.loadEventFired'.
 * @private
 */
WebDriverServer.prototype.onDevToolsMessage_ = function(message) {
  'use strict';
  if (this.driver_) {
    throw new Error('Internal error: DevTools callback called with WebDriver');
  }
  var level = DEVTOOLS_METHOD_TO_LEVEL[message.method] || 'debug';
  if (logger.isLogging(level)) {
    logger[level].apply(undefined, ['%sDevTools message: %s',
        (this.isRecordingDevTools_ ? '' : '#'), JSON.stringify(message)]);
  }
  if (this.isRecordingDevTools_) {
    this.devToolsMessages_.push(message);
  }
  // If abortTimer_ is set, it means we received an 'Inspector.detached'
  // message, as noted below, so ignore messages until our abortTimer fires.
  if (!this.abortTimer_) {
    if ('Page.loadEventFired' === message.method) {
      if (this.isRecordingDevTools_) {
        this.onPageLoad_();
      }
    } else if('Page.domContentEventFired' === message.method) {

        if(this.currentStep) {
          this.takeScreenshot_(
              this.currentStep.stepCount + '_screen_dom',
              'Step ' + this.currentStep.stepCount + " DOM screenshot");
        }

    }else if('Page.frameNavigated' === message.method && this.frameNavigatedScreenshot) {

      this.frameNavigatedScreenshot = false;

      if(this.currentStep) {
        this.takeScreenshot_(
            this.currentStep.stepCount + '_screen_render',
            'Step ' + this.currentStep.stepCount + " " + message.params.frame.url + " Start Render screenshot");
      }

    }else if ('Inspector.detached' === message.method) {
      if (this.pageLoadDonePromise_ && this.pageLoadDonePromise_.isPending()) {
        // This message typically means that the browser has crashed.
        // Instead of waiting for the timeout, we'll give the browser a couple
        // seconds to paint an error message (for our screenshot) and then fail
        // the page load.
        var err = new Error('Inspector detached on run ' + this.runNumber_ +
            ', did the browser crash?', this.runNumber_);
        this.abortTimer_ = global.setTimeout(
            this.onPageLoad_.bind(this, err), DETACH_TIMEOUT_MS_);
      } else {
        // TODO detach during coalesce?
        logger.warn('%s after Page.loadEventFired?', message.method);
      }
    }
    // We might be able to detect timeouts via Network.loadingFailed and
    // Page.frameStoppedLoading messages. For now we'll let our timeoutTimer
    // handle this.
  }
};

/**
 * @private
 */
WebDriverServer.prototype.onTestStarted_ = function() {
  'use strict';
  this.app_.schedule('Test started', function() {
    this.app_.schedule('Test started', function() {
      logger.info('Test started');
      this.testStartTime_ = Date.now();
    }.bind(this));
  }.bind(this));
};

/**
 * Called by the sandboxed Builder after the user script calls build().
 *
 * @param {Object} driver the built driver instance (real one, not sandboxed).
 * #param {Object} browserCaps browser capabilities used to build the driver.
 * #param {Object} wdNamespace the sandboxed namespace, for app/promise sync.
 */
WebDriverServer.prototype.onDriverBuild = function(driver) {
  'use strict';
  logger.extra('WD post-build callback, driver=%s', driver);
  if (!this.driver_) {
    this.driver_ = driver;
    // The WebDriver server (chromedriver 2.x or ios-driver) is already
    // connected as the only DevTools client.
    // We will get the DevTools events via the "performance" log, and we
    // also cannot use DevTools, only WebDriver API via this.driver_.
    this.clearPageAndStartVideoWd_();
    this.scheduleStartPacketCaptureIfRequested_();
    this.onTestStarted_();
  } else if (this.driver_ !== driver) {
    throw new Error('Internal error: repeat onDriverBuild with wrong driver');
  }
};

/**
 * Save binary PNG screenshot data and register it in the test result.
 *
 * @param {string} fileName The filename to send in the test results.
 * @param {Buffer} screenshot binary PNG data.
 * @param {string=} description screenshot description.
 * @return {webdriver.promise.Promise} resolve(diskPath) of the written file.
 * @private
 */
WebDriverServer.prototype.saveScreenshot_ = function(
    fileName, screenshot, description) {
  'use strict';
  logger.debug('Saving screenshot %s (%d bytes): %s',
      fileName, screenshot.length, description);
  var diskPath = path.join(this.runTempDir_, fileName);
  return process_utils.scheduleFunctionNoFault(this.app_,
      'Write screenshot file ' + diskPath,
      fs.writeFile, diskPath, screenshot).then(function() {
    this.addScreenshot_(fileName, diskPath, description);
    return diskPath;
  }.bind(this));
};

/**
 * Registers an existing sreenshot file in the test result.
 *
 * @param {string} fileName filename to send in the test results.
 * @param {string} diskPath file path on disk.
 * @param {string=} description screenshot description.
 * @private
 */
WebDriverServer.prototype.addScreenshot_ = function(
    fileName, diskPath, description) {
  'use strict';
  logger.debug('Adding screenshot %s (%s): %s',
      fileName, diskPath, description);
  if (1 !== this.task_.pngScreenshot &&
       /\.png$/.test(fileName)) {  // Convert to JPEG.
    var fileNameJPEG = fileName.replace(/\.png$/i, '.jpg');
    var diskPathJPEG = diskPath.replace(/\.png$/i, '.jpg');
    var convertCommand = [diskPath];
    convertCommand.push('-resize', '50%');
    if (this.task_.rotate) {
      convertCommand.push('-rotate', this.task_.rotate);
    }
    // Force the screenshot JPEG quality level to be between 30 and 95.
    var imgQ = (this.task_.imageQuality ?
        parseInt(this.task_.imageQuality, 10) : 0);
    convertCommand.push('-quality', Math.min(Math.max(imgQ, 30), 95));
    convertCommand.push(diskPathJPEG);
    process_utils.scheduleExec(this.app_, 'convert', convertCommand).then(
        function() {
      this.screenshots_.push({
          fileName: fileNameJPEG,
          diskPath: diskPathJPEG,
          contentType: 'image/jpeg',
          description: description
        });
    }.bind(this), function(e) {
      logger.warn('Converting %s PNG->JPEG failed, will use original PNG: %s',
          diskPath, e.message);
      this.screenshots_.push({
          fileName: fileName,
          diskPath: diskPath,
          contentType: 'image/png',
          description: description
        });
    }.bind(this));
  } else {
    var contentType = /\.png$/.test(fileName) ?
        'image/png' : 'application/octet-stream';
    this.screenshots_.push({
        fileName: fileName,
        diskPath: diskPath,
        contentType: contentType,
        description: description
      });
  }
};

/**
 * Capture and save a screenshot, if supported.
 *
 * @param {string} fileNameNoExt filename without the '.png' suffix.
 * @param {string=} description screenshot description.
 * @return {webdriver.promise.Promise} resolve(diskPath) of the written file.
 * @private
 */
WebDriverServer.prototype.takeScreenshot_ = function(
    fileNameNoExt, description) {
  'use strict';
  return this.getCapabilities_().then(function(caps) {
    // Screenshots implemented by the browser class are better than DevTools.
    if (caps.takeScreenshot) {
      logger.extra('Browser supports screenshots, yay');
      return this.browser_.scheduleTakeScreenshot(fileNameNoExt).then(
          function(diskPath) {
        if (diskPath) {
          var fileName = fileNameNoExt + path.extname(diskPath);
          this.addScreenshot_(fileName, diskPath, description);
        }
        return diskPath;  // Could be undefined.
      }.bind(this));
    }
    // DevTools screenshots were introduced in Chrome 26:
    //   http://trac.webkit.org/changeset/138236
    //   /trunk/Source/WebCore/inspector/Inspector.json
    if (this.devTools_ && caps['wkrdp.Page.captureScreenshot']) {
      return this.pageCommand_('captureScreenshot').then(function(result) {
        if (result.data) {
          return this.saveScreenshot_(
              fileNameNoExt + '.png',
              new Buffer(result.data, 'base64'),
              description);
        }
        return undefined;
      }.bind(this));
    }
    if (this.driver_) {
      return this.driver_.takeScreenshot().then(function(screenshot) {
        if (screenshot) {
          return this.saveScreenshot_(
              fileNameNoExt + '.png',
              new Buffer(screenshot, 'base64'),
              description);
        }
        return undefined;
      }.bind(this));
    }
    return undefined;
  }.bind(this)).addErrback(function(e) {  // Ignore errors.
    logger.error('Screenshot failed: %s', e);
    return undefined;
  });
};

/**
 * Called by the sandboxed driver before each command.
 *
 * @param {string} command WebDriver command name.
 */
WebDriverServer.prototype.onBeforeDriverAction = function(command) {
  'use strict';
  if (command.getName() === webdriver.command.CommandName.QUIT) {
    logger.debug('Before WD quit: forget driver, devTools');
    this.driver_ = undefined;
    this.devTools_ = undefined;
  }
};

/**
 * Called by the sandboxed driver after each command completion.
 *
 * @param {string} command WebDriver command name.
 * @param {Object} commandArgs array of command arguments.
 * #param {Object} result command result.
 */
WebDriverServer.prototype.onAfterDriverAction = function(command, commandArgs) {
  'use strict';
  var commandStr = commandArgs[1];
  logger.extra('Injected after command: %s', commandStr);
  if (command.getName() === webdriver.command.CommandName.QUIT) {
    this.driver_ = undefined;
    return;  // Cannot do anything after quitting the browser.
  }
  if (this.actionCbRecurseGuard_) {
    logger.extra('Recursion guard: after');
    return;
  }
  if (!this.testStartTime_ || this.isDone_) {  // Screenshots only in a test.
    return;
  }
  this.app_.schedule('After WD action', function() {
    this.actionCbRecurseGuard_ = true;
    // In lieu of 'finally': reset actionCbRecurseGuard_.
  }.bind(this)).then(function(ret) {
    this.actionCbRecurseGuard_ = false;
    return ret;
  }.bind(this), function(e) {
    this.actionCbRecurseGuard_ = false;
    throw e;
  }.bind(this));
};

/**
 * Called by the sandboxed driver after a command failure.
 *
 * @param {string} command WebDriver command name.
 * @param {Object} commandArgs array of command arguments.
 * @param {Object} e command error.
 */
WebDriverServer.prototype.onAfterDriverError = function(
    command, commandArgs, e) {
  'use strict';
  logger.error('Driver error: %s', e.message);
  this.onAfterDriverAction(command, commandArgs);
};

/**
 * Runs the test in a browser session with the given capabilities.
 *
 * @param {Object} browserCaps browser capabilities to build WebDriver.
 * @private
 */
WebDriverServer.prototype.runTest_ = function(browserCaps) {
  'use strict';
  if (this.task_.script) { //if script is available
    //this.runSandboxedSession_(browserCaps);
    logger.debug(
        "Running scripted test:" +
        "\n---------------------------" +
        "\n%s" +
        "\n---------------------------",
        this.task_.script);
    this.runScriptedTask_(browserCaps);
  } else { //if url was given by form

    //if no script was given but an url by form, change it to a default script and run this instead of only url
    //For default EventName are no "/" (Slashes) allowed, because of distorting path on server
    var defaultScript = "setEventName\tunnamed-event" +
            "\nnavigate\t" + this.task_.url;
    this.task_.script = defaultScript;
    logger.debug(
        "Running non-scripted test, but starting by defaultScript" +
        "\n---------------------------" +
        "\n%s" +
        "\n---------------------------",
        this.task_.script);
    this.runScriptedTask_(browserCaps);
    //this.runPageLoad_(browserCaps);
  }
};

/**
 * @param {Object} command must have 'method' and 'params'.
 * @return {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.devToolsCommand_ = function(command) {
  'use strict';
  // We use a "sender" function because, at startup, our "this.devTools_"
  // is undefined and scheduled, so we can't do:
  //   return process_utils.scheduleFunction(this.app_, command.method,
  //       this.devTools_.sendCommand, command);
  var sender = (function(callback) {
    return this.devTools_.sendCommand(command, callback);
  }.bind(this));
  return process_utils.scheduleFunction(this.app_, command.method, sender);
};

/**
 * @param {string} method command method, e.g. 'navigate'.
 * @param {Object} params command options.
 * @return {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.pageCommand_ = function(method, params) {
  'use strict';
  return this.devToolsCommand_({method: 'Page.' + method, params: params});
};

/**
 * @param {string} method command method, e.g. 'enable'.
 * @param {Object} params command options.
 * @return {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.networkCommand_ = function(method, params) {
  'use strict';
  return this.devToolsCommand_({method: 'Network.' + method, params: params});
};

/**
 * @param {string} method command method, e.g. 'start'.
 * @param {Object} params command options.
 * @return {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.tracingCommand_ = function(method, params) {
  'use strict';
  var message = {method: 'Tracing.' + method};
  if (params) {
    message.params = params;
  }
  return this.devToolsCommand_(message);
};

/**
 * @param {string} method command method. ex. 'evaluate'.
 * @param {Object} params command options
 * @returns {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.runtimeCommand_ = function(method, params) {
    'use strict';
    var message = {method: 'Runtime.' + method};
    if (params) {
        message.params = params;
    }
    return this.devToolsCommand_(message);
};

/**
 * @param {string} frameId frame id from the resource tree.
 * @param {string} color body bgcolor name.
 * @return {webdriver.promise.Promise} resolve({string} responseBody).
 * @private
 */
WebDriverServer.prototype.setPageBackground_ = function(frameId, color) {
  'use strict';
  return this.pageCommand_('setDocumentContent', {
      frameId: frameId,
      html: color ? '<body style="background-color:' + color + ';"/>' : ''
    });
};

/**
 * @return {webdriver.promise.Promise} resolve({Object} capabilities).
 * @private
 */
WebDriverServer.prototype.getCapabilities_ = function() {
  'use strict';
  // Cache the response
  if (this.capabilities_) {
    var done = new webdriver.promise.Deferred();
    done.fulfill(this.capabilities_);
    return done;
  }
  return this.browser_.scheduleGetCapabilities().then(function(caps) {
    this.capabilities_ = caps;
    return caps;
  }.bind(this));
};

/**
 * Blanks out the browser at the beginning of a test, using DevTools.
 *
 * @private
 */
WebDriverServer.prototype.clearPageAndStartVideoDevTools_ = function() {
  'use strict';
  this.getCapabilities_().then(function(caps) {
    if (!this.isCacheCleared_ && !this.isCacheWarm_) {
      if (caps['wkrdp.Network.clearBrowserCache']) {
        this.networkCommand_('clearBrowserCache');
        this.app_.schedule('Cache cleared', function() {
          this.isCacheCleared_ = true;
        }.bind(this));
      }
      if (caps['wkrdp.Network.clearBrowserCookies']) {
        this.networkCommand_('clearBrowserCookies');
      }
    }
  }.bind(this));
  // Navigate to a blank, to make sure we clear the prior page and cancel
  // all pending events.  This isn't strictly required if startBrowser loads
  // "about:blank", but it's still a good idea.
  this.pageCommand_('navigate', {url: BLANK_PAGE_URL_});
  this.app_.timeout(500, 'Load blank startup page');
  this.networkCommand_('enable');
  this.pageCommand_('enable');
  if (1 === this.task_['Capture Video']) {  // Emit video sync, start recording
    this.getCapabilities_().then(function(caps) {
      if (!caps.videoRecording) {
        return;
      }
      // Get the root frameId
      this.pageCommand_('getResourceTree').then(function(result) {
        var frameId = result.frameTree.frame.id;
        // Hold orange(500ms)->white: anchor video to DevTools.
        this.setPageBackground_(frameId, GHASTLY_ORANGE_);
        this.app_.timeout(500, 'Set orange background');
        this.scheduleStartVideoRecording_();
        // Begin recording DevTools before onTestStarted_ fires,
        // to make sure we get the paint event from the below switch to white.
        // This allows us to sync the DevTools trace vs. the video by matching
        // the first DevTools paint event timestamp to the video frame where
        // the background changed from non-white to white.
        this.app_.schedule('Start recording DevTools with video', function() {
          this.isRecordingDevTools_ = true;
        }.bind(this));
        this.app_.timeout(500, 'Hold orange background');
        this.setPageBackground_(frameId);  // White
      }.bind(this));
    }.bind(this));
  }
  // Make sure we start recording DevTools regardless of the video.
  this.app_.schedule('Start recording DevTools', function() {
    this.isRecordingDevTools_ = true;
  }.bind(this));
};

/**
 * Blanks out the browser at the beginning of a test via WebDriver API.
 *
 * @private
 */
WebDriverServer.prototype.clearPageAndStartVideoWd_ = function() {
  'use strict';
  // Navigate to a blank, to make sure we clear the prior page and cancel
  // all pending events.
  this.driver_.get(BLANK_PAGE_URL_ + '<body/>');
  if (1 === this.task_['Capture Video']) {  // Emit video sync, start recording
    this.getCapabilities_().then(function(caps) {
      if (!caps.videoRecording) {
        return;
      }
      // Hold ghastly orange(500ms)->white: anchor video to DevTools.
      this.driver_.executeScript(
        'document.body.style.backgroundColor="' + GHASTLY_ORANGE_ + '";');
      this.app_.timeout(500, 'Set orange background');
      this.scheduleStartVideoRecording_();
      this.app_.timeout(500, 'Hold orange background');
      this.driver_.executeScript(
          'document.body.style.backgroundColor="white";');
    }.bind(this));
  }
};

/**
 * Starts video recording, sets the video file, registers video stop handler.
 * @private
 */
WebDriverServer.prototype.scheduleStartVideoRecording_ = function() {
  'use strict';
  this.getCapabilities_().then(function(caps) {
    var videoFileExtension = caps.videoFileExtension || 'avi';
    var videoFile = path.join(this.runTempDir_, 'video.' + videoFileExtension);
    this.browser_.scheduleStartVideoRecording(
        videoFile, this.onVideoRecordingExit_.bind(this));
    this.app_.schedule('Video record started', function() {
      logger.debug('Video record start succeeded');
      this.videoFile_ = videoFile;
    }.bind(this));
  }.bind(this));
};

/**
 * Starts packet capture if it was requested, sets the pcap file.
 * @private
 */
WebDriverServer.prototype.scheduleStartPacketCaptureIfRequested_ = function() {
  'use strict';
  if (1 === this.task_.tcpdump) {
    var pcapFile = path.join(this.runTempDir_, 'tcpdump.pcap');
    this.browser_.scheduleStartPacketCapture(pcapFile);
    this.app_.schedule('Packet capture started', function() {
      logger.debug('Packet capture start succeeded');
      this.pcapFile_ = pcapFile;
    }.bind(this));
  }
};

/**
 * @param {Object} browserCaps browser capabilities used to build the driver.
 * @private
 */
WebDriverServer.prototype.runPageLoad_ = function(browserCaps) {
  'use strict';
  this.sandboxApp_ = this.app_;
  if (!this.devTools_) {
    this.startChrome_(browserCaps);
  }
  this.clearPageAndStartVideoDevTools_();
  this.scheduleStartPacketCaptureIfRequested_();
  // No page load timeout here -- agent_main enforces run-level timeout.
  this.app_.schedule('Run page load', function() {
    // onDevToolsMessage_ resolves this promise when it detects on-load.
    this.pageLoadDonePromise_ = new webdriver.promise.Deferred();
    if (this.timeout_) {
      this.timeoutTimer_ = global.setTimeout(
          this.onPageLoad_.bind(this, new Error('Page load timeout')),
          this.timeout_ - (exports.WAIT_AFTER_ONLOAD_MS + SUBMIT_TIMEOUT_MS_));
    }
    this.onTestStarted_();
    this.pageCommand_('navigate', {url: this.task_.url});
    return this.pageLoadDonePromise_.promise;
  }.bind(this));
  this.waitForCoalesce_(webdriver, exports.WAIT_AFTER_ONLOAD_MS);
};

/**
 * Executes a wpt script by scheduling each step that needs to communicate
 * with the browser (i.e. navigate, exec, and execAndWait)
 *
 * @param {Object} browserCaps browser capabilities used to build the driver.
 * @private
 */
WebDriverServer.prototype.runScriptedTask_ = function(browserCaps) {
  'use strict';

  this.sandboxApp_ = this.app_;
  if (!this.devTools_) {
    this.startChrome_(browserCaps);
  }
  this.clearPageAndStartVideoDevTools_();
  this.scheduleStartPacketCaptureIfRequested_();
  this.onTestStarted_();

  // start script execution
  this.execScript_(this.task_.script);
};

/**
 * Translates a wpt script to a chain of schedules.
 *
 * Why does that work?
 * @see https://sites.google.com/a/webpagetest.org/docs/private-instances/node-js-agent/async-js
 *
 * @param script
 * @private
 */
WebDriverServer.prototype.execScript_ = function(script) {
  'use strict';

  var additionalHeaders = {}, // map of headers to append to a request
      activityTimeout = 2000, // timeout for result collection
      self = this;            // self reference

  var stepCounter = 1;

  script.split('\n').forEach(function(line, lineNumber) {
    line = line.trim();

    // Executes an action that eventually changes the page of the browser.
    // The app schedule will resume execution, if the Page.onLoad Event
    // have been fired (for this, we set the pageLoadDonePromise_)
    var changePageResolver = function(changePageTriggerFn) {
      // wait for page.onLoad
      this.pageLoadDonePromise_ = new webdriver.promise.Deferred();
      changePageTriggerFn();
      return this.pageLoadDonePromise_.promise;
    }.bind(self);

    // Creates a chain of schedules to change a page and log the
    // resulting devTools messages.
    var changePage = function(cmd, descr) {
      this.app_.schedule(
          descr,
          function() {
            this.frameNavigatedScreenshot = true; // capture screenshot of screen render
            return changePageResolver(cmd);
          }.bind(this)
      );

      this.app_.schedule(
          'Set timeout for collecting DevTools messages',
          function() {
            if(!this.currentStep.logData) {
              logger.debug("LogData is false, so return!");
              return webdriver.promise.fulfilled(true);
            } else {
              return this.app_.timeout(
                  activityTimeout,
                  "Waiting (" + activityTimeout + " ms)"
              );
            }
          }.bind(this)
      ).then( // after timeout
          function() {
            //stop listening
            this.isRecordingDevTools_ = false;

            if(this.currentStep.logData) { this.currentStep.result = this.devToolsMessages_; }

            logger.debug("Written results: " + this.currentStep.result);
            this.devToolsMessages_ = [];
            this.pageLoadDonePromise_ = undefined;
            this.takeScreenshot_(this.currentStep.stepCount + '_screen', 'Step ' + this.currentStep.stepCount + " screenshot")

          }.bind(this)
      );
    }.bind(self);

    // setting cookie by navigating to cookie domain and executing javascript,
    // which sets the cookie
    var cookieSetter = function(m)
    {
      var beginsWith = function (str1, str2)  {
        return str1.slice(0, str2.length) === str2;
      };

      var isPath = beginsWith(m[1], "/"),
          cookieStr = m[2];

      if(m[3]) { cookieStr += " expires=" + m[3]; }
      cookieStr += "; ";


      if(isPath) { cookieStr += "path=" + m[1]; }
      else { cookieStr += "domain=" + m[1]; }

      // 1 Step: navigate to domain
      if(!isPath) {
        var domain = m[1], isForSubDomain = beginsWith(m[1],".");

        if(isForSubDomain) { domain = m[1].substr(1, m[1].length); }
        if(!beginsWith(domain, 'http')) { domain = 'http://' + domain;  }

        self.app_.schedule('navigate to cookie domain to set cookie', function() {

          this.pageLoadDonePromise_ = new webdriver.promise.Deferred();
          if (this.timeout_) {
            this.timeoutTimer_ = global.setTimeout(
                this.onPageLoad_.bind(this, new Error('Page load timeout')),
                this.timeout_ - (exports.WAIT_AFTER_ONLOAD_MS + SUBMIT_TIMEOUT_MS_));
          }

          this.pageCommand_( 'navigate', { url: domain });
          return this.pageLoadDonePromise_.promise;
        }.bind(self));

        // 2 Step: Set cookie
        self.app_.schedule('Setting cookie', function() {
          return this.runtimeCommand_( 'evaluate', { expression : "document.cookie= '" + cookieStr + "'" } );
        }.bind(self));

        // 3 Step: clear cache
        self.app_.schedule('Clearing cache', function() {
          return this.networkCommand_('clearBrowserCache');
        }.bind(self));
      }
      else {
        self.app_.schedule(
            'Setting cookie',
            function() {
              return this.runtimeCommand_( 'evaluate', { expression : "document.cookie= '" + cookieStr + "'" } );
            }.bind(self)
        );
      }
    };

    /**********************************
     * Parsing script here
     *********************************/
    var m = line.match(/^navigate\s+(\S+)$/i);
    if(m) {
      var navigate = function() {
            this.pageCommand_('navigate', { url: m[1] } );
          }.bind(self);

      changePage(navigate, 'Executing navigate');
      return;
    }

    m = line.match(/^setEventName\s+(\S+)$/i);
    if(m) {

      self.app_.schedule('creating new step', function()
      {
        var newStep = {
          eventName : m[1],
          stepCount : stepCounter,
          logData   : true,
          result    : null
        };

        logger.debug("Created new step: " + JSON.stringify(newStep));

        stepCounter++;

        this.steps.push(newStep);
        this.currentStep = newStep;

        //start listening
        this.isRecordingDevTools_ = true;

      }.bind(self));

      return;
    }

    m = line.match(/^setOrientation\s+(\S+)$/i);
    if(m) {
        self.app_.schedule(
            'Setting orientation',
            function() {
                if (m[1] !== "landscape" && m[1] !== "portrait") {
                    logger.warn("Orientation " + m[1] + " unsupported! (Command will be ignored!)");
                    return
                }
                this.browser_.setOrientation(m[1]);
            }.bind(self)
        );
        return;
    }

    // match: "setCookie	http://www.aol.com	TestData=Test; expires=Sat,01-Jan-2000 00:00:00 GMT"
    m = line.match(/^setCookie\s+(\S+)\s+(\S+)\s+expires=(.*)$/i);
    if(m) {

      cookieSetter(m);
      return;
    }

    // match: "setCookie	http://www.aol.com	TestData=Test;"
    m = line.match(/^setCookie\s+(\S+)\s+(\S+)$/i);
    if(m) {

      cookieSetter(m);
      return;
    }

    // match: "setHeader header: value"
    m = line.match(/^setHeader\s+(\S+):\s(.*)$/i);
    if(m) {

      additionalHeaders[m[1]] = m[2];

      self.app_.schedule(
          'Setting header',
          function() {
            return this.networkCommand_(
                'setExtraHTTPHeaders',
                { headers: additionalHeaders });
          }.bind(self)
      );

      return;
    }

    // match: "sleep value"
    m = line.match(/^sleep\s+(\d)$/i);
    if(m) {

      self.app_.schedule(
          'Sleeping',
          function() {
            var wait = function(ms){
               var start = new Date().getTime();
               var end = start;
               while(end < start + ms) {
                 end = new Date().getTime();
              }
            }
            var waitTimeInMs = parseInt(m[1]) * 1000;
            logger.debug("waiting for " + waitTimeInMs + "ms");
            wait(waitTimeInMs);
            logger.debug("waited for " + waitTimeInMs + "ms");
            return ;
          }.bind(self)
      );

      return;
    }

    // match: "addHeader header: value"
    m = line.match(/^addHeader\s+(\S+):\s(.*)$/i);
    if(m) {
      if(! additionalHeaders[m[1]]) {
        additionalHeaders[m[1]] = m[2];

        self.app_.schedule(
            'Adding header',
            function() {
              return this.networkCommand_(
                  'setExtraHTTPHeaders',
                  { headers: additionalHeaders });
            }.bind(self)
        );
      }
      return;
    }

    // match: "resetHeaders"
    m = line.match(/^resetHeaders$/i);
    if(m) {

      self.app_.schedule(
          'Reseting headers',
          function() { additionalHeaders = {}; }
      );
      return;
    }

    // match: "logData 1" or "logData 0"
    m = line.match(/^logData\s+(\d)$/i);
    if(m) {

      self.app_.schedule('setting log state of current step', function()
      {
        // check if given String "1" or "0" equals to boolean TRUE or FALSE
        // see http://stackoverflow.com/questions/7615214/in-javascript-why-is-0-equal-to-false-but-when-tested-by-if-it-is-not-fals
        this.currentStep.logData = m[1]==true;
        logger.debug("Current step does log data: " + this.currentStep.logData);
      }.bind(self));


      return;
    }

    // match: "setActivityTimeout 5000"
    m = line.match(/^setActivityTimeout\s+(\d+)/i);
    if(m) {
      activityTimeout = m[1];
      return;
    }

    // match: "exec myscripthere"
    m = line.match(/^exec\s+(.*)$/i);
    if(m) {
      self.app_.schedule(
          'Executing exec',
          function() {
            return this.runtimeCommand_( 'evaluate', { expression : m[1] } );
          }.bind(self)
      );
      return;
    }

    // match: "execAndWait myscripthere"
    m = line.match(/^execAndWait\s+(.*)$/i);
    if(m) {
      var execAndWait = function() {
            this.runtimeCommand_( 'evaluate', { expression : m[1] } );
          }.bind(self);

      changePage(execAndWait, 'Executing execAndWait');
      return;
    }

    logger.warn("Unsupported script command (will be ignored): " + line);
  });
};

/**
 * Runs the user script in a sandboxed environment.
 *
 * @param {Object} browserCaps browser capabilities to build the driver.
 * @private
 */
WebDriverServer.prototype.runSandboxedSession_ = function(browserCaps) {
  'use strict';
  if (this.sandboxApp_) {
    if (!this.browser_.isRunning()) {
      throw new Error('WD server not running on repeat load');
    }
    // Repeat load with an already running WD server and driver.
    this.runScript_(this.wdSandbox_);
    this.waitForCoalesce_(this.wdSandbox_, exports.WAIT_AFTER_ONLOAD_MS);
  } else {
    this.startWdServer_(browserCaps);
    // The following needs to be scheduled() because getServerUrl() returns
    // the URL only after the startWdServer_() scheduled action finishes.
    this.app_.schedule('Sandbox WD namespace and run the script', function() {
      wd_sandbox.createSandboxedWdNamespace(
          this.browser_.getServerUrl(), browserCaps, this).then(
              function(wdSandbox) {
        this.wdSandbox_ = wdSandbox;
        this.sandboxApp_ = wdSandbox.promise.controlFlow();
        this.sandboxApp_.on(
            wdSandbox.promise.ControlFlow.EventType.IDLE, function() {
          logger.debug('The sandbox control flow has gone idle, history: %j',
              this.sandboxApp_.getHistory());
        }.bind(this));
        // Bring it!
        this.runScript_(wdSandbox);
        this.waitForCoalesce_.bind(wdSandbox, exports.WAIT_AFTER_ONLOAD_MS);
      }.bind(this));
    }.bind(this));
  }
};

/**
 * Schedules the entire webpagetest job. It starts the server,
 * connects the devtools, and uses the webdriver promise manager to schedule
 * the rest of the steps required to execute the job.
 */
WebDriverServer.prototype.connect = function() {
  'use strict';
  var browserCaps = {};
  browserCaps[webdriver.Capability.BROWSER_NAME] = (this.task_.browser ?
      this.task_.browser.toLowerCase() : webdriver.Browser.CHROME);
  var loggingPrefs = {};
  loggingPrefs[webdriver.logging.Type.PERFORMANCE] =
      webdriver.logging.LevelName.ALL;  // DevTools Page, Network, Timeline.
  browserCaps[webdriver.Capability.LOGGING_PREFS] = loggingPrefs;

  this.app_.on(webdriver.promise.ControlFlow.EventType.UNCAUGHT_EXCEPTION,
      function() {
    logger.error('App uncaught exception event: %j',
        Array.prototype.slice.call(arguments));
    this.uncaughtExceptionHandler_.apply(this, arguments);
  }.bind(this));
  this.app_.on('error', function() {
    logger.error('App error event: %j',
        Array.prototype.slice.call(arguments));
    this.uncaughtExceptionHandler_.apply(this, arguments);
  }.bind(this));
  process.on('uncaughtException', function(e) {
    // Likely from a background function that's not ControlFlow-scheduled.
    // Immediately unwind the app's scheduled functions, as if the currently
    // function task threw this exception.
    logger.error('Top-level process uncaught exception: %s', e.message);
    var promise = new webdriver.promise.Deferred(undefined, this.app_);
    promise.reject(e);  // Like throw, only in the ControlFlow.
  }.bind(this));
  // When IDLE is emitted, the app no longer runs an event loop.
  this.app_.on(webdriver.promise.ControlFlow.EventType.IDLE, function() {
    logger.debug('The main control flow has gone idle, history: %j',
        this.app_.getHistory());
  }.bind(this));

  this.app_.schedule('Run the test',
      this.runTest_.bind(this, browserCaps)).addBoth(
          this.done_.bind(this));
};

/**
 * Schedules the user script to run in a sandbox.
 *
 * @param {Object} wdSandbox the context in which the script will run.
 * @private
 */
WebDriverServer.prototype.runScript_ = function(wdSandbox) {
  'use strict';
  this.app_.schedule('Run script', function() {
    var sandbox = {
      console: console,
      setTimeout: global.setTimeout,
      setInterval: global.setInterval,
      webdriver: wdSandbox
    };
    logger.info('Running user script');
    vm.runInNewContext(this.task_.script, sandbox, 'WPT_Job_Script');
    logger.info('User script returned, but not necessarily finished');
  }.bind(this));
};

/**
 * Schedules a wait after the script finishes, to allow post-onLoad
 * activity to finish on the page.
 *
 * @param {Object} wdSandbox the context in which the user script runs.
 * @param {number} timeout how many milliseconds the browser should wait
 *    after the page finishes loading.
 * @private
 */
WebDriverServer.prototype.waitForCoalesce_ = function(wdSandbox, timeout) {
  'use strict';
  this.app_.schedule('Wait for browser', function() {
    logger.info('Test finished, waiting for browser to coalesce');
    this.sandboxApp_.timeout(timeout, 'Waiting for browser to coalesce');
  }.bind(this));
};

/**
 * Unsets per-run variables.
 *
 * @private
 */
WebDriverServer.prototype.tearDown_ = function() {
  'use strict';
  this.driver_ = undefined;
  this.testStartTime_ = undefined;
  this.isRecordingDevTools_ = false;
  if (this.pageLoadDonePromise_) {
    if (this.pageLoadDonePromise_.isPending()) {
      this.pageLoadDonePromise_.cancel('Page load promise never resolved');
    }
    this.pageLoadDonePromise_ = undefined;
  }
  if (this.timeoutTimer_) {
    global.clearTimeout(this.timeoutTimer_);
    this.timeoutTimer_ = undefined;
  }
  if (this.abortTimer_) {
    global.clearTimeout(this.abortTimer_);
    this.abortTimer_ = undefined;
  }
};

/**
 * Gets DevTools messages from the WebDriver PERFORMANCE log type.
 * @private
 */
WebDriverServer.prototype.scheduleGetWdDevToolsLog_ = function() {
  'use strict';
  if (this.devToolsMessages_.length > 0) {  // Must be empty at this point.
    throw new Error(
        'Internal error: DevTools messages were collected for WebDriver: ' +
            this.devToolsMessages_);
  }
  this.driver_.getSession().then(function(session) {
    if (session) {  // If there is no session, logs().get throws an exception.
      this.driver_.manage().logs().get(webdriver.logging.Type.PERFORMANCE)
          .then(function(log) {
        if (!log) {
          throw new Error('Unexpectedly empty WebDriver PERFORMANCE log');
        }
        // Return just the first WebView's DevTools events.
        // Additional WebViews may confuse WebPageTest, ignore them for now.
        var firstWebViewId;
        firstWebViewId = undefined;  // Guaranteed assignment, just for lint:)
        this.devToolsMessages_ = log.reduce(function(messages, entry, index) {
          var wdLoggingMessage;
          try {
            wdLoggingMessage = JSON.parse(entry.message);
          } catch (e) {
            logger.warn('WebDriver Logging entry #%d message is not JSON text',
                index);
            return messages;
          }
          if (!wdLoggingMessage.webview || !wdLoggingMessage.message) {
            logger.warn('WebDriver Logging entry #%d message does not have ' +
                'webdriver or message properties', index);
            return messages;
          }
          if (!firstWebViewId) {
            firstWebViewId = wdLoggingMessage.webview;
          }
          if (firstWebViewId === wdLoggingMessage.webview) {
            messages.push(wdLoggingMessage.message);
          }
          return messages;
        }.bind(this), []);  // Initial messages is [].
        logger.extra('Captured %d DevTools messages for WebView %s',
            this.devToolsMessages_.length, firstWebViewId);
      }.bind(this));
    }
  }.bind(this));
};

/**
 * @param {Error=} e run error.
 * @private
 */
WebDriverServer.prototype.done_ = function(e) {
  'use strict';
  if (this.isDone_) {
    // Our "done_" can be called multiple times, e.g. if we're finishing a
    // successful run but agent_main races to 'abort' us (vs our 'done' IPC).
    return;
  }
  this.isDone_ = true;
  if (e) {
    logger.error('Run failed, stopping: %s', e.stack);
  } else {
    logger.info('Test run succeeded');
  }
  var cmd = (e ? 'error' : 'done');
  var videoFile = this.videoFile_;
  var pcapFile = this.pcapFile_;
  // We must schedule/run a driver quit before we emit 'done', to make sure
  // we take the final screenshot and send it in the 'done' IPC message.
  if (this.driver_) {
    this.scheduleGetWdDevToolsLog_();
  }
  // Don't take screenshot here, because we make screenshots for every step now
  //this.takeScreenshot_('screen', (e ? 'run error' : 'end of run'));
  if (videoFile) {
    this.browser_.scheduleStopVideoRecording();
    process_utils.scheduleFunction(this.app_, 'videoFile exists?',
        fs.exists, this.videoFile_).then(function(exists) {
      if (!exists) {
        logger.error('Video recording failed to create output file');
        this.videoFile_ = undefined;
      }
    }.bind(this));
  }
  if (pcapFile) {
    this.browser_.scheduleStopPacketCapture();
    process_utils.scheduleFunction(this.app_, 'pcapFile exists?',
        fs.exists, this.pcapFile_).then(function(exists) {
      if (!exists) {
        logger.error('Packet capture failed to create output file');
        this.pcapFile_ = undefined;
      }
    }.bind(this));
  }

  this.app_.schedule('Send IPC ' + cmd, function() {
    logger.debug('sending IPC ' + cmd);
    try {
      exports.process.send({
        cmd: cmd,
        e: (e ? e.message : undefined),
        devToolsMessages: this.devToolsMessages_,
        screenshots: this.screenshots_,
        videoFile: this.videoFile_,
        pcapFile: this.pcapFile_,
        steps : this.steps
      });
    } catch (eSend) {
      logger.warn('Unable to send %s message: %s', cmd, eSend.message);
    }
  }.bind(this));
  // For non-webdriver tests we want to stop the browser after every run
  // (including between first and repeat view).
  if (e || this.exitWhenDone_ || !this.driver_) {
    this.scheduleStop();
  }
  if (e || this.exitWhenDone_) {
    // Disconnect parent IPC to exit gracefully without a process.exit() call.
    // This should be the last source of event queue events.
    this.app_.schedule('Disconnect IPC',
      exports.process.disconnect.bind(process));
  }
  this.app_.schedule('Tear down', this.tearDown_.bind(this));
};

/**
 * @param {Error=} e video error if the recording failed.
 * @private
 */
WebDriverServer.prototype.onVideoRecordingExit_ = function(e) {
  'use strict';
  if (e) {
    logger.error('Video recording failed:\n' + e.stack);
    this.videoFile_ = undefined;
    // We could call this.done_(e)
  }
};

/**
 * @param {Error=} e uncaught error.
 * @private
 */
WebDriverServer.prototype.onUncaughtException_ = function(e) {
  'use strict';
  if (!e) {
    e = new Error('unknown');
  }
  logger.critical('Uncaught exception: %s', e.stack);
  this.done_(e);
};

/**
 * Cleans up after a job.
 *
 * First it asks the webdriver server to kill the driver.
 * After that it tries to kill the webdriver server itself.
 */
WebDriverServer.prototype.scheduleStop = function() {
  'use strict';
  // Stop handling uncaught exceptions
  exports.process.removeListener('uncaughtException',
      this.uncaughtExceptionHandler_);
  if (this.driver_) {
    // onAfterDriverAction resets this.driver_ and this.testStartTime_.
    this.driver_.quit().addErrback(function(e) {
      logger.error('Exception from "quit": %s', e);
      logger.debug('%s', e.stack);
    });
  }
  // kill the browser
  this.app_.schedule('Kill server/browser', function() {
    if (this.browser_) {
      this.browser_.kill();
      this.browser_ = undefined;
      this.devTools_ = undefined;
    } else {
      logger.warn('WD launcher is already unset');
    }
  }.bind(this));
};

process_utils.setSystemCommands();

if (require.main === module) {
  try {
    var wds = exports.WebDriverServer.getInstance();
    wds.initIpc();
  } catch (e) {
    console.log(e);
    process.exit(-1);
  }
}
