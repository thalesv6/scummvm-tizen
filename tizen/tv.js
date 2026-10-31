// SPDX-License-Identifier: GPL-3.0-or-later
/* Tizen TV glue for the ScummVM WebAssembly build. Loaded before scummvm.js. */

// http-fs.cpp reads game files with response.bytes(), which only exists since Chrome 132.
if (!Response.prototype.bytes) {
	Response.prototype.bytes = function () {
		return this.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
	};
}

// Inside a .wgt the page is file:///opt/usr/apps/<pkg>/res/wgt/index.html.
// ScummVM asks for root-absolute URLs (/data/...), and Chromium may refuse fetch() on file://,
// so root paths are rebased onto the app folder and failed fetches are retried with XHR.
if (location.protocol === 'file:') {
	(function () {
		// Resolved by URL so a '/' inside the #hash (ScummVM command-line arguments) is not taken as a folder.
		var APP_BASE = new URL('./', location.href).href;
		var nativeFetch = window.fetch.bind(window);

		function xhrFetch(url) {
			return new Promise(function (resolve, reject) {
				var xhr = new XMLHttpRequest();
				xhr.open('GET', url);
				xhr.responseType = 'arraybuffer';
				// file:// XHR reports status 0 on success, and Response refuses status 0.
				xhr.onload = function () { resolve(new Response(xhr.response, { status: xhr.status || 200 })); };
				xhr.onerror = function () { reject(new TypeError('Failed to load ' + url)); };
				xhr.send();
			});
		}

		window.fetch = function (input, init) {
			var url = input instanceof Request ? input.url : String(input);
			if (url.charAt(0) === '/' && url.charAt(1) !== '/') {
				url = APP_BASE + url.slice(1);
			}
			return nativeFetch(url, init).catch(function () { return xhrFetch(url); });
		};
	})();
}

