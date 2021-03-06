util = require('util')
Q = require('q')
{EventEmitter} = require('events')
_ = require('lodash')
exec = require('child_process').exec
spawn = require('child_process').spawn

class NetworkManager extends EventEmitter
  wireless: 'wlan0'
  wired: 'eth0'
  debug: false

  constructor: (options={}, @Logger) ->
    unless @Logger?
      @Logger = console
    # List of networks (key is address)
    @networks = []

    # Debug console
    if process.env.DEBUG
      @debug = true

    # Update interface names
    if options.wireless?
      @wireless = options.wireless

    if options.wired?
      @wired = options.wired

    # ID for connection checking interval
    @connectionSpy = setInterval @check_connection, 5*1000

    # True if we're shutting down
    @killing = false

    # True if we're connected to a network
    @connected = false

    #are we currently trying to connect?
    #TODO
    @connecting = false

    # Is the wireless interface up?
    @enabled = false

    process.on 'SIGINT', () =>
      @Logger.log('Got SIGINT.  Killing Child Processes')
      @clean_connection_processes()
      process.exit(1)
      return

    process.on 'SIGTERM', () =>
      @Logger.log('Got SIGTERM.  Killing Child Processes')
      @clean_connection_processes()
      process.exit(1)
      return

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

  clean_connection_processes: ->
    if @wpa?
      exec('sudo kill ' + @wpa.pid)
    return

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
        network.quality = parseInt(line.match(/Quality=([0-9]{1,2})\/70/)[1])/70
        network.strength = line.match(/Signal level=(-?[0-9]{1,2}) dBm/)[1]
      else if line.indexOf("Encryption key") is 0
        enc = line.match(/Encryption key:(on|off)/)[1]
        if enc is "on"
          network.encryption_any = true
          network.encryption_wep = true
      else if line.indexOf("ESSID") is 0
        network.ssid = line.match(/ESSID:"(.*)"/)[1]
        network.ESSID = network.ssid
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

  connect: (network) =>
    d = Q.defer()
    if @connected
      p = @disconnect()
    else
      p = Q.defer()
      p.resolve()
      p = p.promise

    @connecting = true
    @emit 'connecting', network

    p.then(@enable).then(=>
      if network.encryption_wep
        p = @_connectWEP(network)
      else if network.encryption_wpa or network.encryption_wpa2
        try
          p = @_write_wpa_password_file(network)
          .then(()=>
            @dhclient_kill()
            )
          .then(@_connectWPA)
        catch err
          @Logger.log err
          d.reject err
      else
        p = @_connectOPEN(network)

      p.then(=>
        @dhclient()
      ).then((connected)=>
        @connected = true
        @connecting = false
        @emit 'connected', network
        d.resolve(@connected)
      , (err)->
        d.reject(err)
        @emit 'connection_failed'
      )
      return
    , (err)->
      @Logger.log err
      @emit 'connection_failed'
      d.reject(err)
    )

    d.promise

  check_connection: =>
    if @connected
      @Logger.debug "checking connection"
      command = "sudo iwconfig #{@wireless}"
      exec(command, (error, stdout, stderr) =>
        if error
          @Logger.log "Error getting wireless devices information"
          throw err
        content = stdout.toString()
        lines = content.split(/\r\n|\r|\n/)
        foundOutWereConnected = false
        networkAddress = null
        _.each lines, (line) ->
          if line.indexOf("Access Point") isnt -1
            networkAddress = line.match(/Access Point: ([a-fA-F0-9:]*)/)[1] or null
            foundOutWereConnected = true  if networkAddress
          return

        # guess we're not connected after all
        if not foundOutWereConnected and @connected
          @Logger.log "We've disconnected!"
          @connected = false
          @emit "disconnected", false
        else if foundOutWereConnected and not @connected
          @Logger.log "We're connected!"
          @connected = true
          @emit "join", false, @networks[networkAddress]
        return
      )
    return


  # This probably doesn't work yet
  _connectOPEN: (network)=>
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\""
    exec command, (error, stdout, stderr) =>
      # TODO: what can go wrong here?
      if error or stderr
        @Logger.error(error)
        @Logger.error(stderr)
        d.reject(error)
        return
      d.resolve(true)
      return
    d.promise


  _write_wpa_password_file: (network)=>
    d = Q.defer()
    command = "sudo wpa_passphrase \"#{network.ESSID}\" #{network.PASSWORD} > /tmp/wpa_supplicant.conf"
    exec command, (error, stdout, stderr) =>
      if error or stderr
        @Logger.log stdout
        @Logger.error stderr
        d.reject error
        return
      d.resolve(network)
    d.promise

  _connectWPA: (network) =>
    d = Q.defer()
    @clean_connection_processes()
    args = ["wpa_supplicant", '-d', "-i#{@wireless}", '-Dwext', '-c/tmp/wpa_supplicant.conf']
    wps = spawn("sudo", args)

    timeout = setTimeout(=>
      unless @connected
        @Logger.log "Re-Connecting"
        exec('sudo kill ' + wps.pid)
        @_connectWPA(network)
        .then (connected)->
          d.resolve(connected)
        , (err)->
          d.reject(err)
      return
    , 20*1000)

    wpa = true

    @wpa = wps

    if @debug
      wps.stdout.pipe(process.stdout)
      wps.stderr.pipe(process.stdout)

    ondata = (buf)->
      if (/CTRL-EVENT-CONNECTED/.test(buf)) or (/Key negotiation completed/.test(buf)) or (/-> GROUP_HANDSHAKE/.test(buf))
        connected = true
        clearInterval timeout
        d.resolve(true)
      if (/CTRL-EVENT-DISCONNECTED/.test(buf))
        connected = false
      "wlan0: Association request to the driver failed"
      return

    wps.stdout.on('data', ondata)
    wps.stderr.on('data', ondata)

    wps.on "error", (err) =>
      @Logger.log "error", err
      d.reject()

    wps.on "close", =>
      @Logger.log "close"
      d.reject()

    d.promise

  # This probably doesn't work yet
  _connectWEP: (network)=>
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\" key #{network.PASSWORD}"
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        @Logger.error(error)
        @Logger.error(stderr)
        d.reject(error)
        return
      d.resolve(true)
      return
    )
    d.promise

  dhclient: (iface) =>
    d = Q.defer()
    iface = iface or @wireless
    command = "sudo dhclient #{iface}"
    dhclient = exec command, (error, stdout, stderr) =>
      # TODO: what can go wrong here?
      if error or stderr
        if stderr.indexOf("RTNETLINK answers: File exists") isnt -1
          @dhclient_release()
          .then(=> @dhclient())
          .then(->
            d.resolve(true)
          )
        else
          @Logger.error(stderr)
          d.reject(error)
        return
      @Logger.debug('dhclient!')
      d.resolve(true)
      return
    d.promise

  dhclient_release: (iface) =>
    d = Q.defer()
    iface = iface or @wireless
    command = "sudo dhclient #{iface} -r"
    exec command, (error, stdout, stderr) =>
      # TODO: what can go wrong here?
      if error or stderr
        @Logger.error(error)
        @Logger.error(stderr)
        d.reject(error)
        return
      @Logger.log('dhclient -r')
      d.resolve(true)
      return
    d.promise

  dhclient_kill: (iface) =>
    d = Q.defer()
    iface = iface or @wireless
    command = "sudo dhclient #{iface} -x"
    exec command, (error, stdout, stderr) =>
      # TODO: what can go wrong here?
      if error or stderr
        @Logger.error(error)
        @Logger.error(stderr)
        d.reject(error)
        return
      @Logger.log('dhclient -k')
      d.resolve(true)
      return
    d.promise

  disconnect: =>
    d = Q.defer()
    @dhclient_kill()
    .then =>
      if @connected
        @Logger.log "Disconnecting!"
        command = "sudo iwconfig #{@wireless} essid \"\""
        exec command, (error, stdout, stderr) =>
          if error or stderr
            @Logger.error(error)
            @Logger.error(stderr)
            d.reject(error)
            return
          @Logger.log "Disconnected!"
          @connected = false
          @emit 'disconnected'
          @clean_connection_processes()
          d.resolve()
          return
      else
        d.resolve()
    , (err) ->
      d.reject(err)
    d.promise

  enable: =>
    d = Q.defer()
    unless @enabled
      @Logger.log "Enabling!"
      command = "sudo ifconfig #{@wireless} up"
      exec command, (error, stdout, stderr) =>
        if error?
          if error.message.indexOf("No such device")
            @emit('fatal', false, "The interface " + @wireless + " does not exist.")
            # process.exit(1)

          d.reject(error)
          return

        if stdout or stderr
          @emit('error', false, "There was an error enabling the interface" + stdout + stderr)
        @Logger.log "Enabled!"
        @enabled = true
        d.resolve()
        return
    else
      d.resolve()

    d.promise


  disable: =>
    d = Q.defer()

    if @enabled
      @Logger.log "Disabling!"
      command = "sudo ifconfig #{@wireless} down"
      @dhclient_kill()
      @connecting = false
      @clean_connection_processes()
      exec command, (error, stdout, stderr) =>
        if error?
          if error.message.indexOf("No such device")
            @emit('fatal', false, "The interface " + @wireless + " does not exist.")
            # process.exit(1)

          d.reject(error)
          return

        if stdout or stderr
          @emit('error', false, "There was an error enabling the interface" + stdout + stderr)
        @Logger.log "Disabled!"
        @enabled = false
        d.resolve()
        return
    else
      d.resolve()

    d.promise

module.exports = NetworkManager