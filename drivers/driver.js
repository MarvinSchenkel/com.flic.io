'use strict';

const DEBUG_FLAG = false;
const convert = require('color-convert');
const kelvinToRgb = require('kelvin-to-rgb');

const bleManager = Homey.wireless('ble');

const SERVICE_MANUFACTURER = '1800';

const CHAR_SERIALNR = '2a00';
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

module.exports = class MipowDriver {
	constructor(config) {
		this.SERIAL_NR = 'F0';
		this.SERVICE_CONTROL = config.SERVICE_CONTROL;

		this.devices = new Map();
		this.state = new Map();
	}

	init(exports, devices, callback) {
		Homey.log('Initializing driver for', this.SERIAL_NR);
		this.realtime = (device, cap, val) => this.getDevice(device) && exports.realtime(this.getDevice(device), cap, val);
		this.setAvailable = device => this.getDevice(device) && exports.setAvailable(this.getDevice(device));
		this.setUnavailable = (device, message) => this.getDevice(device) && exports.setUnavailable(this.getDevice(device), message);
		this.getName = (device, callback) => this.getDevice(device) && exports.getName(this.getDevice(device), callback);
		devices.forEach(device => {
			this.add(device);

			// Notice, this piece of code is only used for debug purposes related to the BLE api and not to this app.
			// DEBUG_FLAG should therefore always be false
			if (DEBUG_FLAG) {
				let running = true;
				let state = true;
				let i = 0;
				const timeouts = [100, 500, 1000, 2000, 6000, 10000];

				const setState = () => {
					if (running) {
						const date = Date.now();
						console.log('set state', !state, timeouts[i % timeouts.length]);
						return this.getExports().capabilities.onoff.set(
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
								this.SERVICE_CONTROL,
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
			this.setState(args.device, { effect: 'flash', effectColor: args.color.slice(1), effectSpeed: args.speed });
			this.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.pulse', (callback, args) => {
			this.setState(args.device, { effect: 'pulse', effectColor: args.color.slice(1), effectSpeed: args.speed });
			this.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.candle', (callback, args) => {
			this.setState(args.device, { effect: 'candle', effectColor: args.color.slice(1), effectSpeed: args.speed });
			this.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.rainbow', (callback, args) => {
			this.setState(args.device, { effect: 'rainbow', effectColor: '000000', effectSpeed: args.speed });
			this.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.rainbow_fade', (callback, args) => {
			this.setState(args.device, { effect: 'rainbow_fade', effectColor: '000000', effectSpeed: args.speed });
			this.setEffect(args.device, callback);
		});

		Homey.manager('flow').on('action.stop_effect', (callback, args) => {
			this.setState(args.device, { effect: false });
			this.setColor(args.device, callback);
		});

		callback();
	}

	getDevice(device, includePairing) {
		const id = this.getDeviceId(device);
		if (this.devices.has(id)) {
			return this.devices.get(id);
		} else if (includePairing && this.pairingDevice && this.pairingDevice.data && this.pairingDevice.data.id === id) {
			return this.pairingDevice.data;
		}
		return null;
	}

	getDeviceId(device) {
		if (device && device.constructor) {
			if (device.constructor.name === 'Object') {
				if (device.id) {
					return device.id;
				} else if (device.data && device.data.id) {
					return device.data.id;
				}
			} else if (device.constructor.name === 'String') {
				return device;
			}
		}
		return null;
	}

	getState(device) {
		const id = this.getDeviceId(device);
		device = this.getDevice(id);
		if (device && this.state.has(id)) {
			return this.state.get(id) || {};
		} else if (this.pairingDevice && this.pairingDevice.data.id === id) {
			return this.state.get('_pairingDevice') || {};
		}
		return Homey.manager('settings').get(`${this.SERIAL_NR}:${id}:state`) || {};
	}

	setState(device, state) {
		console.log('setState', device, state);
		const id = this.getDeviceId(device);
		device = this.getDevice(id);
		if (device) {
			this.state.set(id, Object.assign(this.state.get(id) || {}, state));
			Homey.manager('settings').set(`${this.SERIAL_NR}:${id}:state`, this.state.get(id));
		}
		if (this.pairingDevice && this.pairingDevice.data.id === id) {
			this.state.set('_pairingDevice', Object.assign(this.state.get('_pairingDevice') || {}, state));
		}
	}

	pair(socket) {
		socket.on('list_devices', (data, callback) => {
			console.log('LIST DEVICES');
			bleManager.discover([], 5000, (err, advertisements) => {
				console.log('DISCOVER', advertisements.length);

				advertisements = advertisements || [];
				advertisements = advertisements.filter(advertisement => !this.getDevice(advertisement.uuid));
				if (advertisements.length === 0) {
					return callback(null, []);
				}
				let failedCount = 0;
				advertisements.forEach(advertisement => {
					console.log('checking advertisement', advertisement.uuid, advertisement.serviceUuids);
					if (advertisement.serviceUuids.some(uuid => uuid === this.SERVICE_CONTROL)) {
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
								if (err || (serialNumber || '').toString().indexOf(this.SERIAL_NR) !== 0) {
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
									},
								};
								peripheral.read(this.SERVICE_CONTROL, CHAR_NAME, (err, name) => {
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
					} else if (++failedCount === advertisements.length) {
						console.log('called callback 0', failedCount, advertisements.length);
						callback(null, []);
					}
				});
			});
		});

		socket.on('add_device', (device) => {
			this.add(device.data);
		});

		socket.on('disconnect', () => {
			console.log('User aborted pairing, or pairing is finished');
		});
	}

	add(device) {
		device = device.data || device;
		const id = this.getDeviceId(device);
		this.devices.set(id, device);
		this.setState(
			device,
			Object.assign(
				{ onoff: 1, hue: 1, saturation: 1, dim: 1, temperature: 0.5, mode: 'color' },
				this.getState(device)
			)
		);
	}

	deleted(device) {
		this.devices.delete(device.id);
		this.state.delete(device.id);
	}

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
					this.SERVICE_CONTROL,
					CHAR_EFFECT,
					MipowDriver.state2buffer(this.getState(device), true),
					(err, result) => {
						console.log('write', (date - (date = Date.now())) * -1);
						callback(err, result);
						setTimeout(() => peripheral.disconnect(), 3000);
					}
				);
			});
		});
	}

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
					this.SERVICE_CONTROL,
					CHAR_COLOR,
					MipowDriver.state2buffer(this.getState(device)),
					(err, result) => {
						console.log('write', (date - (date = Date.now())) * -1);
						callback(err, result);
						setTimeout(() => peripheral.disconnect(), 3000);
					}
				);
			});
		});
	}

	static state2buffer(state, effect) {
		console.log('state2buffer', state, effect);
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
	}

	getExports() {
		return {
			pair: this.pair.bind(this),
			deleted: this.deleted.bind(this),
			added: this.add.bind(this),
			driver: this,
			capabilities: {
				onoff: {
					get: (device, callback) => callback(null, Boolean(this.getState(device).onoff)),
					set: (device, value, callback) => {
						console.log('onoff', value);
						this.setState(device, { onoff: value });
						this.setColor(device, err => callback(err, value));
					},
				},
				dim: {
					get: (device, callback) => callback(null, this.getState(device).dim),
					set: (device, value, callback) => {
						console.log('dim', value);
						this.setState(device, { onoff: true, dim: value });
						this.setColor(device, err => callback(err, value));
					},
				},
				light_hue: {
					get: (device, callback) => callback(null, this.getState(device).hue),
					set: (device, value, callback) => {
						console.log('hue', value);
						this.setState(device, { onoff: true, hue: value });
						this.setColor(device, err => callback(err, value));
					},
				},
				light_saturation: {
					get: (device, callback) => callback(null, this.getState(device).saturation),
					set: (device, value, callback) => {
						console.log('saturation', value);
						this.setState(device, { onoff: true, saturation: value });
						this.setColor(device, err => callback(err, value));
					},
				},
				light_temperature: {
					get: (device, callback) => callback(null, this.getState(device).temperature),
					set: (device, value, callback) => {
						console.log('temperature', value);
						this.setState(device, { onoff: true, temperature: value });
						this.setColor(device, err => callback(err, value));
					},
				},
				light_mode: {
					get: (device, callback) => callback(null, this.getState(device).mode),
					set: (device, value, callback) => {
						console.log('mode', value);
						this.setState(device, { mode: value });
						this.setColor(device, err => callback(err, value));
					},
				},
			},
		};
	}
};
