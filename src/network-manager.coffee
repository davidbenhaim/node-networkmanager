util = require('util')
Q = require('q')
{EventEmitter} = require('events')
_ = require('lodash')
exec = require('child_process').exec

class NetworkManager extends EventEmitter
  wireless: 'wlan0'
  wired: 'eth0'

  constructor: (options={}) ->
    # List of networks (key is address)
    @networks = []

    # Update interface names
    if options.wireless?
      @wireless = options.wireless

    if options.wired?
      @wired = options.wired

    # ID for connection checking interval
    @connectionSpy = null

    # True if we're shutting down
    @killing = false

    # True if we're connected to a network
    @connected = false

    # Is the wireless interface up?
    @enabled = false

    # Configuration settings
    @commands = {
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
      connect_open: 'sudo iwconfig :INTERFACE essid ":ESSID"',
    }

  ###
  Uses sudo iwlist @wireless scan to scan for public essids/networks
  @returns a promise that resolves with the parsed list of networks or rejects if there is an error
  ###
  scan: ->
    d = Q.defer()
    @enable().then(=>
      command = "sudo iwlist #{@wireless} scan"
      exec(command, (error, stdout, stderr)=>
        if error?
          d.reject(error)
          return

        if stderr
          if stderr.match(/Device or resource busy/)
            @emit('warning', false, "Scans are overlapping; slow down update frequency")
            return
          else if stderr.match(/Allocation failed/)
            @emit('warning', false, "Too many networks for iwlist to handle")
            return
          else
            @emit('warning', false, "Got some errors from our scan command: ", stderr)

        unless stdout
          return

        content = stdout.toString()
        networks = @parseScan(content)
        d.resolve networks
        return
      )
      return
    )
    d.promise

  parseScan: (scanResults) ->
    lines = scanResults.split(/\r\n|\r|\n/)
    networks = []
    networkCount = 0
    network = {}
    _.each lines, (line) ->
      line = line.replace(/^\s+|\s+$/g, "")
      
      # a "Cell" line means that we've found a start of a new network
      if line.indexOf("Cell") is 0
        networkCount++
        networks.push network  unless _.isEmpty(network)
        network =
          last_tick: 0
          encryption_any: false
          encryption_wep: false
          encryption_wpa: false
          encryption_wpa2: false

        network.address = line.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/)[0]
      else if line.indexOf("Channel") is 0
        network.channel = line.match(/Channel:([0-9]{1,2})/)[1]
      else if line.indexOf("Quality") is 0
        network.quality = line.match(/Quality=([0-9]{1,2})\/70/)[1]
        network.strength = line.match(/Signal level=(-?[0-9]{1,2}) dBm/)[1]
      else if line.indexOf("Encryption key") is 0
        enc = line.match(/Encryption key:(on|off)/)[1]
        if enc is "on"
          network.encryption_any = true
          network.encryption_wep = true
      else if line.indexOf("ESSID") is 0
        network.ssid = line.match(/ESSID:"(.*)"/)[1]
      else if line.indexOf("Mode") is 0
        network.mode = line.match(/Mode:(.*)/)[1]
      else if line.indexOf("IE: IEEE 802.11i/WPA2 Version 1") is 0
        network.encryption_wep = false
        network.encryption_wpa2 = true
      else if line.indexOf("IE: WPA Version 1") is 0
        network.encryption_wep = false
        network.encryption_wpa = true
      return

    networks.push network  unless _.isEmpty(network)
    networks

  connect: (network) ->
    d = Q.defer()
    @enable().then(=>
      if network.encryption_wep
        p = @_connectWEP(network)
      else if network.encryption_wpa or network.encryption_wpa2
        p = @_connectWPA(network)
      else 
        p = @_connectOPEN(network)

      p.then((connected)->
        d.resolve(connected)
      , (err)->
        d.reject(err)
      )
      return
    )
    d.promise

  _connectOPEN: (network)->
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\""
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(err)
        console.log(stderr)
        d.reject(error)
        return
      d.resolve(true)
      return
    )
    d.promise

  _connectWPA: (network)->
    d = Q.defer()
    command = "sudo wpa_passphrase \"#{network.ESSID}\" #{network.PASSWORD} > wpa-temp.conf && sudo wpa_supplicant -D wext -i #{@wireless} -c wpa-temp.conf -B && rm wpa-temp.conf"
    child = exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(err)
        console.log(stderr)
        d.reject(error)
        return
      console.log "Connected!"
      d.resolve(true)
      return
    )
    child.stdout.on('data', (data)->
      console.log('stdout: ' + data)
    )
    d.promise
  
  _connectWEP: (network)->
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\" key #{network.PASSWORD}"
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(err)
        console.log(stderr)
        d.reject(error)
        return
      d.resolve(true)
      return
    )
    d.promise

  disconnect: ->

  enable: ->
    d = Q.defer()

    unless @enabled
      console.log "Enabling!"
      command = "sudo ifconfig #{@wireless} up"
      exec(command, (error, stdout, stderr)=>
        if error?
          if error.message.indexOf("No such device")
            @emit('fatal', false, "The interface " + @wireless + " does not exist.")
            process.exit(1)

          d.reject(error)
          return

        if stdout or stderr
          @emit('error', false, "There was an error enabling the interface" + stdout + stderr)
        console.log "Enabled!"
        @enabled = true
        d.resolve()
        return
      )
    else
      d.resolve()

    d.promise


  disable: ->
    command = "sudo ifconfig #{@wireless} down"
  

module.exports = NetworkManager