assert = require('assert')
var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

network = require('./network.json')

try{
	nm.connect(network)
	.then(
		function(connected){
			nm.disconnect().then(function(){
				console.log("disconnected!");
			})
		},
		function(err){
			console.log("error");
			console.log(err);
		}
	)
}catch (err){
	console.log(err)
}
