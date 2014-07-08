util = require('util')
Q = require('q')
{EventEmitter} = require('events')
_ = require('lodash')
exec = require('child_process').exec
spawn = require('child_process').spawn

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

    process.on 'SIGINT', ()=>
      console.log('Got SIGINT.  Killing Child Processes')
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
      @wpa.kill()
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
        try
          p = @_connectWPA(network)
        catch err
          console.log err
          d.reject err
      else 
        p = @_connectOPEN(network)

      p.then(@dhclient).then((connected)->
        console.log 'connected here'
        d.resolve(connected)
      , (err)->
        d.reject(err)
      )
      return
    , (err)->
      console.log err
    )
    d.promise

  # This probably doesn't work yet
  _connectOPEN: (network)->
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\""
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(error)
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
    
    args = ['-d', '-i', @wireless, '-D', 'wext', '-c', '/etc/wpa_supplicant.conf']
    wps = spawn("wpa_supplicant", args, {uid: 0})
    wpa = true
    
    @wpa = wps

    wps.stdout.pipe(process.stdout)
    wps.stderr.pipe(process.stdout)
    
    ondata = (buf)->
      console.log "here"
      if (/CTRL-EVENT-CONNECTED/.test(buf)) or (/Key negotiation completed/.test(buf)) or (/-> GROUP_HANDSHAKE/.test(buf))
        connected = true
        d.resolve(true)
      if (/CTRL-EVENT-DISCONNECTED/.test(buf)) 
        connected = false
      return

    wps.stdout.on('data', ondata)
    wps.stderr.on('data', ondata)

    wps.on "error", ->
      console.log "error"
      d.reject()

    wps.on "close", ->
      console.log "close"
      d.reject()

    d.promise
  
  # This probably doesn't work yet
  _connectWEP: (network)->
    d = Q.defer()
    command = "sudo iwconfig #{@wireless} essid \"#{network.ESSID}\" key #{network.PASSWORD}"
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(error)
        console.log(stderr)
        d.reject(error)
        return
      d.resolve(true)
      return
    )
    d.promise

  dhclient: =>
    d = Q.defer()
    command = "sudo dhclient #{@wireless}"
    dhclient = exec(command, (error, stdout, stderr)=>
      # TODO: what can go wrong here?
      if error or stderr
        if stderr.indexOf("RTNETLINK answers: File exists") isnt -1
          @dhclient_release().then(@dhclient).then(->
            d.resolve(true)
          )
        else
          console.log(stderr)
          d.reject(error)
        return
      console.log('dhclient!')
      d.resolve(true)
      return
    )
    d.promise

  dhclient_release: =>
    d = Q.defer()
    command = "sudo dhclient #{@wireless} -r"
    exec(command, (error, stdout, stderr)->
      # TODO: what can go wrong here?
      if error or stderr
        console.log(error)
        console.log(stderr)
        d.reject(error)
        return
      console.log('dhclient -r')
      d.resolve(true)
      return
    )
    d.promise

  disconnect: =>
    d = Q.defer()

    if @connected
      console.log "Disconnecting!"
      command = "sudo iwconfig #{@wireless} essid \"\""
      exec(command, (error, stdout, stderr)=>
        if error or stderr
          console.log(error)
          console.log(stderr)
          d.reject(error)
          return
        console.log "Disconnected!"
        @connected = false
        @clean_connection_processes()
        d.resolve()
        return
      )
    else
      d.resolve()

    d.promise

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
    d = Q.defer()

    if @enabled
      console.log "Disabling!"
      command = "sudo ifconfig #{@wireless} down"
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
        @enabled = false
        d.resolve()
        return
      )
    else
      d.resolve()

    d.promise

module.exports = NetworkManager