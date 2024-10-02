import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

function App() {
  const [userName, setUserName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [peerConnections, setPeerConnections] = useState(new Map());

  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  useEffect(() => {
    const randomUserName = "User-" + Math.floor(Math.random() * 100000);
    setUserName(randomUserName);

    socketRef.current = io.connect('https://localhost:8080/', {
        auth: { userName: randomUserName, password: "x" }
    });

    setupSocketListeners();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const setupSocketListeners = () => {
    socketRef.current.on('userJoined', handleUserJoined);
    socketRef.current.on('offer', handleOffer);
    socketRef.current.on('answer', handleAnswer);
    socketRef.current.on('iceCandidate', handleIceCandidate);
    socketRef.current.on('userLeft', handleUserLeft);
  };

  const joinRoom = async () => {
    await setupLocalStream();
    socketRef.current.emit('joinRoom', roomId);
  };

  const setupLocalStream = async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localVideoRef.current.srcObject = localStreamRef.current;
    } catch (err) {
      console.error("Error accessing media devices:", err);
    }
  };

  const toggleCapture = () => {
    if (isCapturing) {
      stopCapture();
    } else {
      startCapture();
    }
  };

  const startCapture = () => {
    if (!localStreamRef.current) return;

    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    mediaRecorderRef.current = new MediaRecorder(new MediaStream([audioTrack]));

    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorderRef.current.start(3333);
    setIsCapturing(true);
  };

  const stopCapture = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      sendAudioChunks();
    }
    setIsCapturing(false);
  };

  const sendAudioChunks = () => {
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const formData = new FormData();
    const timestamp = Date.now();
    const fileName = `chunk-${timestamp}.webm`;
    formData.append('audio', audioBlob, fileName);
  
    fetch('https://localhost:8080/subjects/transcribe', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      setTranscription(prev => prev + data.data.text + ' ');
    })
    .catch(error => {
      console.error('Fetch error:', error);
      if (error instanceof TypeError && error.message.includes('NetworkError')) {
        console.error('Possible CORS or network connectivity issue');
      }
    });
  
    audioChunksRef.current = [];
  };

  const createPeerConnection = (targetSocketId, targetUserName) => {
    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
    });

    localStreamRef.current.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStreamRef.current);
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit('iceCandidate', { candidate: event.candidate, targetSocketId });
      }
    };

    peerConnection.ontrack = (event) => {
      const remoteVideo = document.createElement('video');
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.id = `remote-video-${targetSocketId}`;

      const remoteVideoContainer = document.createElement('div');
      remoteVideoContainer.className = 'remote-video-container';
      remoteVideoContainer.appendChild(remoteVideo);

      const remoteUserLabel = document.createElement('div');
      remoteUserLabel.textContent = targetUserName;
      remoteUserLabel.className = 'user-label';
      remoteVideoContainer.appendChild(remoteUserLabel);

      remoteVideosRef.current.appendChild(remoteVideoContainer);
    };

    return peerConnection;
  };

  const handleUserJoined = async ({ userName: joinedUserName, socketId, roomId }) => {
    console.log(`${joinedUserName} joined the room`);
    if (peerConnections.has(socketId)) {
      console.log(`Peer connection already exists for ${socketId}`);
      return;
    }
    const peerConnection = createPeerConnection(socketId, joinedUserName);
    setPeerConnections(prev => new Map(prev).set(socketId, peerConnection));

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socketRef.current.emit('offer', { offer, targetSocketId: socketId });
    } catch (err) {
      console.error("Error creating offer:", err);
    }
  };

  const handleOffer = async ({ offer, from, userName: offerUserName }) => {
    const peerConnection = createPeerConnection(from, offerUserName);
    setPeerConnections(prev => new Map(prev).set(from, peerConnection));

    try {
      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socketRef.current.emit('answer', { answer, targetSocketId: from });
    } catch (err) {
      console.error("Error handling offer:", err);
    }
  };

  const handleAnswer = async ({ answer, from }) => {
    const peerConnection = peerConnections.get(from);
    if (peerConnection) {
      try {
        await peerConnection.setRemoteDescription(answer);
      } catch (err) {
        console.error("Error setting remote description:", err);
      }
    }
  };

  const handleIceCandidate = ({ candidate, from }) => {
    const peerConnection = peerConnections.get(from);
    if (peerConnection) {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  };

  const handleUserLeft = ({ socketId }) => {
    const peerConnection = peerConnections.get(socketId);
    if (peerConnection) {
      peerConnection.close();
      setPeerConnections(prev => {
        const newMap = new Map(prev);
        newMap.delete(socketId);
        return newMap;
      });
    }
    const remoteVideoContainer = document.querySelector(`#remote-video-${socketId}`);
    if (remoteVideoContainer) {
      remoteVideoContainer.remove();
    }
  };

  return (
    <div className="container">
      <div className="row mb-3 mt-3 justify-content-md-center">
        <div id="user-name">{userName}</div>
        <input 
          type="text" 
          value={roomId} 
          onChange={(e) => setRoomId(e.target.value)} 
          placeholder="Enter Room ID"
        />
        <button onClick={joinRoom} className="btn btn-primary">Join Room</button>
      </div>
      <div className="row mb-3 justify-content-md-center">
        <button onClick={toggleCapture} className="btn btn-success col-2">
          {isCapturing ? 'Stop Capture' : 'Start Capture'}
        </button>
      </div>
      <div id="videos">
        <video ref={localVideoRef} className="video-player" id="local-video" autoPlay playsInline muted></video>
        <div ref={remoteVideosRef} id="remote-videos"></div>
      </div>
      <div className="row mt-3">
        <h3>Transcription:</h3>
        <p>{transcription}</p>
      </div>
    </div>
  );
}

export default App;