// Remote control → mouse and ScummVM keys. Arrows move ScummVM's cursor; OK clicks (held: right click);
// Back is AC_BACK (held: ScummVM menu). A USB keyboard switches arrows and OK back to plain keys.
(function () {
	// Cursor tuning, in screen pixels; adjust on the real TV.
	// A tap moves one step; holding waits HOLD_DELAY, then glides and accelerates like key repeat.
	var CURSOR_TAP_STEP = 4;
	var CURSOR_HOLD_DELAY_MS = 200;
	var CURSOR_SPEED_START = 2;
	var CURSOR_SPEED_MAX = 22;
	var CURSOR_ACCEL_MS = 1200;

	// How long OK / Back must be held to count as a hold instead of a tap.
	var OK_HOLD_MS = 500;
	var BACK_HOLD_MS = 800;
	var MODIFIER_RELEASE_DELAY_MS = 100;

	var KEY_OK = 13;
	var KEY_BACK = 10009;
	var KEY_GREEN = 404;
	var ARROW_DIRECTIONS = { 37: [-1, 0], 38: [0, -1], 39: [1, 0], 40: [0, 1] };
	var SCUMMVM_MENU = { key: 'F5', code: 'F5', ctrl: true };
	// SDL turns the BrowserBack code into AC_BACK, which the keymap patch binds to skip / close.
	var AC_BACK = { key: 'BrowserBack', code: 'BrowserBack' };
	var FORWARDED_KEYS = {
		403: SCUMMVM_MENU,                                // Red: ScummVM global menu (save/load/quit)
		// Yellow (405) opens the game manager in games.js.
		406: { key: 'F7', code: 'F7', ctrl: true },       // Blue: virtual keyboard
		10252: { key: ' ', code: 'Space' },               // Play/Pause: pause game
		427: { key: '.', code: 'Period' },                // CH+: skip dialogue line
		428: { key: 'F7', code: 'F7', ctrl: true }        // CH-: virtual keyboard
	};
	var KEYBOARD_LETTER_FIRST = 65;
	var KEYBOARD_LETTER_LAST = 90;

	var cursorX = window.innerWidth / 2;
	var cursorY = window.innerHeight / 2;
	var pressedButtons = 0;
	var heldArrows = {};
	var movingSince = 0;
	var animating = false;
	// A keyboard sends the same codes as the remote for arrows and Enter; typing a letter means one is in use.
	var keyboardMode = false;
	var holdTimers = {};
	var heldLong = {};

	function canvas() {
		return document.getElementById('canvas');
	}

	function sendMouse(type, button) {
		canvas().dispatchEvent(new MouseEvent(type, {
			bubbles: true, cancelable: true, view: window,
			clientX: cursorX, clientY: cursorY, screenX: cursorX, screenY: cursorY,
			button: button || 0, buttons: pressedButtons
		}));
	}

	function sendKey(type, key, code) {
		window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: key, code: code }));
	}

	// SDL tracks modifiers from Control key presses, not from event.ctrlKey, so Ctrl is pressed for real.
	// ScummVM reads the modifier state when it processes the key (SDL_GetModState), not when the key arrived,
	// so Ctrl stays down until ScummVM has polled at least one frame.
	function tapForwardedKey(mapping) {
		if (mapping.ctrl) sendKey('keydown', 'Control', 'ControlLeft');
		sendKey('keydown', mapping.key, mapping.code);
		sendKey('keyup', mapping.key, mapping.code);
		if (mapping.ctrl) {
			setTimeout(function () { sendKey('keyup', 'Control', 'ControlLeft'); }, MODIFIER_RELEASE_DELAY_MS);
		}
	}

	function stepCursor(dx, dy, distance) {
		cursorX = Math.max(0, Math.min(window.innerWidth - 1, cursorX + dx * distance));
		cursorY = Math.max(0, Math.min(window.innerHeight - 1, cursorY + dy * distance));
		sendMouse('mousemove');
	}

	function moveCursor(now) {
		var dx = 0, dy = 0;
		for (var keyCode in heldArrows) {
			dx += ARROW_DIRECTIONS[keyCode][0];
			dy += ARROW_DIRECTIONS[keyCode][1];
		}
		if (dx === 0 && dy === 0) {
			animating = false;
			return;
		}
		var heldFor = now - movingSince - CURSOR_HOLD_DELAY_MS;
		if (heldFor > 0) {
			var ramp = Math.min(1, heldFor / CURSOR_ACCEL_MS);
			stepCursor(dx, dy, CURSOR_SPEED_START + (CURSOR_SPEED_MAX - CURSOR_SPEED_START) * ramp);
		}
		requestAnimationFrame(moveCursor);
	}

	function pressButton(button) {
		pressedButtons |= button === 2 ? 2 : 1;
		sendMouse('mousedown', button);
	}

	function releaseButton(button) {
		pressedButtons &= button === 2 ? ~2 : ~1;
		sendMouse('mouseup', button);
	}

	// Calls onHold if the key is still down after ms; the keyup handler then knows it was not a tap.
	function startHold(code, ms, onHold) {
		heldLong[code] = false;
		holdTimers[code] = setTimeout(function () {
			holdTimers[code] = null;
			heldLong[code] = true;
			onHold();
		}, ms);
	}

	// Returns true when the key was released before its hold fired.
	function endHoldWasTap(code) {
		clearTimeout(holdTimers[code]);
		holdTimers[code] = null;
		return !heldLong[code];
	}

	function isRemoteOnlyKey(code) {
		return code === KEY_BACK || code === KEY_GREEN || FORWARDED_KEYS[code] !== undefined;
	}

	function isKeyboardLetter(code) {
		return code >= KEYBOARD_LETTER_FIRST && code <= KEYBOARD_LETTER_LAST;
	}

	function onKeyDown(event) {
		if (!event.isTrusted) return;
		var code = event.keyCode;
		if (isKeyboardLetter(code)) {
			keyboardMode = true;
		} else if (isRemoteOnlyKey(code)) {
			keyboardMode = false;
		}
		if (keyboardMode) return;

		if (ARROW_DIRECTIONS[code]) {
			if (!heldArrows[code]) {
				heldArrows[code] = true;
				stepCursor(ARROW_DIRECTIONS[code][0], ARROW_DIRECTIONS[code][1], CURSOR_TAP_STEP);
				if (!animating) {
					animating = true;
					movingSince = performance.now();
					requestAnimationFrame(moveCursor);
				}
			}
		} else if (code === KEY_OK) {
			if (!holdTimers[code]) startHold(code, OK_HOLD_MS, function () { pressButton(2); });
		} else if (code === KEY_BACK) {
			if (!holdTimers[code]) startHold(code, BACK_HOLD_MS, function () { tapForwardedKey(SCUMMVM_MENU); });
		} else if (code === KEY_GREEN) {
			if (!event.repeat) pressButton(2);
		} else if (FORWARDED_KEYS[code]) {
			if (!event.repeat) tapForwardedKey(FORWARDED_KEYS[code]);
		} else {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	function onKeyUp(event) {
		if (!event.isTrusted) return;
		var code = event.keyCode;
		if (keyboardMode) return;

		if (ARROW_DIRECTIONS[code]) {
			delete heldArrows[code];
		} else if (code === KEY_OK) {
			if (endHoldWasTap(code)) {
				pressButton(0);
				releaseButton(0);
			} else {
				releaseButton(2);
			}
		} else if (code === KEY_BACK) {
			if (endHoldWasTap(code)) tapForwardedKey(AC_BACK);
		} else if (code === KEY_GREEN) {
			releaseButton(2);
		} else if (!FORWARDED_KEYS[code]) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	// A real mouse reaches SDL by itself; follow it so the arrows continue from where it left the cursor.
	window.addEventListener('mousemove', function (event) {
		if (!event.isTrusted) return;
		cursorX = event.clientX;
		cursorY = event.clientY;
	}, true);

	// On document, not window: the game manager (games.js) listens on window and sees keys first.
	document.addEventListener('keydown', onKeyDown, true);
	document.addEventListener('keyup', onKeyUp, true);

	if (window.tizen) {
		try {
			tizen.tvinputdevice.registerKeyBatch(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
				'MediaPlayPause', 'ChannelUp', 'ChannelDown', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
		} catch (e) {
			console.error('registerKeyBatch failed', e);
		}
		// "Quit" in ScummVM ends the wasm program; close the TV app with it.
		Module.onExit = function () { tizen.application.getCurrentApplication().exit(); };
	}
})();
