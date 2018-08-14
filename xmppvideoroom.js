var XMPPVideoRoom = (function() {

	
	/** 
	 * Interface with Jitsi Video Room and WebRTC-streamer API
	 * @constructor
	 * @param {string} xmppUrl - url of XMPP server
	 * @param {string} srvurl - url of WebRTC-streamer
	*/
	var XMPPVideoRoom = function XMPPVideoRoom (xmppUrl, srvurl) {	
		this.xmppUrl     = xmppUrl;
		this.srvurl      = srvurl || location.protocol+"//"+window.location.hostname+":"+window.location.port;
		this.sessionList = {};
	};
		

	/** 
	* Ask to publish a stream from WebRTC-streamer in a XMPP Video Room user
	* @param {string} roomid - id of the XMPP Video Room to join
	* @param {string} url - WebRTC stream to publish
	* @param {string} name - name in Video Room
	*/
	XMPPVideoRoom.prototype.join = function(roomid, url, name) {
		var bind = this;

		var connection = new Strophe.Connection(location.protocol+ "//" + this.xmppUrl + "/http-bind");
		connection.addHandler(function(iq) { return bind.OnJingle(connection, iq, url) }, 'urn:xmpp:jingle:1', 'iq', 'set', null, null);

//		connection.rawInput = function (data) { console.log('RECV: ' + data); };
//		connection.rawOutput = function (data) { console.log('SEND: ' + data); };
			// disco stuff
			if (connection.disco) {
				connection.disco.addIdentity('client', 'http://jitsi.org/jitsimeet');
				connection.disco.addFeature(Strophe.NS.DISCO_INFO);
				connection.disco.addFeature(Strophe.NS.CAPS);
				connection.disco.addFeature("urn:xmpp:jingle:1");	
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:1");	
				connection.disco.addFeature("urn:xmpp:jingle:transports:ice-udp:1");	
				connection.disco.addFeature("urn:xmpp:jingle:apps:dtls:0");	
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:audio");	
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:video");	
				connection.disco.addFeature("urn:ietf:rfc:5761")
				connection.disco.addFeature("urn:ietf:rfc:5888"); // a=group, e.g. bundle
 				
			}
		connection.connect(this.xmppUrl, null, function(status) { bind.onConnect(connection, roomid, name, status); });
	}

	XMPPVideoRoom.prototype.onReceiveCandidate = function(connection, iq, candidateList) {
		console.log("============candidateList:" +  JSON.stringify(candidateList));
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");
		var from = iq.getAttribute("to");
		var to = iq.getAttribute("from");

		candidateList.forEach(function (candidate) {
			var jsoncandidate = SDPUtil.parse_icecandidate(candidate.candidate);
			console.log("<=== webrtc candidate:" +  JSON.stringify(jsoncandidate));
			// get ufrag
			var ufrag = "";
			var elems = candidate.candidate.split(' ');
			for (var i = 8; i < elems.length; i += 2) {
				switch (elems[i]) {
					case 'ufrag':
						ufrag = elems[i + 1];
						break;
				}
			}
			// get pwd
			var pwd = "";
			var contents = $(jingle).find('>content');
			contents.each( (contentIdx,content) => {
				var transports = $(content).find('>transport');
				transports.each( (idx,transport) => {
					if (ufrag == transport.getAttribute('ufrag')) {
						pwd = transport.getAttribute('pwd');
					}
				})
			});
			
			// convert candidate from webrtc to jingle 
			var iq = $iq({ type: "set",  from, to })
					.c('jingle', {xmlns: 'urn:xmpp:jingle:1'})
						.attrs({ action: "transport-info",  sid, ufrag, pwd })
						.c('candidate', jsoncandidate)
						.up()
					.up();

			var id = connection.sendIQ(iq, () => {
				console.log("===> xmpp transport-info ok sid:" + sid);		
			},() => {
				console.log("############transport-info error sid:" + sid);
			});
		});	
	}

	XMPPVideoRoom.prototype.onCall = function(connection, iq, data) {
		console.log("<=== webrtc answer sdp:" + data.sdp);		
		
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");
		
		this.sessionList[sid].state = "UP";
		var earlyCandidates = this.sessionList[sid].earlyCandidates;
		while (earlyCandidates.length) {
				var candidate = earlyCandidates.shift();
				var method = this.srvurl + "/api/addIceCandidate?peerid="+ sid;
				request("POST" , method, { body: JSON.stringify(candidate) }).done( function (response) { 
						if (response.statusCode === 200) {
							console.log("method:"+method+ " answer:" +response.body);
						}
						else {
							bind.onError(response.statusCode);
						}
					}
				);	
		}
				
		var sdp = new SDP(data.sdp);
		var iqAnswer = $iq({ type: "set",  from: iq.getAttribute("to"), to: iq.getAttribute("from") })
		var jingle = iqAnswer.c('jingle', {xmlns: 'urn:xmpp:jingle:1'})
						.attrs({ action: "session-accept",  sid, responder:iq.getAttribute("to") });

		var answer = sdp.toJingle(jingle); 
		var id = connection.sendIQ(answer, () => {
			console.log("===> xmpp session-accept ok sid:" + sid);
				
			var bind = this;
			var method = this.srvurl + "/api/getIceCandidate?peerid="+ sid;
			request("GET" , method).done( function (response) { 
					if (response.statusCode === 200) {
						bind.onReceiveCandidate(connection, answer.node, JSON.parse(response.body));
					}
					else {
						bind.onError(response.statusCode);
					}
				}
			);			
		},() => {
			console.log("############session-accept error sid:" + sid);
		});
	}
	
	XMPPVideoRoom.prototype.onError = function (error) {
		console.log("############onError:" + error)
	}
		
	XMPPVideoRoom.prototype.OnJingle = function(connection, iq, url) {
		console.log("OnJingle from:" + iq.getAttribute("from") + " to:" + iq.getAttribute("to") + " action:" +  iq.querySelector("jingle").getAttribute("action"));
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");
		var action = jingle.getAttribute("action");
		var id = iq.getAttribute("id");

		var bind = this;

		if (action === "session-initiate") {	
			var ack = $iq({ type: "result",  from: iq.getAttribute("to"), to: iq.getAttribute("from"), id })
			connection.sendIQ(ack);		
			
			var sdp = new SDP('');
			sdp.fromJingle($(jingle));
			console.log("<=== xmpp offer sdp:" + sdp.raw);
			
			this.sessionList[sid] = { connection, state: "INIT", earlyCandidates:[] } ;

			var method = this.srvurl + "/api/call?peerid="+ sid +"&url="+encodeURIComponent(url)+"&options="+encodeURIComponent("rtptransport=tcp&timeout=60");
			request("POST" , method, {body:JSON.stringify({type:"offer",sdp:sdp.raw})}).done( function (response) { 
					if (response.statusCode === 200) {
						bind.onCall(connection, iq, JSON.parse(response.body));
					}
					else {
						bind.onError(response.statusCode);
					}
				}
			);
			
		} else if (action === "transport-info") {

			console.log("<=== xmpp candidate sid:" + sid);
			
			var ack = $iq({ type: "result",  from: iq.getAttribute("to"), to: iq.getAttribute("from"), id })
			connection.sendIQ(ack);		

			var contents = $(jingle).find('>content');
			contents.each( (contentIdx,content) => {
				var transports = $(content).find('>transport');
				transports.each( (idx,transport) => {
					var ufrag = transport.getAttribute('ufrag');
					var candidates = $(transport).find('>candidate');
					candidates.each ( (idx,candidate) => {
						var sdp = SDPUtil.candidateFromJingle(candidate);
						sdp = sdp.replace("a=candidate","candidate");
						sdp = sdp.replace("\r\n"," ufrag " + ufrag);
						var candidate = { candidate:sdp, sdpMid:"", sdpMLineIndex:contentIdx }
						console.log("===> webrtc candidate :" + JSON.stringify(candidate));
			
						if (this.sessionList[sid].state == "INIT") {
							this.sessionList[sid].earlyCandidates.push(candidate);
						} else {
							var method = this.srvurl + "/api/addIceCandidate?peerid="+ sid;
							request("POST" , method, { body: JSON.stringify(candidate) }).done( function (response) { 
									if (response.statusCode === 200) {
										console.log("method:"+method+ " answer:" +response.body);
									}
									else {
										bind.onError(response.statusCode);
									}
								}
							);			
						}							
					});
				});
			});
	
		} else if (action === "session-terminate") {			
			console.log("<=== xmpp session-terminate sid:" + sid + " reason:" + jingle.querySelector("reason").textContent);

			var ack = $iq({ type: "result",  from: iq.getAttribute("to"), to: iq.getAttribute("from"), id })
			connection.sendIQ(ack);		

			var method = this.srvurl + "/api/hangup?peerid="+ sid;
			request("GET" , method).done( function (response) { 
					if (response.statusCode === 200) {
						console.log("method:"+method+ " answer:" +response.body);
					}
					else {
						bind.onError(response.statusCode);
					}
				}
			);		
		}
					
		return true;		
	}
	
	XMPPVideoRoom.prototype.onConnect = function(connection, roomid, name, status)
	{		
	    if (status === Strophe.Status.CONNECTING) {
			console.log('Strophe is connecting.');
	    } else if (status === Strophe.Status.CONNFAIL) {
			console.log('Strophe failed to connect.');
	    } else if (status === Strophe.Status.DISCONNECTING) {
			console.log('Strophe is disconnecting.');
	    } else if (status === Strophe.Status.DISCONNECTED) {
			console.log('Strophe is disconnected.');
	    } else if (status === Strophe.Status.CONNECTED) {
			console.log('Strophe is connected.');
			


			var roomUrl = roomid + "@" + "conference." + this.xmppUrl;
			var extPresence = Strophe.xmlElement('nick', {xmlns:'http://jabber.org/protocol/nick'}, name);
			connection.muc.join(roomUrl, name, null, null, null, null, null, extPresence);		
		}
	}
		
	XMPPVideoRoom.prototype.leave = function (roomid, userName) {
		Object.entries(this.sessionList).forEach( ([sid,session]) => {
			var roomUrl = roomid + "@" + "conference." + this.xmppUrl;

			var iq = $iq({ type: "set",  from: roomUrl +"/" + userName, to: roomUrl })
							.c('jingle', {xmlns: 'urn:xmpp:jingle:1'})
								.attrs({ action: "session-terminate",  sid})
							.up();
			session.connection.sendIQ(iq);

			var bind = this;
			var method = this.srvurl + "/api/hangup?peerid="+ sid;
			request("GET" , method).done( function (response) { 
					if (response.statusCode === 200) {
						console.log("method:"+method+ " answer:" +response.body);
					}
					else {
						bind.onError(response.statusCode);
					}
				}
			);					
			session.connection.muc.leave(roomUrl, userName);
			session.connection.flush();
			session.connection.disconnect();	
		});
		this.sessionList = {};
	}

	return XMPPVideoRoom;
})();

module.exports = XMPPVideoRoom;
