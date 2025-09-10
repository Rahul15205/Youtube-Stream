// public/script.js

// ---------- UI Elements ----------
const roomInput = document.getElementById("roomId");
const usernameInput = document.getElementById("username");
const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");

const youtubeUrlInput = document.getElementById("youtubeUrl");
const loadBtn = document.getElementById("loadBtn");

const messagesEl = document.getElementById("messages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const syncBtn = document.getElementById("syncBtn");

// Call UI elements
const audioCallBtn = document.getElementById("audioCallBtn");
const videoCallBtn = document.getElementById("videoCallBtn");
const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const hangupBtn = document.getElementById("hangupBtn");
const swapBtn = document.getElementById("swapBtn");
const callStatusEl = document.getElementById("call-status");
const callStatusText = document.getElementById("call-status-text");
const callDurationEl = document.getElementById("call-duration");
const inCallControls = document.getElementById("in-call-controls");
const videoContainer = document.getElementById("video-container");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

// ---------- Globals ----------
let socket;
let pc;
let controlChannel; // for playback sync messages
let chatChannel; // for chat
let remoteReady = false;
let shouldCreateOffer = false;
let reconnecting = false;
let currentRoomId = null;

let player;
let playerReady = false;
let playerLoading = true;
let suppressEventsUntil = 0; // timestamp to suppress echo loops

// Call state management
let localStream = null;
let remoteStream = null;
let callState = 'idle'; // 'idle', 'calling', 'receiving', 'connected'
let isAudioMuted = false;
let isVideoEnabled = true;
let callStartTime = null;
let callDurationInterval = null;

// Parse YouTube video ID
function parseVideoId(url) {
  // Support youtu.be/ID and youtube.com/watch?v=ID
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v");
    }
  } catch {
    // If user pasted only the ID
    if (url && url.length >= 10) return url;
  }
  return null;
}

// ---------- YouTube IFrame API ----------
window.onYouTubeIframeAPIReady = function () {
  logStatus("Loading YouTube player...");
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    events: {
      onReady: () => {
        playerReady = true;
        playerLoading = false;
        logStatus("YouTube player ready! You can now load videos.");
        // Hide loading indicator
        const loadingEl = document.getElementById("player-loading");
        if (loadingEl) loadingEl.style.display = "none";
        // Enable buttons that were disabled
        updateButtonStates();
      },
      onStateChange: onPlayerStateChange,
      onPlaybackRateChange: () => {
        sendControl({
          type: "rate",
          rate: player.getPlaybackRate(),
          t: nowTime(),
        });
      },
    },
    playerVars: {
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      controls: 1,
      fs: 1, // Allow fullscreen
      cc_load_policy: 0, // Don't show captions by default
      iv_load_policy: 3, // Don't show annotations
      origin: window.location.origin, // Required for mobile
    },
  });
};

function onPlayerStateChange(e) {
  if (!playerReady) return;
  const state = e.data;
  const t = player.getCurrentTime();

  // Suppress looped reactions for a short window after applying remote command
  if (Date.now() < suppressEventsUntil) return;

  if (state === YT.PlayerState.PLAYING) {
    sendControl({ type: "play", time: t, t0: nowTime() });
  } else if (state === YT.PlayerState.PAUSED) {
    sendControl({ type: "pause", time: t, t0: nowTime() });
  } else if (state === YT.PlayerState.BUFFERING) {
    // Likely a seek/drag event; broadcast new position
    sendControl({ type: "seek", time: t, t0: nowTime() });
  }
}

function loadVideo(urlOrId) {
  const id = parseVideoId(urlOrId);
  if (!id) {
    alert("Invalid YouTube URL or ID. Please paste a valid YouTube URL.");
    return;
  }
  if (!playerReady) {
    logStatus("Player not ready yet, please wait...");
    // Try again in 1 second
    setTimeout(() => loadVideo(urlOrId), 1000);
    return;
  }
  
  const currentVideoId = player.getVideoData()?.video_id;
  
  // Only load and sync if it's a different video
  if (id !== currentVideoId) {
    player.loadVideoById(id);
    sendControl({ type: "load", videoId: id, time: 0, t0: nowTime() });
    logStatus(`Loading video: ${id}`);
  } else {
    logStatus("Video already loaded.");
  }
}

