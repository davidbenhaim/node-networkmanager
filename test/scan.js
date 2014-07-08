assert = require('assert')

var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

nm.scan()
.then(
	function(networks){
		console.log(JSON.stringify(networks, null, 2));
		assert(networks.length >= 0, "networks contains a list of networks");
	},
	function(err){
		console.log(err);
	}
)
