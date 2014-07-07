assert = require('assert')

var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

nm.scan()
.then(
	function(networks){
		assert(networks.length >= 0, "networks contains a list of networks");
	},
	function(err){
		console.log(err);
	}
)