// Force local sync to remote's view of the world (ask peer to send state)
function requestSync() {
  if (controlChannel && controlChannel.readyState === "open") {
    sendControl({ type: "request-sync" });
    logStatus("Requesting sync from peer...");
  } else {
    logStatus("Cannot sync: not connected to peer.");
  }
}

// ---------- WebRTC Setup ----------
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function createPeer() {
  if (pc) pc.close();

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Create channels only if we're the one creating the offer
  if (shouldCreateOffer) {
    controlChannel = pc.createDataChannel("control", { ordered: true });
    setupControlChannel(controlChannel);

    chatChannel = pc.createDataChannel("chat", { ordered: true });
    setupChatChannel(chatChannel);
  }

  pc.ondatachannel = (event) => {
    if (event.channel.label === "control") {
      controlChannel = event.channel;
      setupControlChannel(controlChannel);
    } else if (event.channel.label === "chat") {
      chatChannel = event.channel;
      setupChatChannel(chatChannel);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("candidate", e.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    logStatus(`Peer connection: ${pc.connectionState}`);
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected"
    ) {
      tryIceRestart();
    }
  };
  
  pc.ontrack = (event) => {
    console.log('Received remote track:', event.track.kind, event.streams);
    
    if (event.streams && event.streams[0]) {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      console.log('Remote stream set:', remoteStream.getTracks().length, 'tracks');
      
      // Log track types
      remoteStream.getTracks().forEach(track => {
        console.log('Remote track:', track.kind, track.enabled);
      });
      
      // Update UI when remote stream is received
      updateCallUI();
      logStatus('Receiving peer media...');
    }
  };
}

async function tryIceRestart() {
  if (!pc || reconnecting) return;
  reconnecting = true;
  logStatus("Attempting ICE restart…");
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
  } catch (e) {
    console.error(e);
  } finally {
    setTimeout(() => (reconnecting = false), 1500);
  }
}

// ---------- Signaling (Socket.io) ----------
function connectSignaling() {
  if (socket && socket.connected) return;
  socket = io();

  socket.on("connect", () => logStatus("Signaling connected."));
  socket.on("disconnect", () => logStatus("Signaling disconnected."));
  socket.on("peer-joined", () => {
    remoteReady = true;
    logStatus("Peer joined the room.");

    // Only send current state if we have a video loaded and it's not at the beginning
    setTimeout(() => {
      if (playerReady) {
        const state = player.getPlayerState();
        const time = player.getCurrentTime();
        const videoId = player.getVideoData()?.video_id;
        
        // Only sync if we have a video loaded and some meaningful progress
        if (videoId && (time > 2 || state === YT.PlayerState.PLAYING)) {
          sendControl({
            type: "sync-state",
            videoId,
            state,
            time,
            rate: player.getPlaybackRate(),
            t0: nowTime(),
          });
        } else if (!videoId) {
          // No video loaded, just notify peer to wait
          logStatus("Peer joined. Load a video to start syncing.");
        }
      }
    }, 500);
  });

  socket.on("offer", async (offer) => {
    if (!pc) createPeer();
    
    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", answer);
    } catch (error) {
      console.error('Error handling offer:', error);
      logStatus('Error handling call connection.');
    }
  });

  socket.on("answer", async (answer) => {
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(answer);
      }
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  });

  socket.on("candidate", async (candidate) => {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.error("Error adding ICE candidate", e);
    }
  });

  socket.on("peer-disconnected", () => {
    logStatus("Peer disconnected. Will attempt to reconnect when they return.");
    
    // End any active calls
    if (callState !== 'idle') {
      endCall();
    }
  });
}

function joinRoom(roomId) {
  return new Promise((resolve) => {
    socket.emit("join", roomId, (res) => {
      resolve(res);
    });
  });
}

