/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const global = this;

/**
 * Specialized unloader that will trigger whenever either the window gets
 * unloaded or the add-on is shut down
 */
exports.unloadWindow = function unloadWindow(window, fn) {
	let args = arguments;
	let handler = unload(function() {
		window.removeEventListener('unload', handler, false);
		try {
			fn.apply(null, args);
		}
		catch (ex) {
			log(LOG_ERROR, "failed to run window unloader", ex);
		}
	});
	window.addEventListener('unload', handler, false);
};

/**
 * Apply a callback to each open and new browser windows.
 */
exports.watchWindows = function watchWindows(location, callback) {
	// Wrap the callback in a function that ignores failures
	function watcher(window) {
		log(LOG_DEBUG, "watchwindows watcher");
		try {
			callback(window, window.document);
		}
		catch(ex) {
			log(LOG_ERROR, "window watcher failed", ex);
		}
	}

	// Wait for the window to finish loading before running the callback
	function runOnLoad(window) {
		// Listen for one load event before checking the window type
		window.addEventListener("load", function runOnLoad_load() {
			window.removeEventListener("load", runOnLoad_load, false);

			// Now that the window has loaded, only handle requested windows
			if (window.location == location) {
				watcher(window);
			}
			else {
				log(LOG_DEBUG, "was but skipping: " + window.location);
			}
		}, false);
	}

	// Add functionality to existing windows
	let windows = Services.wm.getEnumerator(null);
	while (windows.hasMoreElements()) {
		// Only run the watcher immediately if the browser is completely loaded
		let window = windows.getNext();
		if (window.document.readyState == "complete" && window.location == location) {
			watcher(window);
		}
		// Wait for the window to load before continuing
		else {
			runOnLoad(window);
		}
	}

	// Watch for new browser windows opening then wait for it to load
	function windowWatcher(subject, topic) {
		runOnLoad(subject);
	}
	Services.obs.addObserver(windowWatcher, "chrome-document-global-created", false);

	// Make sure to stop watching for windows if we're unloading
	unload(function() Services.obs.removeObserver(windowWatcher, "chrome-document-global-created"));
};
const overlayCache = new Map();
/**
 * Register a new overlay (XUL)
 */
exports.registerOverlay = function registerOverlay(src, location, callback) {
	function inject(xul, window, document) {
		function $(id) document.getElementById(id);
		function $$(q) document.querySelector(q);

		// loadOverlay for the poor
		function addNode(target, node) {
			// helper: insert according to position
			function insertX(nn, attr, callback) {
				if (!nn.hasAttribute(attr)) {
					return false;
				}
				let places = nn.getAttribute(attr)
					.split(',')
					.map(function(p) p.trim())
					.filter(function(p) !!p);
				for each (let p in places) {
					let pn = $$('#' + target.id + ' > #' + p);
					if (!pn) {
						continue;
					}
					callback(pn);
					return true;
				}
				return false;
			}

			// bring the node to be inserted into the document
			let nn = document.importNode(node, true);

			// try to insert according to insertafter/before
			if (insertX(nn, 'insertafter', function(pn) pn.parentNode.insertBefore(nn, pn.nextSibling))
				|| insertX(nn, 'insertbefore', function(pn) pn.parentNode.insertBefore(nn, pn))) {
			}
			// just append
			else {
				target.appendChild(nn);
			}
			return nn;
		}

		try {
			// store unloaders for all elements inserted
			let unloaders = [];

			// apply styles
			for (let [,data] in Iterator(xul.styles)) {
				let ss = document.createProcessingInstruction("xml-stylesheet", data);
				document.insertBefore(ss, document.documentElement);
				unloaders.push(function() ss.parentNode.removeChild(ss));
			}

			// Add all overlays
			var tb = $("nav-bar");
			tb = tb && tb.toolbox;
			for (let [,node] in Iterator(xul.nodes)) {
				let id = node.getAttribute("id");
				let target = null;
				if (id == "BrowserToolbarPalette" && tb) {
					target = tb.palette;
				}
				if (!target) {
					target = $(id);
				}
				if (!target && tb) {
					target = tb.palette.querySelector("#" + id);
				}
				if (!target) {
					log(LOG_DEBUG, "no target for " + id + ", not inserting");
					continue;
				}

				// set attrs
				for (let [,a] in Iterator(node.attributes)) {
					let k = a.name;
					if (k == "id" || k == "insertbefore" || k == "insertafter") {
						continue;
					}
					target.setAttribute(k, a.value);
				}

				// insert all children
				for (let n = node.firstChild; n; n = n.nextSibling) {
					if (n.nodeType != n.ELEMENT_NODE) {
						continue;
					}
					let nn = addNode(target, n);
					unloaders.push(function() nn.parentNode.removeChild(nn));
				}
			}

			// install per-window unloader
			if (unloaders.length) {
				exports.unloadWindow(window, function() unloaders.forEach(function(u) u()));
			}

			callback && callback(window, document);
		}
		catch (ex) {
			log(LOG_ERROR, "failed to inject xul", ex);
		}
	}

	if (overlayCache.has(src)) {
		exports.watchWindows(location, inject(null, overlayCache.get(src)));
		return;
	}

	let _r = new Instances.XHR();
	_r.onload = function() {
		log(LOG_DEBUG, "loaded: " + src);
		let document = _r.responseXML;

		// clean the document a bit
		let emptyNodes = document.evaluate("//text()[normalize-space(.) = '']", document, null, 7, null);
		for (let i = 0, e = emptyNodes.snapshotLength; i < e; ++i) {
			let n = emptyNodes.snapshotItem(i);
			n.parentNode.removeChild(n);
		}

		// prepare all elements to be inserted
		let xul = {styles: [], nodes: []};
		for (let n = document.firstChild; n; n = n.nextSibling) {
			if (n.nodeType != 7 || n.target != "xml-stylesheet") {
				continue;
			}
			xul.styles.push(n.data);
		}
		for (let n = document.documentElement.firstChild; n; n = n.nextSibling) {
			if (n.nodeType != n.ELEMENT_NODE || !n.hasAttribute("id")) {
				continue;
			}
			xul.nodes.push(n);
		}
		if (!xul.styles.length && xul.nodes.length) {
			log(LOG_INFO, "There is only XUL ... but there wasn't");
			return;
		}
		overlayCache.set(src, xul);
		exports.watchWindows(location, inject.bind(null, xul));
	};
	_r.onerror = _r.onabort = function() {
		log(LOG_ERROR, "Failed to load " + src);
	}
	_r.overrideMimeType("application/xml");
	_r.open("GET", src);
	_r.send();
};

/* vim: set et ts=2 sw=2 : */
