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

  NetworkManager.prototype.debug = false;

  function NetworkManager(options, Logger) {
    if (options == null) {
      options = {};
    }
    this.Logger = Logger;
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
    if (this.Logger == null) {
      this.Logger = {
        debug: console.log,
        error: console.log,
        log: console.log
      };
    }
    this.networks = [];
    this.processes = {
      dhclient: null,
      wpa: null
    };
    if (process.env.DEBUG) {
      this.debug = true;
    }
    if (options.wireless != null) {
      this.wireless = options.wireless;
    }
    if (options.wired != null) {
      this.wired = options.wired;
    }
    this.connectionSpy = setInterval(this.check_connection, 5 * 1000);
    this.killing = false;
    this.connected = false;
    this.connecting = false;
    this.enabled = false;
    process.on('SIGINT', (function(_this) {
      return function() {
        _this.Logger.log('Got SIGINT.  Killing Child Processes');
        _this.clean_connection_processes().then(function() {
          return process.exit(1);
        });
      };
    })(this));
    process.on('SIGTERM', (function(_this) {
      return function() {
        _this.Logger.log('Got SIGTERM.  Killing Child Processes');
        _this.clean_connection_processes().then(function() {
          return process.exit(1);
        });
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
    var promises;
    promises = [];
    promises.push(this.killProcessByName("wpa_supplicant -d -i" + this.wireless + " -Dwext -c/tmp/wpa_supplicant.conf"));
    this.processes.wpa = null;
    promises.push(this.killProcessByName("dhclient " + this.wireless));
    this.processes.dhclient = null;
    return Q.all(promises);
  };

  NetworkManager.prototype.killProcess = function(pid) {
    var Logger, d;
    d = Q.defer();
    Logger = this.Logger;
    exec("sudo kill " + pid, function(err, stdout, stderr) {
      if ((err && err.code !== 1) || stderr) {
        Logger.log(stderr);
        Logger.log(err.message, err);
        Logger.log(err.code);
        return d.reject();
      }
      Logger.log(stdout);
      return d.resolve();
    });
    return d.promise;
  };


  /* man pkill
  match on full name - not substrings so we don't kill ourselves
  pkill -f -x
  
  EXIT STATUS
       0      One or more processes matched the criteria.
       1      No processes matched.
       2      Syntax error in the command line.
       3      Fatal error: out of memory etc.
   */

  NetworkManager.prototype.killProcessByName = function(name) {
    var Logger, d;
    d = Q.defer();
    Logger = this.Logger;
    exec("sudo pkill -f -x '" + name + "'", function(err, stdout, stderr) {
      if ((err && err.code !== 1) || stderr) {
        Logger.log(stderr);
        Logger.log(err.message);
        return d.reject();
      }
      Logger.log(stdout);
      return d.resolve();
    });
    return d.promise;
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
    this.connecting = true;
    this.emit('connecting', network);
    p.then(this.enable).then((function(_this) {
      return function() {
        var err;
        if (network.encryption_wep) {
          p = _this._connectWEP(network);
        } else if (network.encryption_wpa || network.encryption_wpa2) {
          try {
            p = _this._write_wpa_password_file(network).then(function() {
              return _this.dhclient_kill();
            }).then(_this._connectWPA);
          } catch (_error) {
            err = _error;
            _this.Logger.log(err);
            d.reject(err);
          }
        } else {
          p = _this._connectOPEN(network);
        }
        p.then(function() {
          return _this.dhclient();
        }).then(function(connected) {
          _this.connected = true;
          _this.connecting = false;
          _this.emit('connected', network);
          return d.resolve(_this.connected);
        }, function(err) {
          d.reject(err);
          return _this.emit('connection_failed');
        });
      };
    })(this), (function(_this) {
      return function(err) {
        _this.Logger.log(err);
        _this.emit('connection_failed');
        return d.reject(err);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.check_connection = function() {
    var command;
    if (this.connected) {
      this.Logger.debug("checking connection");
      command = "sudo iwconfig " + this.wireless;
      exec(command, (function(_this) {
        return function(error, stdout, stderr) {
          var content, foundOutWereConnected, lines, networkAddress;
          if (error) {
            _this.Logger.log("Error getting wireless devices information");
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
            _this.Logger.log("We've disconnected!");
            _this.connected = false;
            _this.emit("disconnected", false);
          } else if (foundOutWereConnected && !_this.connected) {
            _this.Logger.log("We're connected!");
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
    exec(command, (function(_this) {
      return function(error, stdout, stderr) {
        if (error || stderr) {
          _this.Logger.error(error);
          _this.Logger.error(stderr);
          d.reject(error);
          return;
        }
        d.resolve(true);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype._write_wpa_password_file = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo wpa_passphrase \"" + network.ESSID + "\" " + network.PASSWORD + " > /tmp/wpa_supplicant.conf";
    exec(command, (function(_this) {
      return function(error, stdout, stderr) {
        if (error || stderr) {
          _this.Logger.log(stdout);
          _this.Logger.error(stderr);
          d.reject(error);
          return;
        }
        return d.resolve(network);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype._connectWPA = function(network, attempt) {
    var d;
    if (attempt == null) {
      attempt = 0;
    }
    d = Q.defer();
    if (!(attempt > 5)) {
      this.clean_connection_processes().then((function(_this) {
        return function() {
          var args, ondata, timeout, wpa, wps;
          args = ["wpa_supplicant", '-d', "-i" + _this.wireless, '-Dwext', '-c/tmp/wpa_supplicant.conf'];
          wps = spawn("sudo", args);
          timeout = setTimeout(function() {
            if (!_this.connected) {
              _this.Logger.log("Re-Connecting");
              _this._connectWPA(network, attempt++).then(function(connected) {
                return d.resolve(connected);
              }, function(err) {
                return d.reject(err);
              });
            }
          }, 20 * 1000);
          wpa = true;
          _this.wpa = wps;
          if (_this.debug) {
            wps.stdout.pipe(process.stdout);
            wps.stderr.pipe(process.stdout);
          }
          ondata = function(buf) {
            var connected;
            if ((/CTRL-EVENT-CONNECTED/.test(buf)) || (/Key negotiation completed/.test(buf)) || (/-> GROUP_HANDSHAKE/.test(buf))) {
              connected = true;
              clearTimeout(timeout);
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
            _this.Logger.log("error", err);
            return d.reject();
          });
          return wps.on("close", function(code) {
            _this.Logger.log("close: " + code);
            if (code) {
              clearTimeout(timeout);
              return d.reject();
            }
          });
        };
      })(this), function(err) {
        return d.reject(err);
      });
    } else {
      d.reject("Cannot Connect");
    }
    return d.promise;
  };

  NetworkManager.prototype._connectWEP = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo iwconfig " + this.wireless + " essid \"" + network.ESSID + "\" key " + network.PASSWORD;
    exec(command, (function(_this) {
      return function(error, stdout, stderr) {
        if (error || stderr) {
          _this.Logger.error(error);
          _this.Logger.error(stderr);
          d.reject(error);
          return;
        }
        d.resolve(true);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.dhclient = function(iface) {
    var d, dhclient;
    d = Q.defer();
    iface = iface || this.wireless;
    this.processes.dhclient = dhclient = spawn("sudo", ["dhclient", iface, "-d"]);
    dhclient.stdout.on('data', (function(_this) {
      return function(data) {
        return _this.Logger.log(data.toString());
      };
    })(this));
    dhclient.stderr.on('data', (function(_this) {
      return function(data) {
        _this.Logger.debug("dhclient error: " + data.toString());
        if (/RTNETLINK answers: File exists/.test(data) || /No working leases in persistent database - sleeping./.test(data)) {
          return _this.killProcess(dhclient.pid).then(_this.dhclient_release).then(_this.dhclient).then(function() {
            return d.resolve();
          });
        } else if (/bound\sto\s[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\s--\srenewal\sin\s\d.*\sseconds\./.test(data)) {
          return d.resolve();
        }
      };
    })(this));
    dhclient.on('close', (function(_this) {
      return function(code) {
        return _this.Logger.log("dhclient closed: " + code);
      };
    })(this));
    dhclient.on('error', (function(_this) {
      return function(err) {
        return _this.Logger.log("dhclient error: " + err);
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.dhclient_release = function(iface) {
    var command, d;
    d = Q.defer();
    iface = iface || this.wireless;
    command = "sudo dhclient " + iface + " -r";
    exec(command, (function(_this) {
      return function(error, stdout, stderr) {
        if (error || stderr) {
          _this.Logger.error(error);
          _this.Logger.error(stderr);
          d.reject(error);
          return;
        }
        _this.Logger.log('dhclient -r');
        d.resolve();
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.dhclient_kill = function(iface) {
    var d;
    d = Q.defer();
    iface = iface || this.wireless;
    this.killProcessByName("dhclient " + iface).then((function(_this) {
      return function() {
        var command;
        command = "sudo dhclient " + iface + " -x";
        return exec(command, function(error, stdout, stderr) {
          if (error || stderr) {
            _this.Logger.error(error);
            _this.Logger.error(stderr);
            d.reject(error);
            return;
          }
          _this.Logger.log('dhclient -k');
          d.resolve(true);
        }, function(err) {
          return d.reject(err);
        });
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype.disconnect = function() {
    var d;
    d = Q.defer();
    this.dhclient_kill().then((function(_this) {
      return function() {
        var command;
        if (_this.connected) {
          _this.Logger.log("Disconnecting!");
          command = "sudo iwconfig " + _this.wireless + " essid \"\"";
          return exec(command, function(error, stdout, stderr) {
            if (error || stderr) {
              _this.Logger.error(error);
              _this.Logger.error(stderr);
              d.reject(error);
              return;
            }
            _this.Logger.log("Disconnected!");
            _this.connected = false;
            _this.emit('disconnected');
            _this.clean_connection_processes().then(function() {
              return d.resolve();
            }, function(err) {
              return d.reject(err);
            });
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
      this.Logger.log("Enabling!");
      command = "sudo ifconfig " + this.wireless + " up";
      exec(command, (function(_this) {
        return function(error, stdout, stderr) {
          if (error != null) {
            if (error.message.indexOf("No such device")) {
              _this.emit('fatal', false, "The interface " + _this.wireless + " does not exist.");
            }
            d.reject(error);
            return;
          }
          if (stdout || stderr) {
            _this.emit('error', false, "There was an error enabling the interface" + stdout + stderr);
          }
          _this.Logger.log("Enabled!");
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
      this.Logger.log("Disabling!");
      command = "sudo ifconfig " + this.wireless + " down";
      this.connecting = false;
      this.clean_connection_processes().then((function(_this) {
        return function() {
          return exec(command, function(error, stdout, stderr) {
            if (error != null) {
              if (error.message.indexOf("No such device")) {
                _this.emit('fatal', false, "The interface " + _this.wireless + " does not exist.");
              }
              d.reject(error);
              return;
            }
            if (stdout || stderr) {
              _this.emit('error', false, "There was an error enabling the interface" + stdout + stderr);
            }
            _this.Logger.log("Disabled!");
            _this.enabled = false;
            d.resolve();
          });
        };
      })(this), function(err) {
        return d.reject(err);
      });
    } else {
      d.resolve();
    }
    return d.promise;
  };

  return NetworkManager;

})(EventEmitter);

module.exports = NetworkManager;