// ---------- Data Channels ----------
function setupControlChannel(dc) {
  dc.onopen = () => {
    logStatus("Control channel open. Video sync ready!");
    updateButtonStates();
  };
  dc.onclose = () => {
    logStatus("Control channel closed.");
    updateButtonStates();
  };
  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleControlMessage(msg);
  };
}

function setupChatChannel(dc) {
  dc.onopen = () => logStatus("Chat channel open. Ready to chat!");
  dc.onclose = () => logStatus("Chat channel closed.");
  dc.onmessage = (e) => {
    const { user, text, ts } = JSON.parse(e.data);
    appendMessage(user, text, ts, false);
  };
}

function sendControl(obj) {
  if (controlChannel && controlChannel.readyState === "open") {
    console.log('Sending control message:', obj);
    controlChannel.send(JSON.stringify(obj));
  } else {
    console.log('Cannot send control message - channel not ready:', obj);
  }
}

function nowTime() {
  // milliseconds since UNIX epoch (for simple drift hints)
  return Date.now();
}

function handleControlMessage(msg) {
  // Allow call-related messages even when player not ready
  const callMessages = ['call-offer', 'call-answer', 'call-hangup'];
  if (!playerReady && !callMessages.includes(msg.type)) return;

  // Suppress self-trigger loops for a short time window (only for player controls)
  const suppressMs = 400;
  const applyAndSuppress = (fn) => {
    suppressEventsUntil = Date.now() + suppressMs;
    fn();
  };

  switch (msg.type) {
    case "load":
      if (msg.videoId) {
        applyAndSuppress(() => {
          player.loadVideoById(msg.videoId);
          if (typeof msg.time === "number") player.seekTo(msg.time, true);
        });
      }
      break;
    case "play":
      applyAndSuppress(() => {
        if (typeof msg.time === "number") player.seekTo(msg.time, true);
        player.playVideo();
      });
      break;
    case "pause":
      applyAndSuppress(() => {
        if (typeof msg.time === "number") player.seekTo(msg.time, true);
        player.pauseVideo();
      });
      break;
    case "seek":
      applyAndSuppress(() => {
        if (typeof msg.time === "number") player.seekTo(msg.time, true);
      });
      break;
    case "rate":
      applyAndSuppress(() => {
        if (typeof msg.rate === "number") player.setPlaybackRate(msg.rate);
      });
      break;
    case "request-sync": {
      // Send our current state to the peer
      const state = player.getPlayerState();
      const time = player.getCurrentTime();
      const videoId = player.getVideoData()?.video_id;
      sendControl({
        type: "sync-state",
        videoId,
        state,
        time,
        rate: player.getPlaybackRate(),
        t0: nowTime(),
      });
      break;
    }
    case "sync-state": {
      applyAndSuppress(() => {
        const currentVideoId = player.getVideoData()?.video_id;
        
        // Only load new video if it's different from current
        if (msg.videoId && msg.videoId !== currentVideoId) {
          player.loadVideoById(msg.videoId);
        }
        
        // Seek to time if provided and significantly different
        if (typeof msg.time === "number") {
          const currentTime = player.getCurrentTime();
          // Only seek if time difference is more than 2 seconds
          if (Math.abs(currentTime - msg.time) > 2) {
            player.seekTo(msg.time, true);
          }
        }
        
        if (typeof msg.rate === "number") player.setPlaybackRate(msg.rate);
        
        // Apply play/pause state
        if (msg.state === YT.PlayerState.PLAYING) player.playVideo();
        else if (msg.state === YT.PlayerState.PAUSED) player.pauseVideo();
      });
      break;
    }
    case "call-offer": {
      console.log('Received call offer:', msg);
      if (callState === 'idle') {
        callState = 'receiving';
        updateCallUI();
        
        // Show incoming call notification
        const callType = msg.hasVideo ? 'video' : 'audio';
        logStatus(`Incoming ${callType} call...`);
        const accept = confirm(`Incoming ${callType} call. Accept?`);
        
        console.log('User response to call:', accept);
        if (accept) {
          acceptCall(msg.hasVideo);
        } else {
          rejectCall();
        }
      } else {
        console.log('Call offer ignored - current state:', callState);
      }
      break;
    }
    
    case "call-answer": {
      if (callState === 'calling') {
        if (msg.accepted) {
          // Now add our media tracks and create a new offer
          if (localStream) {
            console.log('Adding caller tracks:', localStream.getTracks().length);
            localStream.getTracks().forEach(track => {
              console.log('Adding caller track:', track.kind, track.enabled);
              pc.addTrack(track, localStream);
            });
            console.log('Caller total senders:', pc.getSenders().length);
            
            // Create new offer with media tracks
            pc.createOffer().then(offer => {
              return pc.setLocalDescription(offer);
            }).then(() => {
              socket.emit('offer', pc.localDescription);
            }).catch(error => {
              console.error('Error creating offer with media:', error);
            });
          }
          
          callState = 'connected';
          callStartTime = Date.now();
          startCallDurationTimer();
          updateCallUI();
          logStatus('Call connected!');
        } else {
          logStatus('Call was declined.');
          endCall();
        }
      }
      break;
    }
    
    case "call-hangup": {
      if (callState !== 'idle') {
        logStatus('Call ended by peer.');
        endCall();
      }
      break;
    }
    
    default:
      break;
  }
}

