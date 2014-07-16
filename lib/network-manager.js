var EventEmitter, NetworkManager, Q, exec, spawn, util, _,
  __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
  __hasProp = {}.hasOwnProperty,
  __extends = function(child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; };

util = require('util');

Q = require('q');

EventEmitter = require('events').EventEmitter;

_ = require('lodash');

exec = require('child_process').exec;

spawn = require('child_process').spawn;

NetworkManager = (function(_super) {
  __extends(NetworkManager, _super);

  NetworkManager.prototype.wireless = 'wlan0';

  NetworkManager.prototype.wired = 'eth0';

  function NetworkManager(options) {
    if (options == null) {
      options = {};
    }
    this.disable = __bind(this.disable, this);
    this.enable = __bind(this.enable, this);
    this.disconnect = __bind(this.disconnect, this);
    this.dhclient_kill = __bind(this.dhclient_kill, this);
    this.dhclient_release = __bind(this.dhclient_release, this);
    this.dhclient = __bind(this.dhclient, this);
    this._connectWEP = __bind(this._connectWEP, this);
    this._connectWPA = __bind(this._connectWPA, this);
    this._write_wpa_password_file = __bind(this._write_wpa_password_file, this);
    this._connectOPEN = __bind(this._connectOPEN, this);
    this.check_connection = __bind(this.check_connection, this);
    this.connect = __bind(this.connect, this);
    this.networks = [];
    this.debug = true;
    if (options.wireless != null) {
      this.wireless = options.wireless;
    }
    if (options.wired != null) {
      this.wired = options.wired;
    }
    this.connectionSpy = setInterval(this.check_connection, 5 * 1000);
    this.killing = false;
    this.connected = false;
    this.enabled = false;
    process.on('SIGINT', (function(_this) {
      return function() {
        console.log('Got SIGINT.  Killing Child Processes');
        _this.clean_connection_processes();
        process.exit(1);
      };
    })(this));
    process.on('SIGTERM', (function(_this) {
      return function() {
        console.log('Got SIGTERM.  Killing Child Processes');
        _this.clean_connection_processes();
        process.exit(1);
      };
    })(this));
    this.commands = {
      scan: 'sudo iwlist :INTERFACE scan',
      stat: 'sudo iwconfig :INTERFACE',
      disable: 'sudo ifconfig :INTERFACE down',
      enable: 'sudo ifconfig :INTERFACE up',
      interfaces: 'sudo iwconfig',
      dhcp: 'sudo dhcpcd :INTERFACE',
      dhcp_disable: 'sudo dhcpcd :INTERFACE -k',
      leave: 'sudo iwconfig :INTERFACE essid ""',
      metric: 'sudo ifconfig :INTERFACE metric :METRIC',
      connect_wep: 'sudo iwconfig :INTERFACE essid ":ESSID" key :PASSWORD',
      connect_wpa: 'sudo wpa_passphrase ":ESSID" :PASSWORD > wpa-temp.conf && sudo wpa_supplicant -D wext -i :INTERFACE -c wpa-temp.conf && rm wpa-temp.conf',
      connect_open: 'sudo iwconfig :INTERFACE essid ":ESSID"'
    };
  }


  /*
  Uses sudo iwlist @wireless scan to scan for public essids/networks
  @returns a promise that resolves with the parsed list of networks or rejects if there is an error
   */

  NetworkManager.prototype.scan = function() {
    var d;
    d = Q.defer();
    this.enable().then((function(_this) {
      return function() {
        var command;
        command = "sudo iwlist " + _this.wireless + " scan";
        exec(command, function(error, stdout, stderr) {
          var content, networks;
          if (error != null) {
            d.reject(error);
            return;
          }
          if (stderr) {
            if (stderr.match(/Device or resource busy/)) {
              _this.emit('warning', false, "Scans are overlapping; slow down update frequency");
              return;
            } else if (stderr.match(/Allocation failed/)) {
              _this.emit('warning', false, "Too many networks for iwlist to handle");
              return;
            } else {
              _this.emit('warning', false, "Got some errors from our scan command: ", stderr);
            }
          }
          if (!stdout) {
            return;
          }
          content = stdout.toString();
          networks = _this.parseScan(content);
          d.resolve(networks);
        });
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.clean_connection_processes = function() {
    if (this.wpa != null) {
      exec('kill ' + this.wpa.pid);
    }
  };

  NetworkManager.prototype.parseScan = function(scanResults) {
    var lines, network, networkCount, networks;
    lines = scanResults.split(/\r\n|\r|\n/);
    networks = [];
    networkCount = 0;
    network = {};
    _.each(lines, function(line) {
      var enc;
      line = line.replace(/^\s+|\s+$/g, "");
      if (line.indexOf("Cell") === 0) {
        networkCount++;
        if (!_.isEmpty(network)) {
          networks.push(network);
        }
        network = {
          last_tick: 0,
          encryption_any: false,
          encryption_wep: false,
          encryption_wpa: false,
          encryption_wpa2: false
        };
        network.address = line.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/)[0];
      } else if (line.indexOf("Channel") === 0) {
        network.channel = line.match(/Channel:([0-9]{1,2})/)[1];
      } else if (line.indexOf("Quality") === 0) {
        network.quality = parseInt(line.match(/Quality=([0-9]{1,2})\/70/)[1]) / 70;
        network.strength = line.match(/Signal level=(-?[0-9]{1,2}) dBm/)[1];
      } else if (line.indexOf("Encryption key") === 0) {
        enc = line.match(/Encryption key:(on|off)/)[1];
        if (enc === "on") {
          network.encryption_any = true;
          network.encryption_wep = true;
        }
      } else if (line.indexOf("ESSID") === 0) {
        network.ssid = line.match(/ESSID:"(.*)"/)[1];
        network.ESSID = network.ssid;
      } else if (line.indexOf("Mode") === 0) {
        network.mode = line.match(/Mode:(.*)/)[1];
      } else if (line.indexOf("IE: IEEE 802.11i/WPA2 Version 1") === 0) {
        network.encryption_wep = false;
        network.encryption_wpa2 = true;
      } else if (line.indexOf("IE: WPA Version 1") === 0) {
        network.encryption_wep = false;
        network.encryption_wpa = true;
      }
    });
    if (!_.isEmpty(network)) {
      networks.push(network);
    }
    return networks;
  };

  NetworkManager.prototype.connect = function(network) {
    var d, p;
    d = Q.defer();
    if (this.connected) {
      p = this.disconnect();
    } else {
      p = Q.defer();
      p.resolve();
      p = p.promise;
    }
    p.then(this.enable).then((function(_this) {
      return function() {
        var err;
        if (network.encryption_wep) {
          p = _this._connectWEP(network);
        } else if (network.encryption_wpa || network.encryption_wpa2) {
          try {
            p = _this._write_wpa_password_file(network).then(_this.dhclient_kill).then(_this._connectWPA);
          } catch (_error) {
            err = _error;
            console.log(err);
            d.reject(err);
          }
        } else {
          p = _this._connectOPEN(network);
        }
        p.then(_this.dhclient).then(function(connected) {
          _this.connected = true;
          _this.emit('connected', network);
          return d.resolve(_this.connected);
        }, function(err) {
          return d.reject(err);
        });
      };
    })(this), function(err) {
      console.log(err);
      return d.reject(err);
    });
    return d.promise;
  };

  NetworkManager.prototype.check_connection = function() {
    var command;
    if (this.connected) {
      console.log("checking connection");
      command = "sudo iwconfig " + this.wireless;
      exec(command, (function(_this) {
        return function(error, stdout, stderr) {
          var content, foundOutWereConnected, lines, networkAddress;
          if (error) {
            console.log("Error getting wireless devices information");
            throw err;
          }
          content = stdout.toString();
          lines = content.split(/\r\n|\r|\n/);
          foundOutWereConnected = false;
          networkAddress = null;
          _.each(lines, function(line) {
            if (line.indexOf("Access Point") !== -1) {
              networkAddress = line.match(/Access Point: ([a-fA-F0-9:]*)/)[1] || null;
              if (networkAddress) {
                foundOutWereConnected = true;
              }
            }
          });
          if (!foundOutWereConnected && _this.connected) {
            console.log("We've disconnected!");
            _this.connected = false;
            _this.emit("disconnected", false);
          } else if (foundOutWereConnected && !_this.connected) {
            console.log("We're connected!");
            _this.connected = true;
            _this.emit("join", false, _this.networks[networkAddress]);
          }
        };
      })(this));
    }
  };

  NetworkManager.prototype._connectOPEN = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo iwconfig " + this.wireless + " essid \"" + network.ESSID + "\"";
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(error);
        console.log(stderr);
        d.reject(error);
        return;
      }
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype._write_wpa_password_file = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo wpa_passphrase \"" + network.ESSID + "\" " + network.PASSWORD + " > /tmp/wpa_supplicant.conf";
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(stdout);
        d.reject(error);
        return;
      }
      return d.resolve(network);
    });
    return d.promise;
  };

  NetworkManager.prototype._connectWPA = function(network) {
    var args, d, ondata, timeout, wpa, wps;
    d = Q.defer();
    args = ["wpa_supplicant", '-d', '-i', this.wireless, '-D', 'wext', '-c', '/tmp/wpa_supplicant.conf'];
    wps = spawn("sudo", args);
    timeout = setTimeout((function(_this) {
      return function() {
        if (!_this.connected) {
          console.log("Re-Connecting");
          exec('kill ' + wps.pid);
          d.reject();
        }
      };
    })(this), 20 * 1000);
    wpa = true;
    this.wpa = wps;
    if (this.debug) {
      wps.stdout.pipe(process.stdout);
      wps.stderr.pipe(process.stdout);
    }
    ondata = function(buf) {
      var connected;
      if ((/CTRL-EVENT-CONNECTED/.test(buf)) || (/Key negotiation completed/.test(buf)) || (/-> GROUP_HANDSHAKE/.test(buf))) {
        connected = true;
        clearInterval(timeout);
        d.resolve(true);
      }
      if (/CTRL-EVENT-DISCONNECTED/.test(buf)) {
        connected = false;
      }
      "wlan0: Association request to the driver failed";
    };
    wps.stdout.on('data', ondata);
    wps.stderr.on('data', ondata);
    wps.on("error", function(err) {
      console.log("error", err);
      return d.reject();
    });
    wps.on("close", function() {
      console.log("close");
      return d.reject();
    });
    return d.promise;
  };

  NetworkManager.prototype._connectWEP = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo iwconfig " + this.wireless + " essid \"" + network.ESSID + "\" key " + network.PASSWORD;
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(error);
        console.log(stderr);
        d.reject(error);
        return;
      }
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype.dhclient = function() {
    var command, d, dhclient;
    d = Q.defer();
    command = "sudo dhclient " + this.wireless;
    dhclient = exec(command, (function(_this) {
      return function(error, stdout, stderr) {
        if (error || stderr) {
          if (stderr.indexOf("RTNETLINK answers: File exists") !== -1) {
            _this.dhclient_release().then(_this.dhclient).then(function() {
              return d.resolve(true);
            });
          } else {
            console.log(stderr);
            d.reject(error);
          }
          return;
        }
        console.log('dhclient!');
        d.resolve(true);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.dhclient_release = function() {
    var command, d;
    d = Q.defer();
    command = "sudo dhclient " + this.wireless + " -r";
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(error);
        console.log(stderr);
        d.reject(error);
        return;
      }
      console.log('dhclient -r');
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype.dhclient_kill = function() {
    var command, d;
    d = Q.defer();
    command = "sudo dhclient " + this.wireless + " -x";
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(error);
        console.log(stderr);
        d.reject(error);
        return;
      }
      console.log('dhclient -k');
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype.disconnect = function() {
    var d;
    d = Q.defer();
    this.dhclient_kill().then((function(_this) {
      return function() {
        var command;
        if (_this.connected) {
          console.log("Disconnecting!");
          command = "sudo iwconfig " + _this.wireless + " essid \"\"";
          return exec(command, function(error, stdout, stderr) {
            if (error || stderr) {
              console.log(error);
              console.log(stderr);
              d.reject(error);
              return;
            }
            console.log("Disconnected!");
            _this.connected = false;
            _this.emit('disconnected');
            _this.clean_connection_processes();
            d.resolve();
          });
        } else {
          return d.resolve();
        }
      };
    })(this), function(err) {
      return d.reject(err);
    });
    return d.promise;
  };

  NetworkManager.prototype.enable = function() {
    var command, d;
    d = Q.defer();
    if (!this.enabled) {
      console.log("Enabling!");
      command = "sudo ifconfig " + this.wireless + " up";
      exec(command, (function(_this) {
        return function(error, stdout, stderr) {
          if (error != null) {
            if (error.message.indexOf("No such device")) {
              _this.emit('fatal', false, "The interface " + _this.wireless + " does not exist.");
              process.exit(1);
            }
            d.reject(error);
            return;
          }
          if (stdout || stderr) {
            _this.emit('error', false, "There was an error enabling the interface" + stdout + stderr);
          }
          console.log("Enabled!");
          _this.enabled = true;
          d.resolve();
        };
      })(this));
    } else {
      d.resolve();
    }
    return d.promise;
  };

  NetworkManager.prototype.disable = function() {
    var command, d;
    d = Q.defer();
    if (this.enabled) {
      console.log("Disabling!");
      command = "sudo ifconfig " + this.wireless + " down";
      exec(command, (function(_this) {
        return function(error, stdout, stderr) {
          if (error != null) {
            if (error.message.indexOf("No such device")) {
              _this.emit('fatal', false, "The interface " + _this.wireless + " does not exist.");
              process.exit(1);
            }
            d.reject(error);
            return;
          }
          if (stdout || stderr) {
            _this.emit('error', false, "There was an error enabling the interface" + stdout + stderr);
          }
          console.log("Enabled!");
          _this.enabled = false;
          d.resolve();
        };
      })(this));
    } else {
      d.resolve();
    }
    return d.promise;
  };

  return NetworkManager;

})(EventEmitter);

module.exports = NetworkManager;
