assert = require('assert')
var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

network = require('./network.json').open

try{
	nm.connect(network)
	.then(
		function(connected){
			console.log("connected!");
		},
		function(err){
			console.log("error");
			console.log(err);
		}
	)
}catch (err){
	console.log(err)
}
