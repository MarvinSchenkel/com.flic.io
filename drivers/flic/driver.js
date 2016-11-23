'use strict';

const DEBUG_FLAG = true;
const convert = require('color-convert');
const kelvinToRgb = require('kelvin-to-rgb');

const bleManager = Homey.wireless('ble');
const devices = new Map();
const states = new Map();

const DEVICE_MAP = {
	BTL201: {
		SERVICE_CONTROL: 'ff06',
	},
	BTL300: {
		SERVICE_CONTROL: 'ff02',
	},
	BTL301W: {
		SERVICE_CONTROL: 'ff08',
	},
	'MESH GARDEN': {
		SERVICE_CONTROL: 'fe03',
	},
	BTL200: {
		SERVICE_CONTROL: 'ff01',
	},
};
const SERVICE_CONTROL_SET = new Set(Object.keys(DEVICE_MAP).map(type => DEVICE_MAP[type].SERVICE_CONTROL));


const SERVICE_MANUFACTURER = '80e4';

const CHAR_SERIALNR = 'da70';
const CHAR_NAME = 'ffff';
const CHAR_COLOR = 'fffc';
const CHAR_EFFECT = 'fffb';

const effects = {
	flash: 0x00,
	pulse: 0x01,
	rainbow: 0x02,
	rainbow_fade: 0x03,
	candle: 0x04,
};

const state2buffer = (state, effect) => {
	if (effect) {
		return new Buffer([
			0x00,
			parseInt(state.effectColor.slice(0, 2), 16),
			parseInt(state.effectColor.slice(2, 4), 16),
			parseInt(state.effectColor.slice(4, 6), 16),
			effects[state.effect],
			0x00,
			(1 - state.effectSpeed) * 0xFF,
			0x00,
		]);
	}
	if (!state.onoff) {
		return new Buffer([0x00, 0x00, 0x00, 0x00]);
	}
	const rgb = state.mode === 'color' ?
		convert.hsv.rgb(state.hue * 360, state.saturation * 50 + 50, state.dim * 100) :
		kelvinToRgb((1 - state.temperature) * 5000 + 1500).map(c => c * state.dim);

	console.log(state.temperature, state.temperature * 4000 + 1500, rgb);
	return new Buffer([0x00, 0xFF / 255 * rgb[0], 0xFF / 255 * rgb[1], 0xFF / 255 * rgb[2]]);
};

