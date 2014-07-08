var EventEmitter, NetworkManager, Q, exec, spawn, util, _,
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
    this.networks = [];
    if (options.wireless != null) {
      this.wireless = options.wireless;
    }
    if (options.wired != null) {
      this.wired = options.wired;
    }
    this.connectionSpy = null;
    this.killing = false;
    this.connected = false;
    this.enabled = false;
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
        network.quality = line.match(/Quality=([0-9]{1,2})\/70/)[1];
        network.strength = line.match(/Signal level=(-?[0-9]{1,2}) dBm/)[1];
      } else if (line.indexOf("Encryption key") === 0) {
        enc = line.match(/Encryption key:(on|off)/)[1];
        if (enc === "on") {
          network.encryption_any = true;
          network.encryption_wep = true;
        }
      } else if (line.indexOf("ESSID") === 0) {
        network.ssid = line.match(/ESSID:"(.*)"/)[1];
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
    var d;
    d = Q.defer();
    this.enable().then((function(_this) {
      return function() {
        var p;
        if (network.encryption_wep) {
          p = _this._connectWEP(network);
        } else if (network.encryption_wpa || network.encryption_wpa2) {
          p = _this._connectWPA(network);
        } else {
          p = _this._connectOPEN(network);
        }
        p.then(function(connected) {
          return d.resolve(connected);
        }, function(err) {
          return d.reject(err);
        });
      };
    })(this));
    return d.promise;
  };

  NetworkManager.prototype._connectOPEN = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo iwconfig " + this.wireless + " essid \"" + network.ESSID + "\"";
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(err);
        console.log(stderr);
        d.reject(error);
        return;
      }
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype._connectWPA = function(network) {
    var args, command, d, ondata, wpa, wps;
    d = Q.defer();
    command = "sudo wpa_passphrase \"" + network.ESSID + "\" " + network.PASSWORD + " > wpa-temp.conf && sudo wpa_supplicant -D wext -i " + this.wireless + " -c wpa-temp.conf -B && rm wpa-temp.conf";
    args = ['-i', this.wireless, '-D', 'wext', '-c', '/etc/wpa_supplicant.conf'];
    wps = spawn("wpa_supplicant", args, {
      uid: 0,
      stdio: 'pipe'
    });
    wpa = true;
    ondata = function(buf) {
      var connected;
      if (/CTRL-EVENT-CONNECTED/.test(buf)) {
        connected = true;
        d.resolve(true);
      }
      if (/CTRL-EVENT-DISCONNECTED/.test(buf)) {
        return connected = false;
      }
    };
    wps.stdout.on('data', ondata);
    wps.stderr.on('data', ondata);
    return d.promise;
  };

  NetworkManager.prototype._connectWEP = function(network) {
    var command, d;
    d = Q.defer();
    command = "sudo iwconfig " + this.wireless + " essid \"" + network.ESSID + "\" key " + network.PASSWORD;
    exec(command, function(error, stdout, stderr) {
      if (error || stderr) {
        console.log(err);
        console.log(stderr);
        d.reject(error);
        return;
      }
      d.resolve(true);
    });
    return d.promise;
  };

  NetworkManager.prototype.disconnect = function() {};

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
    var command;
    return command = "sudo ifconfig " + this.wireless + " down";
  };

  return NetworkManager;

})(EventEmitter);

module.exports = NetworkManager;
