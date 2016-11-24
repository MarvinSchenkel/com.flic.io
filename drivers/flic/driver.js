const Driver = require('../driver');
const driver = new Driver({
	SERIAL_NR: 'FLIC',
	SERVICE_CONTROL: 'f02adfc026e711e49edc0002a5d5c51b',
});
module.exports = Object.assign(
	{},
	driver.getExports(),
	{ init: (devices, callback) => driver.init(module.exports, devices, callback) }
);