const self = module.exports = {
	init(devicesData, callback) {
		console.log('DRIVER LOADED!!', devicesData);
		devicesData.forEach(device => {
			devices.set(device.id, device);
			states.set(device.id, { onoff: 1, hue: 1, saturation: 1, dim: 1, temperature: 0.5, mode: 'color' });

			if (DEBUG_FLAG) {
				let running = true;
				let state = true;
				let i = 0;
				const timeouts = [100, 500, 1000, 2000, 6000, 10000];

				const setState = () => {
					if (running) {
						const date = Date.now();
						console.log('set state', !state, timeouts[i % timeouts.length]);
						return self.capabilities.onoff.set(
							device,
							state = !state,
							() => console.log('DURATION', Date.now() - date) & setTimeout(setState, timeouts[i++ % timeouts.length])
						);
					}
					bleManager.find(device.id, (err, advertisement) => {
						if (err) return console.log('no find', err);
						advertisement.connect((err, peripheral) => {
							if (err) return console.log('no connect', err);
							peripheral.write(
								DEVICE_MAP[device.deviceId].SERVICE_CONTROL,
								CHAR_COLOR, new Buffer([0x00, 0x00, 0x00, 0x22]),
								(err) => {
									if (err) return console.log('no write', err);
								}
							);
							setTimeout(() => peripheral.disconnect(), 3000);
						});
					});
				};


				setInterval(() => {
					running = false;
					setTimeout(() => {
						running = true;
						setState();
					}, 5 * 60 * 1000);
				}, 15 * 60 * 1000);
				setState();
			}
		});

		Homey.manager('flow').on('action.flash', (callback, args) => {
			const state = states.get(args.device.id);
			state.effect = 'flash';
			state.effectColor = args.color.slice(1);
			state.effectSpeed = args.speed;
			self.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.pulse', (callback, args) => {
			const state = states.get(args.device.id);
			state.effect = 'pulse';
			state.effectColor = args.color.slice(1);
			state.effectSpeed = args.speed;
			self.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.candle', (callback, args) => {
			const state = states.get(args.device.id);
			state.effect = 'candle';
			state.effectColor = args.color.slice(1);
			state.effectSpeed = args.speed;
			self.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.rainbow', (callback, args) => {
			const state = states.get(args.device.id);
			state.effect = 'rainbow';
			state.effectColor = '000000';
			state.effectSpeed = args.speed;
			self.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.rainbow_fade', (callback, args) => {
			const state = states.get(args.device.id);
			state.effect = 'rainbow_fade';
			state.effectColor = '000000';
			state.effectSpeed = args.speed;
			self.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.stop_effect', (callback, args) => {
			const state = states.get(args.device.id);
			delete state.effect;
			self.setColor(args.device, callback);
		});

		callback();

	},
	pair(socket) {
		socket.on('list_devices', (data, callback) => {
			console.log('LIST DEVICES');
			bleManager.discover([], 5000, (err, advertisements) => {
				console.log('DISCOVER', advertisements.length);

				advertisements = advertisements || [];
				advertisements = advertisements.filter(advertisement => !devices.has(advertisement.uuid));
				if (advertisements.length === 0) {
					return callback(null, []);
				}
				let failedCount = 0;
				advertisements.forEach(advertisement => {
					console.log('checking advertisement', advertisement.uuid, advertisement.serviceUuids);
					if (advertisement.serviceUuids.some(uuid => SERVICE_CONTROL_SET.has(uuid))) {
						console.log('connecting to', advertisement);
						advertisement.connect((err, peripheral) => {
							if (err) {
								if (++failedCount === advertisements.length) {
									console.log('called callback 1', failedCount, advertisements.length);
									callback(null, []);
								}
								return;
							}
							peripheral.read(SERVICE_MANUFACTURER, CHAR_SERIALNR, (err, serialNumber) => {
								console.log('serialnr', err, (serialNumber || '').toString());
								const deviceId = Object.keys(DEVICE_MAP).find(id => (serialNumber || '').toString().indexOf(id) === 0);
								if (err || !deviceId) {
									peripheral.disconnect();
									if (++failedCount === advertisements.length) {
										console.log('called callback 2', failedCount, advertisements.length);
										callback(null, []);
									}
									return;
								}
								const deviceData = {
									data: {
										id: peripheral.uuid,
										deviceId,
									},
								};
								peripheral.read(DEVICE_MAP[deviceId].SERVICE_CONTROL, CHAR_NAME, (err, name) => {
									peripheral.disconnect();
									if (err) {
										if (++failedCount === advertisements.length) {
											console.log('called callback 3', failedCount, advertisements.length);
											callback(null, []);
										}
										return;
									}
									deviceData.name = name.toString();
									if (callback) {
										console.log('RETURN CLALBACK', [deviceData]);
										callback(null, [deviceData]);
										callback = null;
									} else {
										console.log('EMIT DEVICE', [deviceData]);
										socket.emit('list_devices', [deviceData]);
									}
								});
							});
						});
					} else if(++failedCount === advertisements.length){
						console.log('called callback 0', failedCount, advertisements.length);
						callback(null, []);
					}
				});
			});
		});


		socket.on('add_device', (newDevice) => {
			devices.set(newDevice.data.id, newDevice.data);
			states.set(newDevice.data.id, { onoff: 1, hue: 1, saturation: 1, dim: 1, temperature: 0.5, mode: 'color' });
		});

		socket.on('disconnect', () => {
			console.log('User aborted pairing, or pairing is finished');
		});
	},
	delete(device) {
		devices.delete(device.id);
		states.delete(device.id);
	},
	setEffect(device, callback) {
		console.log('start effect', device.id);
		let date = Date.now();
		bleManager.find(device.id, (err, advertisement) => {
			console.log('find', (date - (date = Date.now())) * -1);
			if (err) return callback(err);
			advertisement.connect((err, peripheral) => {
				console.log('connect', (date - (date = Date.now())) * -1);
				if (err) return callback(err);
				peripheral.write(
					DEVICE_MAP[device.deviceId].SERVICE_CONTROL,
					CHAR_EFFECT,
					state2buffer(states.get(device.id), true),
					(err, result) => {
						console.log('write', (date - (date = Date.now())) * -1);
						callback(err, result);
						setTimeout(() => peripheral.disconnect(), 3000);
					}
				);
			});
		});
	},

	setColor(device, callback) {
		console.log('start', device.id);
		let date = Date.now();
		bleManager.find(device.id, (err, advertisement) => {
			console.log('find', (date - (date = Date.now())) * -1);
			if (err) return callback(err);
			advertisement.connect((err, peripheral) => {
				console.log('connect', (date - (date = Date.now())) * -1);
				if (err) return callback(err);
				peripheral.write(
					DEVICE_MAP[device.deviceId].SERVICE_CONTROL,
					CHAR_COLOR,
					state2buffer(states.get(device.id)),
					(err, result) => {
						console.log('write', (date - (date = Date.now())) * -1);
						callback(err, result);
						setTimeout(() => peripheral.disconnect(), 3000);
					}
				);
			});
		});
	},

	capabilities: {
		onoff: {
			get: (device, callback) => callback(null, Boolean(states.get(device.id).onoff)),
			set: (device, value, callback) => {
				console.log('onoff', value);
				const state = states.get(device.id);
				state.onoff = value;
				self.setColor(device, err => callback(err, value));
			},
		},
		dim: {
			get: (device, callback) => callback(null, states.get(device.id).dim),
			set: (device, value, callback) => {
				console.log('dim', value);
				const state = states.get(device.id);
				state.onoff = true;
				state.dim = value;
				self.setColor(device, err => callback(err, value));
			},
		},
		light_hue: {
			get: (device, callback) => callback(null, states.get(device.id).hue),
			set: (device, value, callback) => {
				console.log('hue', value);
				const state = states.get(device.id);
				state.onoff = true;
				state.hue = value;
				self.setColor(device, err => callback(err, value));
			},
		},
		light_saturation: {
			get: (device, callback) => callback(null, states.get(device.id).saturation),
			set: (device, value, callback) => {
				console.log('saturation', value);
				const state = states.get(device.id);
				state.onoff = true;
				state.saturation = value;
				self.setColor(device, err => callback(err, value));
			},
		},
		light_temperature: {
			get: (device, callback) => callback(null, states.get(device.id).temperature),
			set: (device, value, callback) => {
				console.log('temperature', value);
				const state = states.get(device.id);
				state.onoff = true;
				state.temperature = value;
				self.setColor(device, err => callback(err, value));
			},
		},
		light_mode: {
			get: (device, callback) => callback(null, states.get(device.id).mode),
			set: (device, value, callback) => {
				states.get(device.id).mode = value;
				self.setColor(device, err => callback(err, value));
			},
		},
	},
};
