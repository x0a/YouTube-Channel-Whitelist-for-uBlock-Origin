'use strict';

(function(window, document, browser, undefined){
	const VIDEO = 1;
	const CHANNEL = 2;
	const SEARCH = 3;
	const HOME = 4;
	const AD = 5;
	const ALLELSE = -1;
	const LPOLY = 2; //new polymer layout
	const LBASIC = 1; //old basic layout, less and less supported as time goes on

	let settings = {whitelisted: [], blacklisted: []};

	browser.runtime.sendMessage({action: "get"}, response => {
		settings = response;
		//allows us to access local javascript variables, needed to pre-append &disable flag to video lists
		let head = document.documentElement;
		let relatedScript = document.createElement("script");
		relatedScript.setAttribute("type", "text/javascript");
		relatedScript.setAttribute("src", browser.runtime.getURL("inject.js")); 
		head.appendChild(relatedScript);
		//adding styles for UBO button
		let styleSheet = document.createElement("link");
		styleSheet.setAttribute("rel", "stylesheet");
		styleSheet.setAttribute("type", "text/css");
		styleSheet.setAttribute("href", browser.runtime.getURL("inject.css"));
		head.appendChild(styleSheet);

		document.addEventListener("DOMContentLoaded", () => {
			let mode = getMode();
			let layout = document.querySelector("ytd-app") ? LPOLY : LBASIC; //dirty, but just for the initial load
			let prevurl = location.href;

			updatePage(mode, layout);
			//make username and UCID available on the DOM, for the first time
			if(layout === LPOLY && mode === CHANNEL)
				callAgent("updateChannel");
			//in case of settings change due to activity in another tab
			browser.runtime.onMessage.addListener((requestData, sender, sendResponse) =>  {
		    	if(requestData.action === "update"){
					//user made a change to the settings elsewhere
					settings = requestData.settings;
					updatePage(mode, layout, true);
				}
			});

			(new MutationObserver(mutations =>  {
				if(location.href !== prevurl){
					mode = getMode();
					prevurl = location.href;
				}

				for(let mutation of mutations){
					if(mode === VIDEO){
						if(mutation.target.id === "movie_player"
							|| (
								mutation.target.id === "player-container"
								&& mutation.addedNodes.length
								&& mutation.addedNodes[0].id === "movie_player")
							|| mutation.target.className === "ytp-title-channel-name"
						){
							//video player update, or first added
							let player = mutation.target.id === "movie_player" ? mutation.target : document.querySelector("#movie_player");
							if(player.classList.contains("ad-showing")){
								updateAdShowing(player);
							}
						}else{
							if(
								mutation.type === "attributes"
								&& mutation.attributeName === "href"
								&& mutation.target.classList[0] === "yt-simple-endpoint"
								&& mutation.target.parentNode.id === "owner-name"
							){
								//new layout, username property changed
								updateVideoPage(LPOLY);
							}else if(
								mutation.type === "attributes"
								&& mutation.target.id === "continuations"
								&& mutation.attributeName === "hidden"
							){
								//new layout, related has finished loading
								updateVideoPage(LPOLY);
							}else{
								for(let node of mutation.addedNodes){
									if(
										node.id === "watch7-main-container"
										|| node.localName === "ytd-video-secondary-info-renderer"
									){
										//username created, old layout, and newlayout on first load
										updateVideoPage(LBASIC, node);
									}
								}
							}

						}
					}else if(mode === CHANNEL || mode === ALLELSE){
						//these are all about detecting that loading has finished.
						let finishedLoading = 0;

						if(
							(
								mutation.type === "attributes"
								&& mutation.target.localName === "yt-page-navigation-progress"
								&& mutation.attributeName === "hidden"
								&& mutation.oldValue === null
							) || (
								mutation.type === "childList"
								&& mutation.target.id === "items"
							)
						){
							//done loading
							finishedLoading = LPOLY;
						}else if(mutation.target.id === "subscriber-count"){
							//update the UCID in the dom
							callAgent("updateChannel");//, {}, (channelId){console.log("new id", channelId);}) => 
						}

						//oldlayout
						for(let node of mutation.removedNodes){
							if(node.id === "progress"){
								finishedLoading = LBASIC;
								break;
							}
						}

						if(finishedLoading){
							if(mode === CHANNEL)
								updateChannelPage(finishedLoading);
							else if(mode === ALLELSE)
								updateVideolists(finishedLoading);
							break;
						}
					}

				}
			})).observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["hidden", "href"],
				attributeOldValue: true
			});
		})
	})

	function getMode(){
		if(location.href.indexOf("youtube.com/watch?") !== -1){
			return VIDEO;
		}else if(location.href.indexOf("youtube.com/channel/") !== -1 || location.href.indexOf("youtube.com/user/") !== -1){
			return CHANNEL;
		}else{
			return ALLELSE;
		}
	}

	function getChannelId(element, mode, collect){
		let links, link, channelId = {id: "", username: "", display: ""};
		
		if(!mode) 
			mode = getMode();
		if(!element) 
			element = document;

		if(mode === VIDEO){
			links = element.querySelectorAll("ytd-video-owner-renderer a, [id='watch7-user-header'] a");
		}else if(mode === CHANNEL){
			links = [location];
			link = document.querySelector("link[rel='canonical']");

			if(link){
				links.push(link);
				channelId.username = link.getAttribute("username") || "";
			} 
			channelId.display = document.querySelector("#channel-header #channel-title,.branded-page-header-title-link").textContent;
		}else if(mode === AD){
			links = [element];
		}else return false;

		for(let link of links){
			let matches;

			if(!link.href) continue;

			if(matches = link.href.match(/\/(user|channel)\/([\w-]+)(?:\/|$|\?)/)){
				if(matches[1] === "user")
					channelId.username = matches[2]
				else if(matches[1] === "channel"){
					channelId.id = matches[2];
					if(link.textContent) 
						channelId.display = link.textContent;
				}
			}
		}

		if(collect){
			collect.mode = mode;
			collect.links = links;
		}

		if(channelId.id || channelId.username)
			return channelId;
		else
			return false;
	}

	function updateURL(verify, channelId){
		channelId = channelId || getChannelId();
		if(!channelId) return;

		if(location.href.indexOf("&disableadblock=1") !== -1){
			//ads are enabled, should we correct that?
			if(inwhitelist(channelId) === -1){
				window.history.replaceState(history.state, "", reflectURLFlag(location.href, false));
				return false;
			}else return true;
		}else{
			//ads are not enabled, lets see if they should be
			if(inwhitelist(channelId) !== -1){
				window.history.replaceState(history.state, "", reflectURLFlag(location.href, true));

				if(verify) verifyDisabled();
				return true;
			}else return false;
		}
	}

	function reflectURLFlag(url, shouldContain){
		//take url, return url with flags removed if add is off
		//return url with flags added if add is on
		let search = /((?!\?)igno=re&disableadblock=1&?)|(&disableadblock=1)/g

		if(shouldContain){
			url = reflectURLFlag(url, false); //remove first, then add
			let paramsStart = url.indexOf("?");
			return url + (paramsStart === -1 ? "?igno=re" : (paramsStart === url.length - 1 ? "igno=re" : "")) + "&disableadblock=1"

		}else{
			return url.replace(search, "");
		}
	}

	function updatePage(mode, layout, forceUpdate){
		if(mode === VIDEO) updateVideoPage(layout, undefined, forceUpdate);
		else if(mode === CHANNEL) updateChannelPage(layout, forceUpdate);
		else if(mode === ALLELSE) updateVideolists(layout, undefined, forceUpdate);
	}

	function whitelistButton(layout, toggled, ref){
		if(ref){
			//button already exists, update whitelist toggle on pre-existing button rather than create new one
			if(!toggled){
				if(ref.classList.contains("yt-uix-button-toggled"))
					ref.classList.remove("yt-uix-button-toggled");
			}else{
				if(!ref.classList.contains("yt-uix-button-toggled"))
					ref.classList.add("yt-uix-button-toggled");
			}

			return;
		}

		let button = document.createElement("button");
		button.className = "UBO-button";
		button.addEventListener("click", event => {
			let data = {}
			let channelId = getChannelId(null, null, data), button = event.target; //allow parent scope to be discarded
			if(inwhitelist(channelId) !== -1){
				let index;

				while((index = inwhitelist(channelId)) !== -1){
					settings.whitelisted.splice(index, 1);
				}
				button.classList.remove("yt-uix-button-toggled");
			}else{
				settings.whitelisted.push(channelId);
				button.classList.add("yt-uix-button-toggled");
			}

			browser.runtime.sendMessage({action: "update", settings: settings}, response => {
				if(response) console.log(response)
			})
			updateURL(true, channelId);
			updatePage(data.mode, layout, true);

		}, false);

		if(layout === LPOLY){
			let buttonContainer;
			button.className += " UBO-poly " + (toggled ? " yt-uix-button-toggled" : "");
			button.innerHTML = "ADS";
			buttonContainer = document.createElement("div");
			buttonContainer.appendChild(button);

			return buttonContainer;
		}else if(layout === LBASIC){
			button.className += " UBO-old yt-uix-button yt-uix-button-size-default yt-uix-button-subscribed-branded hover-enabled" + (toggled ? " yt-uix-button-toggled" : "");
			button.innerHTML = "Ads";

			return button;
		}
	}
	function updateVideoPage(layout, element, forceUpdate){
		let container;

		if(layout === LPOLY){
			container = document.querySelector("ytd-video-owner-renderer")
		}else if(layout === LBASIC){
			container = document.querySelector("#watch7-subscription-container")
		}

		if(!container) return;
		if(!element) element = container;

		let data = {}
		let channelId = getChannelId(element, VIDEO, data);
		let whitelisted = updateURL(false, channelId);
		let button;

		if(button = whitelistButton(layout, whitelisted, container.parentNode.querySelector(".UBO-button"))){
			//add the new button, otherwise the status was updated on a pre-existing button
			if(container.nextSibling){
				container.parentNode.insertBefore(button, container.nextSibling);
			}else{
				container.parentNode.appendChild(button);
			}
		}

		for(let link of data.links){
			//this link hasn't been looked at
			//or the channel changed
			//or the whitelist state changed
			if(!link.channelId || link.channelId !== channelId.id || link.whitelisted !== whitelisted){
				link.href = reflectURLFlag(link.href, whitelisted);
				link.whitelisted = whitelisted;
				link.channelId = channelId.id;
			}
		}

		updateRelated(layout, forceUpdate);
	}

	function updateRelated(layout, forceUpdate){
		if(layout === LPOLY){
			//update via local JS variables on the page
			callAgent("updateVideoLists", {settings: settings, type: "related", forceUpdate: forceUpdate})
		}else if(layout === LBASIC){
			//update via information available on the DOM
			let videos = document.querySelectorAll(".video-list-item");

			for(let vid of videos){
				if(!forceUpdate && vid.processed) continue;

				let user = vid.querySelector("[data-ytid]");
				if(!user)
					continue;
				else
					user = user.getAttribute("data-ytid");
				let inwhite = inwhitelist({id: user}) !== -1
				let links = vid.querySelectorAll("a[href^='/watch?']");
				if(inwhite || forceUpdate)
					for(let link of links){
						link.href = reflectURLFlag(link.href, inwhite)
					}

				vid.processed = true;
			}
		}
	}

	function updateChannelPage(layout, forceUpdate){

		let channelId = getChannelId(null, CHANNEL);
		let whitelisted = updateURL(false, channelId);
		let container, button;

		if(layout === LPOLY) 
			container = document.querySelector("#edit-buttons");
		else if(layout === LBASIC) 
			container = document.querySelector(".primary-header-actions");

		if(!container) return;

		if(button = whitelistButton(layout, whitelisted, container.querySelector(".UBO-button")))
			container.appendChild(button); //add only if it doesn't already exist

		if(whitelisted || forceUpdate){
			updateVideolists(layout, channelId, forceUpdate);
		}
	}

	function updateVideolists(layout, channelId, forceUpdate){
		//videos from places like the home page, channel page, search results, etc.
		//basically anything that isn't the /watch?v= page
		if(layout === LPOLY){
			callAgent("updateVideoLists", {settings: settings, channelId: channelId, type: "general", forceUpdate: forceUpdate});
		}else if(layout === LBASIC){
			let videos = document.querySelectorAll(".yt-lockup-video");

			for(let vid of videos){
				if(!forceUpdate && vid.processed) continue;

				let user = vid.querySelector(".g-hovercard.yt-uix-sessionlink");
				let values = {id: ""};

				if(!user || !(values.id = user.getAttribute("data-ytid")))
					if(channelId)
						values = channelId;
					else
						continue;
				let inwhite = inwhitelist(values) !== -1
				if(inwhite || forceUpdate){ //exists
					let links = vid.querySelectorAll("a[href^='/watch?']");

					for(let link of links){
						link.href = reflectURLFlag(link.href, inwhite)
					}
				}
				vid.processed = true;
			}
		}
	}

	function updateAdShowing(player){
		let container, blacklistButton;

		if(!player.querySelector("#BLK-button")){
			container = player.querySelector(".ytp-right-controls");

			if(!container){
				console.error("Cannot find .ytp-right-controls");
				return;
			}

			blacklistButton = parseHTML('<button class="ytp-button" id="BLK-button"><span class="BLK-tooltip">Blacklist this advertiser</span><div class="BLK-container"><img src="' + browser.runtime.getURL("img/icon_16.png") + '"></div></button>').querySelector("#BLK-button");
			blacklistButton.addEventListener("click", () => {
				browser.runtime.sendMessage({action: "blacklist"}, response => {
					if(response && response.error) 
						console.error(response.error, response);
					else
						location.reload();
				})
			})
			container.insertBefore(blacklistButton, container.firstChild);
		}
	}

	function callAgent(externalFunction, data, callback){
		let msgFunc;
		let callbackId = "";

		if(callback){
			if(typeof callback !== "function"){
				console.error("Callback supplied is not a function");
				return false;
			}
			callbackId = Math.random().toString(36).substring(7); //random 7 char string
			window.addEventListener("message", msgFunc = event => {
				if(event.data.origin || !event.data.callbackId || event.data.callbackId !== callbackId) return;
				callback(event.data.callbackMessage);
				window.removeEventListener("message", msgFunc);
			});
		}
		//external for us, means internal for them
		window.postMessage({internalFunction: externalFunction, message: data, callbackId: callbackId, origin: true}, "*");
	}

	function verifyDisabled(){
		setTimeout(() => {
			let iframe = document.createElement("iframe");
			iframe.height = "1px";
			iframe.width = "1px";
			iframe.id = "ads-text-iframe";
			iframe.src = "https://youtube.com/pagead/";

			document.body.appendChild(iframe);
			setTimeout(() => {
				let iframe = document.getElementById("ads-text-iframe");
				if(iframe.style.display == "none" || iframe.style.display == "hidden" || iframe.style.visibility == "hidden" || iframe.offsetHeight == 0)
					prompt("Ads may still be blocked, make sure you've added the following rule to your adblocker whitelist", "*youtube.com/*&disableadblock=1");
				iframe.remove();
			}, 500);
		}, 800)
	}

	function inwhitelist(search){
		for(let index in settings.whitelisted){
			for(let id in search){
				if(id !== "display" && settings.whitelisted[index][id] === search[id] && search[id].length)
				return index;
			}
		}
		return -1;
	}

	function parseHTML(markup) {
		if (markup.toLowerCase().trim().indexOf('<!doctype') === 0) {
			var doc = document.implementation.createHTMLDocument("");
			doc.documentElement.innerHTML = markup;
			return doc;
		} else if ('content' in document.createElement('template')) {
			// Template tag exists!
			var el = document.createElement('template');
			el.innerHTML = markup;
			return el.content;
		} else {
			// Template tag doesn't exist!
			var docfrag = document.createDocumentFragment();
			var el = document.createElement('body');
			el.innerHTML = markup;
			for (i = 0; 0 < el.childNodes.length;) {
				docfrag.appendChild(el.childNodes[i]);
			}
			return docfrag;
		}
	}
})(window, document, chrome ? chrome : browser)
