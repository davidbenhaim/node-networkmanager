assert = require('assert')
var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

network = require('./network.json')

nm.connect(network)
.then(
	function(connected){
		console.log("connected!");
	},
	function(err){
		console.log(err);
	}
)
