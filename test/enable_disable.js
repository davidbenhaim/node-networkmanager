assert = require('assert')
var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

network = require('./network.json')

try{
	nm.enable()
	.then(nm.disable)
	.then(function(){
		console.log("disabled!");
	}, function(err){
		console.log(err);
	})
}catch (err){
	console.log(err)
}
