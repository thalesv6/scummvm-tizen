// SPDX-License-Identifier: GPL-3.0-or-later
/* Game manager: copies games from the PC (tools/pc-server.py) or a USB drive into the TV's IndexedDB
   and serves them to ScummVM as /data/tv/<game>/... The Yellow key opens it. Loaded after tv.js. */
(function () {
	var KEY_YELLOW = 405;
	var KEY_OK = 13;
	var KEY_BACK = 10009;
	var KEY_ESCAPE = 27;
	var KEY_UP = 38;
	var KEY_DOWN = 40;
	var KEY_LEFT = 37;
	var KEY_RIGHT = 39;
	var KEY_DIGIT_0 = 48;
	var KEY_NUMPAD_0 = 96;

	var PC_PORT = 8765;
	var TV_DATA_PREFIX = '/data/tv/';
	var DATA_ROOT_INDEX = '/data/index.json';
	var INDEX_FILE = 'index.json';
	var PC_ADDRESS_STORAGE_KEY = 'scummvm-pc-address';
	var DB_NAME = 'scummvm-tv-games';
	var FILES_STORE = 'files';
	var SIZES_STORE = 'sizes';
	var BYTES_PER_MB = 1024 * 1024;

	// ---- Storage: one record per file, keyed "<game>/<path inside the game>" ----

	var dbPromise = null;

	function openDb() {
		if (!dbPromise) {
			dbPromise = new Promise(function (resolve, reject) {
				var open = indexedDB.open(DB_NAME, 1);
				open.onupgradeneeded = function () {
					open.result.createObjectStore(FILES_STORE);
					open.result.createObjectStore(SIZES_STORE);
				};
				open.onsuccess = function () { resolve(open.result); };
				open.onerror = function () { reject(open.error); };
			});
		}
		return dbPromise;
	}

	// Runs work(stores) in one transaction; resolves with what work returns once the transaction commits.
	function transact(mode, work) {
		return openDb().then(function (db) {
			return new Promise(function (resolve, reject) {
				var tx = db.transaction([FILES_STORE, SIZES_STORE], mode);
				var result = work(tx.objectStore(FILES_STORE), tx.objectStore(SIZES_STORE));
				tx.oncomplete = function () { resolve(result && 'result' in result ? result.result : result); };
				tx.onerror = function () { reject(tx.error); };
				tx.onabort = function () { reject(tx.error); };
			});
		});
	}

	function putFile(path, buffer) {
		return transact('readwrite', function (files, sizes) {
			files.put(buffer, path);
			sizes.put(buffer.byteLength, path);
		});
	}

	function getFile(path) {
		return transact('readonly', function (files) { return files.get(path); });
	}

	function prefixRange(prefix) {
		return prefix ? IDBKeyRange.bound(prefix, prefix + '￿') : undefined;
	}

	// Resolves with [{path, size}] for every stored file whose path starts with prefix.
	function listFiles(prefix) {
		var keys, values;
		return transact('readonly', function (files, sizes) {
			sizes.getAllKeys(prefixRange(prefix)).onsuccess = function (e) { keys = e.target.result; };
			sizes.getAll(prefixRange(prefix)).onsuccess = function (e) { values = e.target.result; };
		}).then(function () {
			return keys.map(function (path, i) { return { path: path, size: values[i] }; });
		});
	}

	function deleteGame(game) {
		var range = prefixRange(game + '/');
		return transact('readwrite', function (files, sizes) {
			files.delete(range);
			sizes.delete(range);
		});
	}

	// {game: totalBytes} for the games stored on the TV.
	function storedGames() {
		return listFiles('').then(function (entries) {
			var games = {};
			entries.forEach(function (entry) {
				var game = entry.path.split('/')[0];
				games[game] = (games[game] || 0) + entry.size;
			});
			return games;
		});
	}

	// ---- ScummVM reads /data/tv through fetch, like the games bundled in the app ----

	function jsonResponse(value) {
		return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	// The index.json ScummVM's http-fs expects for a folder: files map to their size, folders to {}.
	function folderIndex(folder) {
		return listFiles(folder).then(function (entries) {
			var index = {};
			entries.forEach(function (entry) {
				var rest = entry.path.slice(folder.length);
				var slash = rest.indexOf('/');
				if (slash < 0) {
					index[rest] = entry.size;
				} else {
					index[rest.slice(0, slash)] = {};
				}
			});
			return jsonResponse(index);
		});
	}

	function storedFileResponse(path) {
		return getFile(path).then(function (buffer) {
			return buffer ? new Response(buffer, { status: 200 }) : new Response('', { status: 404 });
		});
	}

	var previousFetch = window.fetch;
	window.fetch = function (input, init) {
		var url = input instanceof Request ? input.url : String(input);
		if (url === DATA_ROOT_INDEX) {
			return previousFetch(input, init)
				.then(function (response) { return response.json(); })
				.then(function (index) {
					index.tv = {};
					return jsonResponse(index);
				});
		}
		if (url.indexOf(TV_DATA_PREFIX) === 0) {
			var path = url.slice(TV_DATA_PREFIX.length);
			var isIndex = path === INDEX_FILE || path.slice(-INDEX_FILE.length - 1) === '/' + INDEX_FILE;
			return isIndex ? folderIndex(path.slice(0, path.length - INDEX_FILE.length)) : storedFileResponse(path);
		}
		return previousFetch(input, init);
	};

	// ---- Sources: the PC script and USB drives ----

	function pcUrl(address, path) {
		return 'http://' + address + ':' + PC_PORT + path;
	}

	function fetchPcFileList(address) {
		return fetch(pcUrl(address, '/list.json')).then(function (response) {
			if (!response.ok) throw new Error('HTTP ' + response.status);
			return response.json();
		});
	}

	function pcGameNames(fileList) {
		var names = {};
		Object.keys(fileList).forEach(function (path) {
			if (path.indexOf('/') > 0) names[path.split('/')[0]] = true;
		});
		return Object.keys(names).sort();
	}

	async function copyGameFromPc(address, game, fileList, onProgress) {
		var paths = Object.keys(fileList).filter(function (path) { return path.indexOf(game + '/') === 0; });
		for (var i = 0; i < paths.length; i++) {
			onProgress(i + 1, paths.length, paths[i]);
			var response = await fetch(pcUrl(address, '/files/' + paths[i].split('/').map(encodeURIComponent).join('/')));
			if (!response.ok) throw new Error(paths[i] + ': HTTP ' + response.status);
			await putFile(paths[i], await response.arrayBuffer());
		}
	}

	function usbDrives() {
		return new Promise(function (resolve, reject) {
			tizen.filesystem.listStorages(function (storages) {
				resolve(storages.filter(function (s) { return s.type === 'EXTERNAL' && s.state === 'MOUNTED'; }));
			}, reject);
		});
	}

	function resolveUsbFolder(path) {
		return new Promise(function (resolve, reject) {
			tizen.filesystem.resolve(path, resolve, reject, 'r');
		});
	}

	function listUsbFolder(folder) {
		return new Promise(function (resolve, reject) {
			folder.listFiles(function (entries) {
				resolve(entries.filter(function (entry) { return entry.name.charAt(0) !== '.'; }));
			}, reject);
		});
	}

	// [{entry, path}] for every file below folder, path relative to it.
	async function collectUsbFiles(folder, prefix) {
		var found = [];
		var entries = await listUsbFolder(folder);
		for (var i = 0; i < entries.length; i++) {
			if (entries[i].isDirectory) {
				found = found.concat(await collectUsbFiles(entries[i], prefix + entries[i].name + '/'));
			} else {
				found.push({ entry: entries[i], path: prefix + entries[i].name });
			}
		}
		return found;
	}

	async function copyGameFromUsb(folder, game, onProgress) {
		var files = await collectUsbFiles(folder, '');
		for (var i = 0; i < files.length; i++) {
			onProgress(i + 1, files.length, files[i].path);
			var handle = tizen.filesystem.openFile(files[i].entry.fullPath, 'r');
			var bytes = handle.readData();
			handle.close();
			await putFile(game + '/' + files[i].path, bytes.slice().buffer);
		}
	}

	function requestUsbPermission() {
		return new Promise(function (resolve) {
			if (!window.tizen || !tizen.ppm) {
				resolve();
				return;
			}
			try {
				tizen.ppm.requestPermission('http://tizen.org/privilege/externalstorage', resolve, resolve);
			} catch (e) {
				resolve();
			}
		});
	}

	// First three parts of the TV's own address, to prefill the PC address (they are almost always on the same network).
	function tvNetworkPrefix() {
		return new Promise(function (resolve) {
			if (!window.tizen || !tizen.systeminfo) {
				resolve('192.168.0.');
				return;
			}
			function fromProperty(property, fallback) {
				try {
					tizen.systeminfo.getPropertyValue(property, function (network) {
						var parts = (network.ipAddress || '').split('.');
						if (parts.length === 4) resolve(parts.slice(0, 3).join('.') + '.'); else fallback();
					}, fallback);
				} catch (e) {
					fallback();
				}
			}
			fromProperty('ETHERNET_NETWORK', function () {
				fromProperty('WIFI_NETWORK', function () { resolve('192.168.0.'); });
			});
		});
	}

	function savedPcAddress() {
		try {
			return localStorage.getItem(PC_ADDRESS_STORAGE_KEY) || '';
		} catch (e) {
			return '';
		}
	}

	function savePcAddress(address) {
		try {
			localStorage.setItem(PC_ADDRESS_STORAGE_KEY, address);
		} catch (e) {
			console.error('could not save the PC address', e);
		}
	}

	// ---- Menu on top of ScummVM, driven by the remote (or a mouse) ----

	var overlay = null;
	var screen = null;
	var focusIndex = 0;
	var consumedKeys = {};

	function buildOverlay() {
		overlay = document.createElement('div');
		overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10;display:none;background:rgba(20,20,20,.94);' +
			'color:#eee;font:32px/1.35 sans-serif;padding:60px 120px;box-sizing:border-box;overflow:auto';
		document.body.appendChild(overlay);
	}

	function isOpen() {
		return overlay !== null && overlay.style.display !== 'none';
	}

	function closeMenu() {
		overlay.style.display = 'none';
		screen = null;
	}

	function escapeHtml(text) {
		return String(text).replace(/[&<>"]/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
		});
	}

	// screen = {title, message, html, items: [{label, run}], onBack, onKey(code) -> handled}
	function show(next) {
		if (!overlay) buildOverlay();
		screen = next;
		focusIndex = 0;
		overlay.style.display = 'block';
		render();
	}

	function render() {
		var html = '<div style="font-size:44px;color:#f90;margin-bottom:24px">' + escapeHtml(screen.title) + '</div>';
		if (screen.message) html += '<div style="margin-bottom:28px;white-space:pre-wrap">' + escapeHtml(screen.message) + '</div>';
		if (screen.html) html += screen.html;
		(screen.items || []).forEach(function (item, i) {
			var focused = i === focusIndex;
			html += '<div data-item="' + i + '" style="padding:12px 24px;margin:6px 0;border-radius:10px;cursor:pointer;' +
				(focused ? 'background:#c60;color:#fff' : 'background:#2c2c2c') + '">' + escapeHtml(item.label) + '</div>';
		});
		overlay.innerHTML = html;
		Array.prototype.forEach.call(overlay.querySelectorAll('[data-item]'), function (element) {
			element.onclick = function () { screen.items[Number(element.getAttribute('data-item'))].run(); };
		});
	}

	function moveFocus(delta) {
		var count = (screen.items || []).length;
		if (count === 0) return;
		focusIndex = (focusIndex + delta + count) % count;
		render();
	}

	function goBack() {
		if (screen.onBack) screen.onBack(); else mainMenu();
	}

	function handleMenuKey(code) {
		if (screen.onKey && screen.onKey(code)) return;
		if (code === KEY_UP) moveFocus(-1);
		else if (code === KEY_DOWN) moveFocus(1);
		else if (code === KEY_OK && screen.items && screen.items.length) screen.items[focusIndex].run();
		else if (code === KEY_BACK || code === KEY_ESCAPE) goBack();
		else if (code === KEY_YELLOW) closeMenu();
	}

	function restartScummVM() {
		location.reload();
	}

	function mainMenu() {
		var address = savedPcAddress();
		show({
			title: 'Manage games',
			message: 'Copied games stay on the TV.\nTo play: "Add Game..." → /data/tv → game folder.',
			items: [
				{ label: 'Copy from PC', run: pcGamesMenu },
				{ label: 'Copy from USB drive', run: usbDrivesMenu },
				{ label: 'Send from phone', run: phoneMenu },
				{ label: 'Games on TV', run: storedGamesMenu },
				{ label: 'PC address: ' + (address || 'not set'), run: function () { pcAddressMenu(mainMenu); } },
				{ label: 'Cursor speed: ' + window.currentCursorSpeed(), run: changeCursorSpeed },
				{ label: 'TV info', run: tvInfoMenu },
				{ label: 'Close', run: closeMenu }
			],
			onBack: closeMenu
		});
	}

	// tv.js opens the menu when Play/Pause is held: the small remote has no Yellow key of its own.
	window.openGameManager = mainMenu;

	// Redraws the menu with the new speed in the label, keeping the focus on this item.
	function changeCursorSpeed() {
		var focusedItem = focusIndex;
		window.nextCursorSpeed();
		mainMenu();
		focusIndex = focusedItem;
		render();
	}

	function messageScreen(title, message, onBack) {
		show({ title: title, message: message, items: [{ label: 'Back', run: onBack }], onBack: onBack });
	}

	function progressScreen(title) {
		return function (done, total, path) {
			show({ title: title, message: 'File ' + done + ' of ' + total + '\n' + path, items: [], onBack: function () {} });
		};
	}

	function copiedScreen(game) {
		show({
			title: 'Copied: ' + game,
			message: 'ScummVM will restart to see the game.\nThen: "Add Game..." → /data/tv → ' + game,
			items: [{ label: 'Restart ScummVM', run: restartScummVM }],
			onBack: restartScummVM
		});
	}

	// Copies with a progress screen; any failure (network, USB, TV storage full) ends on an error screen.
	function runCopy(game, copy) {
		copy(progressScreen('Copying ' + game)).then(function () {
			copiedScreen(game);
		}, function (error) {
			messageScreen('Could not copy ' + game, String(error && error.message || error), mainMenu);
		});
	}

	function withPcAddress(next) {
		if (savedPcAddress()) next(savedPcAddress()); else pcAddressMenu(function () { next(savedPcAddress()); });
	}

	function pcGamesMenu() {
		withPcAddress(function (address) {
			show({ title: 'Copy from PC', message: 'Looking for ' + address + '...', items: [], onBack: mainMenu });
			fetchPcFileList(address).then(function (fileList) {
				var games = pcGameNames(fileList);
				if (!games.length) {
					messageScreen('Copy from PC', 'The games folder on the PC is empty.', mainMenu);
					return;
				}
				show({
					title: 'Copy from PC',
					message: 'Choose a game:',
					items: games.map(function (game) {
						return {
							label: game,
							run: function () {
								runCopy(game, function (onProgress) { return copyGameFromPc(address, game, fileList, onProgress); });
							}
						};
					}).concat([{ label: 'Back', run: mainMenu }]),
					onBack: mainMenu
				});
			}, function () {
				messageScreen('Copy from PC', 'Could not reach the PC at ' + address + '.\nOn the PC, run: python tools/pc-server.py\n' +
					'and check the address it prints.', mainMenu);
			});
		});
	}

	function usbDrivesMenu() {
		if (!window.tizen || !tizen.filesystem) {
			messageScreen('Copy from USB drive', 'USB drives only work in the app installed on the TV.', mainMenu);
			return;
		}
		requestUsbPermission().then(usbDrives).then(function (drives) {
			if (!drives.length) {
				messageScreen('Copy from USB drive', 'No USB drive found.', mainMenu);
				return;
			}
			show({
				title: 'Copy from USB drive',
				message: 'Choose a USB drive:',
				items: drives.map(function (drive) {
					return { label: drive.label, run: function () { usbFolderMenu(drive.label, usbDrivesMenu); } };
				}).concat([{ label: 'Back', run: mainMenu }]),
				onBack: mainMenu
			});
		}, function (error) {
			messageScreen('Copy from USB drive', 'Could not read the USB drives: ' + (error && error.message || error), mainMenu);
		});
	}

	function usbFolderMenu(path, onBack) {
		resolveUsbFolder(path).then(function (folder) {
			return listUsbFolder(folder).then(function (entries) {
				var name = path.split('/').pop();
				var back = function () { usbFolderMenu(path, onBack); };
				var subfolders = entries.filter(function (entry) { return entry.isDirectory; });
				var fileCount = entries.length - subfolders.length;
				show({
					title: path,
					message: fileCount + ' file(s) in this folder.',
					items: [{
						label: 'Copy this folder as the game "' + name + '"',
						run: function () { runCopy(name, function (onProgress) { return copyGameFromUsb(folder, name, onProgress); }); }
					}].concat(subfolders.map(function (entry) {
						return { label: 'Folder: ' + entry.name, run: function () { usbFolderMenu(path + '/' + entry.name, back); } };
					})).concat([{ label: 'Back', run: onBack }]),
					onBack: onBack
				});
			});
		}).catch(function (error) {
			messageScreen('Copy from USB drive', 'Could not open ' + path + ': ' + (error && error.message || error), onBack);
		});
	}

	function phoneMenu() {
		withPcAddress(function (address) {
			var url = pcUrl(address, '/');
			var qr = qrcode(0, 'M');
			qr.addData(url);
			qr.make();
			show({
				title: 'Send from phone',
				message: 'Point the phone camera at the code (phone and PC on the same network).\n' +
					'Upload the game .zip, then come back and use "Copy from PC".\n' + url,
				html: '<div style="background:#fff;display:inline-block;padding:16px;margin-bottom:28px">' + qr.createImgTag(10, 0) + '</div>',
				items: [{ label: 'Back', run: mainMenu }],
				onBack: mainMenu
			});
		});
	}

	function storedGamesMenu() {
		storedGames().then(function (games) {
			var names = Object.keys(games).sort();
			show({
				title: 'Games on TV',
				message: names.length ? 'Press OK on a game to delete it.' : 'No games copied yet.',
				items: names.map(function (game) {
					return { label: game + '  (' + Math.ceil(games[game] / BYTES_PER_MB) + ' MB)', run: function () { confirmDelete(game); } };
				}).concat([{ label: 'Back', run: mainMenu }]),
				onBack: mainMenu
			});
		});
	}

	function confirmDelete(game) {
		show({
			title: 'Delete ' + game + '?',
			message: 'The files leave the TV. Also remove the game from the ScummVM list ("Remove Game").',
			items: [
				{ label: 'Delete', run: function () { deleteGame(game).then(restartScummVM); } },
				{ label: 'Back', run: storedGamesMenu }
			],
			onBack: storedGamesMenu
		});
	}

	// Four numbers typed with the remote's digit keys; Left/Right switch number, OK saves.
	function pcAddressMenu(next) {
		var saved = savedPcAddress();
		var start = saved ? Promise.resolve(saved) : tvNetworkPrefix();
		start.then(function (initial) {
			var parts = initial.split('.');
			while (parts.length < 4) parts.push('');
			var part = saved ? 3 : parts.indexOf('');
			var typedInPart = false;

			function draw() {
				var html = '<div style="font-size:64px;margin-bottom:28px">' + parts.map(function (value, i) {
					var style = i === part ? 'border-bottom:6px solid #f90;color:#fff' : 'color:#aaa';
					return '<span style="display:inline-block;min-width:150px;text-align:center;' + style + '">' + (value || '_') + '</span>';
				}).join('.') + '</div>';
				show({
					title: 'PC address',
					message: 'Type with the remote digits (123 button). ◀ ▶ switch field. OK saves.\n' +
						'pc-server.py prints the address when it starts.',
					html: html,
					items: [],
					onBack: mainMenu,
					onKey: onKey
				});
			}

			function onKey(code) {
				var digit = code >= KEY_DIGIT_0 && code <= KEY_DIGIT_0 + 9 ? code - KEY_DIGIT_0
					: code >= KEY_NUMPAD_0 && code <= KEY_NUMPAD_0 + 9 ? code - KEY_NUMPAD_0 : -1;
				if (digit >= 0) {
					var value = (typedInPart ? parts[part] : '') + digit;
					parts[part] = Number(value) > 255 ? String(digit) : value;
					typedInPart = true;
					if (parts[part].length === 3 && part < 3) {
						part++;
						typedInPart = false;
					}
				} else if (code === KEY_LEFT || code === KEY_RIGHT) {
					part = Math.max(0, Math.min(3, part + (code === KEY_LEFT ? -1 : 1)));
					typedInPart = false;
				} else if (code === KEY_OK) {
					if (parts.some(function (value) { return value === ''; })) return true;
					savePcAddress(parts.join('.'));
					next();
					return true;
				} else {
					return false;
				}
				draw();
				return true;
			}

			draw();
		});
	}

	// ---- TV info: what this TV offers, to tune the controls and to attach to bug reports ----

	var DOWNLOAD_TEST_URLS = [
		'https://downloads.scummvm.org/frs/extras/Lure%20of%20the%20Temptress/lure-1.1.zip',
		'https://raw.githubusercontent.com/scummvm/scummvm-icons/master/icons/lure-lure.png'
	];

	function tizenCapability(key) {
		try {
			return tizen.systeminfo.getCapability(key);
		} catch (e) {
			return '?';
		}
	}

	// Volume keys stay with the TV, so the volume keeps working while the screen is open.
	function extraRemoteKeys() {
		if (!window.tizen || !tizen.tvinputdevice) return [];
		return tizen.tvinputdevice.getSupportedKeys().filter(function (key) {
			return window.APP_REMOTE_KEYS.indexOf(key.name) < 0 && key.name.indexOf('Volume') !== 0;
		});
	}

	function setKeysRegistered(keys, registered) {
		keys.forEach(function (key) {
			try {
				if (registered) tizen.tvinputdevice.registerKey(key.name); else tizen.tvinputdevice.unregisterKey(key.name);
			} catch (e) {
				console.error('could not change key', key.name, e);
			}
		});
	}

	// HEAD through XHR: the app's fetch falls back to a full GET when fetch fails, which would download the whole zip.
	function testDownload(url) {
		return new Promise(function (resolve) {
			var xhr = new XMLHttpRequest();
			xhr.open('HEAD', url);
			xhr.onload = function () { resolve('HTTP ' + xhr.status); };
			xhr.onerror = function () { resolve('blocked or offline'); };
			xhr.send();
		});
	}

	function tvInfoMenu() {
		var supportedKeys = window.tizen && tizen.tvinputdevice ? tizen.tvinputdevice.getSupportedKeys() : [];
		var extraKeys = extraRemoteKeys();
		var lastKey = 'none yet';
		var downloads = DOWNLOAD_TEST_URLS.map(function () { return 'testing...'; });
		var chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
		setKeysRegistered(extraKeys, true);

		function leave() {
			setKeysRegistered(extraKeys, false);
			mainMenu();
		}

		function keyName(code) {
			var match = supportedKeys.filter(function (key) { return key.code === code; })[0];
			return match ? match.name : 'not in the TV list';
		}

		function draw() {
			var lines = [
				'Last key pressed: ' + lastKey,
				'Model: ' + (window.tizen ? tizenCapability('http://tizen.org/system/model_name') : 'not a TV'),
				'Tizen: ' + (window.tizen ? tizenCapability('http://tizen.org/feature/platform.version') : '-') + '   Chrome: ' + chrome,
				'Screen: ' + window.innerWidth + '×' + window.innerHeight + ' (device ' + window.screen.width + '×' + window.screen.height +
					', ratio ' + window.devicePixelRatio + ')'
			].concat(DOWNLOAD_TEST_URLS.map(function (url, i) {
				return 'Download ' + url.split('/')[2] + ': ' + downloads[i];
			}));
			var keyList = supportedKeys.map(function (key) { return key.name + ' ' + key.code; }).join(' · ');
			show({
				title: 'TV info',
				message: 'Press any remote button to see its code. Take a photo of this screen for bug reports.\n\n' + lines.join('\n'),
				html: '<div style="font-size:20px;color:#aaa;margin-bottom:24px">Keys this TV reports: ' +
					escapeHtml(keyList || 'none (not a TV)') + '</div>',
				items: [{ label: 'Back', run: leave }],
				onBack: leave,
				onKey: function (code) {
					// Yellow closes the whole menu without passing through leave().
					if (code === KEY_YELLOW) setKeysRegistered(extraKeys, false);
					lastKey = code + ' (' + keyName(code) + ')';
					draw();
					return false;
				}
			});
		}

		DOWNLOAD_TEST_URLS.forEach(function (url, i) {
			testDownload(url).then(function (result) {
				downloads[i] = result;
				if (screen && screen.title === 'TV info') draw();
			});
		});
		draw();
	}

	// ---- Keys: the menu listens on window, before tv.js (document), so it can keep keys from ScummVM ----

	function stop(event) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	window.addEventListener('keydown', function (event) {
		if (!event.isTrusted) return;
		if (!isOpen()) {
			if (event.keyCode !== KEY_YELLOW) return;
			mainMenu();
		} else if (!event.repeat || event.keyCode === KEY_UP || event.keyCode === KEY_DOWN) {
			handleMenuKey(event.keyCode);
		}
		consumedKeys[event.keyCode] = true;
		stop(event);
	}, true);

	// The keyup of a key the menu used must not reach tv.js: an OK that closed the menu would click the game.
	window.addEventListener('keyup', function (event) {
		if (!event.isTrusted || !consumedKeys[event.keyCode]) return;
		delete consumedKeys[event.keyCode];
		stop(event);
	}, true);
})();