// ---------- Chat ----------
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  const user = usernameInput.value.trim() || "You";
  const ts = Date.now();
  appendMessage(user, text, ts, true);

  if (chatChannel && chatChannel.readyState === "open") {
    chatChannel.send(JSON.stringify({ user, text, ts }));
  }
  chatInput.value = "";
}

function appendMessage(user, text, ts, mine = false) {
  const time = new Date(ts);
  const hours = String(time.getHours()).padStart(2, "0");
  const minutes = String(time.getMinutes()).padStart(2, "0");
  const meta = `${hours}:${minutes} — ${user}`;

  const wrapper = document.createElement("div");
  wrapper.className = `msg${mine ? " me" : ""}`;

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = meta;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(metaEl);
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Audio/Video Call Functions ----------
async function startCall(includeVideo = false) {
  if (callState !== 'idle' || !controlChannel || controlChannel.readyState !== 'open') {
    logStatus('Cannot start call: not connected or already in call.');
    return;
  }

  try {
    callState = 'calling';
    updateCallUI();
    
    // Get user media
    const constraints = {
      audio: true,
      video: includeVideo ? { width: 640, height: 480, facingMode: 'user' } : false
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    
    // Send call offer first (before adding tracks)
    sendControl({
      type: 'call-offer',
      hasVideo: includeVideo,
      timestamp: Date.now()
    });
    
    logStatus(`${includeVideo ? 'Video' : 'Audio'} call initiated...`);
    
  } catch (error) {
    console.error('Error starting call:', error);
    logStatus('Failed to access camera/microphone. Please check permissions.');
    endCall();
  }
}

async function acceptCall(hasVideo) {
  try {
    const constraints = {
      audio: true,
      video: hasVideo ? { width: 640, height: 480, facingMode: 'user' } : false
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    
    // Add tracks to peer connection
    console.log('Adding local tracks:', localStream.getTracks().length);
    localStream.getTracks().forEach(track => {
      console.log('Adding track:', track.kind, track.enabled);
      pc.addTrack(track, localStream);
    });
    console.log('Total senders:', pc.getSenders().length);
    
    // Send call answer first
    sendControl({
      type: 'call-answer',
      accepted: true,
      timestamp: Date.now()
    });
    
    callState = 'connected';
    callStartTime = Date.now();
    startCallDurationTimer();
    updateCallUI();
    
  } catch (error) {
    console.error('Error accepting call:', error);
    rejectCall();
  }
}

function rejectCall() {
  sendControl({
    type: 'call-answer',
    accepted: false,
    timestamp: Date.now()
  });
  endCall();
}

function endCall() {
  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Clear remote stream
  if (remoteStream) {
    remoteStream = null;
  }
  
  // Reset video elements
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  
  // Send hangup signal if we're connected
  if (callState !== 'idle') {
    sendControl({
      type: 'call-hangup',
      timestamp: Date.now()
    });
  }
  
  callState = 'idle';
  isAudioMuted = false;
  isVideoEnabled = true;
  
  // Stop call timer
  if (callDurationInterval) {
    clearInterval(callDurationInterval);
    callDurationInterval = null;
  }
  
  updateCallUI();
  logStatus('Call ended.');
}

function toggleMute() {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = isAudioMuted;
      isAudioMuted = !isAudioMuted;
      updateCallUI();
    }
  }
}

function toggleCamera() {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !isVideoEnabled;
      isVideoEnabled = !isVideoEnabled;
      updateCallUI();
    }
  }
}

