var NetworkManager = require('../lib/network-manager')

nm = new NetworkManager()

nm.scan()
.then(
	function(networks){}
		console.log(networks);
	},
	function(err){
		console.log(err);
	}
)
