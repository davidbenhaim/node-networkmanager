var assert = require('assert')
var NetworkManager = require('../lib/network-manager')
var fs = require('fs')

var nm = new NetworkManager()

var network = require('./network.json').wpa

try{
	nm._write_wpa_password_file(network)
	.then(
		function(){
			debugger;
		},
		function(err){
			console.log("error");
			console.log(err);
		}
	)
}catch (err){
	console.log(err)
}