function updateCallUI() {
  // Update button states
  audioCallBtn.disabled = callState !== 'idle' || !controlChannel || controlChannel.readyState !== 'open';
  videoCallBtn.disabled = callState !== 'idle' || !controlChannel || controlChannel.readyState !== 'open';
  
  // Show/hide call status
  if (callState === 'idle') {
    callStatusEl.style.display = 'none';
    inCallControls.style.display = 'none';
    videoContainer.style.display = 'none';
  } else {
    callStatusEl.style.display = 'block';
    
    if (callState === 'calling') {
      callStatusText.textContent = 'Calling...';
      inCallControls.style.display = 'none';
    } else if (callState === 'receiving') {
      callStatusText.textContent = 'Incoming call';
      inCallControls.style.display = 'none';
    } else if (callState === 'connected') {
      callStatusText.textContent = 'In call';
      inCallControls.style.display = 'block';
      
      // Show video container if there's a video track
      const hasVideo = (localStream && localStream.getVideoTracks().some(t => t.enabled)) ||
                       (remoteStream && remoteStream.getVideoTracks && remoteStream.getVideoTracks().length > 0);
      videoContainer.style.display = hasVideo ? 'block' : 'none';
      
      // Ensure swap listeners are ready
      setupVideoSwap();
    }
  }
  
  // Update mute/camera button states
  muteBtn.classList.toggle('muted', isAudioMuted);
  muteBtn.title = isAudioMuted ? 'Unmute' : 'Mute';
  
  cameraBtn.classList.toggle('muted', !isVideoEnabled);
  cameraBtn.title = isVideoEnabled ? 'Turn Camera Off' : 'Turn Camera On';
}

function startCallDurationTimer() {
  if (callDurationInterval) clearInterval(callDurationInterval);
  
  callDurationInterval = setInterval(() => {
    if (callStartTime) {
      const duration = Date.now() - callStartTime;
      const minutes = Math.floor(duration / 60000);
      const seconds = Math.floor((duration % 60000) / 1000);
      callDurationEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

// Swap between local and remote video (Picture-in-Picture)
function swapVideos(event) {
  console.log('🔄 Video swap function called');
  
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  const container = document.getElementById('video-container');
  if (!container) {
    console.error('❌ Video container not found');
    return;
  }
  
  const isSwapped = container.classList.contains('pip-swapped');
  console.log('Current swap state:', isSwapped ? 'Local main' : 'Remote main');
  
  if (isSwapped) {
    container.classList.remove('pip-swapped');
    logStatus('👥 Remote video in main view');
    console.log('✅ Swapped to: Remote video main, Local video PiP');
  } else {
    container.classList.add('pip-swapped');
    logStatus('😊 Your video in main view');
    console.log('✅ Swapped to: Local video main, Remote video PiP');
  }
  
  // Force a visual update
  container.style.display = 'none';
  container.offsetHeight; // Force reflow
  container.style.display = 'block';
}

// ---------- Helpers ----------
function updateButtonStates() {
  // Enable/disable buttons based on player and connection state
  loadBtn.disabled = !playerReady;
  playBtn.disabled = !playerReady;
  pauseBtn.disabled = !playerReady;
  syncBtn.disabled = !playerReady || !controlChannel || controlChannel.readyState !== "open";
  
  // Update call button states
  updateCallUI();
  
  // Update button text to show status
  if (playerLoading) {
    loadBtn.textContent = "Loading Player...";
  } else if (!playerReady) {
    loadBtn.textContent = "Player Not Ready";
  } else {
    loadBtn.textContent = "Load Video";
  }
}

function logStatus(s) {
  statusEl.textContent = s;
  console.log("[status]", s);
}

// ---------- Event Wiring ----------
connectBtn.addEventListener("click", async () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert("Enter a Room ID to connect.");
    return;
  }
  currentRoomId = roomId;

  connectSignaling();

  const res = await joinRoom(roomId);
  if (!res?.ok) {
    alert(res?.error || "Failed to join room.");
    return;
  }
  shouldCreateOffer = res.shouldCreateOffer;
  logStatus(`Joined room "${roomId}" (${res.clients}/2).`);

  createPeer();

  if (shouldCreateOffer) {
    // We initiate the offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
  }
});

loadBtn.addEventListener("click", () => {
  const url = youtubeUrlInput.value.trim();
  loadVideo(url);
});

playBtn.addEventListener("click", () => {
  if (!playerReady) return;
  player.playVideo(); // onStateChange sends "play" with current time
});

pauseBtn.addEventListener("click", () => {
  if (!playerReady) return;
  player.pauseVideo(); // onStateChange sends "pause" with current time
});

syncBtn.addEventListener("click", () => {
  requestSync();
});

sendBtn.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

// Call control event listeners
audioCallBtn.addEventListener("click", () => startCall(false));
videoCallBtn.addEventListener("click", () => startCall(true));
muteBtn.addEventListener("click", toggleMute);
cameraBtn.addEventListener("click", toggleCamera);
hangupBtn.addEventListener("click", endCall);
swapBtn.addEventListener("click", swapVideos);

// Setup video swap event listeners
function setupVideoSwap() {
  console.log('🔍 Setting up video swap listeners');
  
  const localVideoEl = document.getElementById('localVideo');
  const remoteVideoEl = document.getElementById('remoteVideo');
  
  if (localVideoEl && remoteVideoEl) {
    // Remove any existing listeners first
    localVideoEl.removeEventListener('click', swapVideos);
    localVideoEl.removeEventListener('touchend', swapVideos);
    remoteVideoEl.removeEventListener('click', swapVideos);
    remoteVideoEl.removeEventListener('touchend', swapVideos);
    
    // Add fresh listeners
    localVideoEl.addEventListener('click', swapVideos);
    localVideoEl.addEventListener('touchend', swapVideos);
    remoteVideoEl.addEventListener('click', swapVideos);
    remoteVideoEl.addEventListener('touchend', swapVideos);
    
    console.log('✅ Video swap listeners added successfully');
  } else {
    console.warn('⚠️ Video elements not found for swap setup');
  }
}

// Call setup when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupVideoSwap);
} else {
  setupVideoSwap();
}

// Mobile-friendly helpers
function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
}

function handleMobileKeyboard() {
  if (!isMobile()) return;
  
  // Scroll chat to bottom when input is focused (keyboard appears)
  chatInput.addEventListener('focus', () => {
    setTimeout(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 300);
  });
}

// Initialize UI state
(function initializeUI() {
  // Set initial button states
  updateButtonStates();
  
  // Add mobile-specific handling
  handleMobileKeyboard();
  
  // Prefill room from URL
  const u = new URL(window.location.href);
  const room =
    u.searchParams.get("room") ||
    (u.hash.startsWith("#room=") ? u.hash.slice(6) : "");
  if (room) roomInput.value = room;
  
  // Show initial loading status
  logStatus("Waiting for YouTube player to load...");
  
  // Add touch feedback for better mobile UX
  if (isMobile()) {
    document.documentElement.style.setProperty('--tap-highlight-color', 'rgba(31, 111, 235, 0.3)');
    document.body.style.webkitTapHighlightColor = 'rgba(31, 111, 235, 0.3)';
  }
})();
