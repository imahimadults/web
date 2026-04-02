/**
 * えっちなシャトルラン：録音・ミキサー・MP3書き出し
 */

// --- 1. グローバル変数 ---
let audioCtx = null;
let micStream = null;
let micSource = null;
let trackElement = new Audio(); // BGM再生用
let recorder = null;
let recordedChunks = [];
let recordedMicBuffer = null; // 録音されたマイクのAudioBuffer

// 再生同期用
let previewMicSource = null;
let previewBgmSource = null;
let previewGainMic = null;
let previewGainBgm = null;
let isPreviewPlaying = false;

// 設定
let isRecording = false;
let startTime = 0;
let timerInterval = null;
let wakeLock = null;
let isTestMode = false;

// --- 2. UI要素 ---
const trackListEl = document.getElementById('track-list');
const audioUploadInput = document.getElementById('audio-upload');
const currentTrackNameEl = document.getElementById('current-track-name');
const startBtn = document.getElementById('start-btn');
const testBtn = document.getElementById('test-btn');
const resultSection = document.getElementById('result-section');
const retakeBtn = document.getElementById('retake-btn');
const recordTimeEl = document.getElementById('record-time');
const statusMsgEl = document.getElementById('status-msg');
const micMeterEl = document.getElementById('mic-meter');

// ミキサーUI
const mixerMicVol = document.getElementById('mixer-mic-vol');
const mixerBgmVol = document.getElementById('mixer-bgm-vol');
const mixerMicValEl = document.getElementById('mixer-mic-val');
const mixerBgmValEl = document.getElementById('mixer-bgm-val');
const playPreviewBtn = document.getElementById('play-preview-btn');
const exportMp3Btn = document.getElementById('export-mp3-btn');
const exportProgressContainer = document.getElementById('export-progress-container');
const exportProgressBar = document.getElementById('export-progress-bar');
const exportPercentEl = document.getElementById('export-percent');

// --- 3. 初期化 ---
window.onload = () => {
    presetTracks.forEach(track => {
        const item = document.createElement('div');
        item.className = 'track-item';
        item.innerHTML = `
            <span class="track-title">${track.title}</span>
            <span class="track-desc">${track.description}</span>
        `;
        item.onclick = () => selectTrack(track.url, track.title, item);
        trackListEl.appendChild(item);
    });
};

function selectTrack(url, name, element = null) {
    if (isRecording) return;
    trackElement.src = url;
    currentTrackNameEl.textContent = name;
    document.querySelectorAll('.track-item').forEach(el => el.classList.remove('selected'));
    if (element) element.classList.add('selected');
    statusMsgEl.textContent = "WAITING";
    resultSection.classList.add('hidden');
}

audioUploadInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        selectTrack(url, "📁 " + file.name);
    }
};

// --- 4. 音声エンジン ---
async function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function getMicStream() {
    return await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false // 自動補正オフ
        }
    });
}

// --- 5. 録音処理 ---
async function startRecording() {
    if (!trackElement.src) return alert("音源を選んでね♡");

    try {
        await initAudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        micStream = await getMicStream();

        // メーター用
        micSource = audioCtx.createMediaStreamSource(micStream);
        const analyser = audioCtx.createAnalyser();
        micSource.connect(analyser);
        updateMeter(analyser);

        // 録音開始 (マイクのみ)
        recorder = new MediaRecorder(micStream);
        recordedChunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        recorder.onstop = processRecordedAudio;

        recorder.start();
        trackElement.currentTime = 0;
        trackElement.play();

        isRecording = true;
        document.body.classList.add('recording');
        updateUIState(true);
        startTimer();
        statusMsgEl.textContent = "RECORDING...";

        // WakeLock
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen').catch(()=>{});

    } catch (err) {
        console.error(err);
        alert("マイクが使えないみたい...");
    }
}

async function stopRecording() {
    if (!isRecording) return;
    recorder.stop();
    trackElement.pause();
    isRecording = false;
    document.body.classList.remove('recording');
    updateUIState(false);
    stopTimer();
    statusMsgEl.textContent = "録音完了！ミキサーを準備中...";
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

async function processRecordedAudio() {
    const blob = new Blob(recordedChunks);
    const arrayBuffer = await blob.arrayBuffer();
    recordedMicBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    // ミキサー表示
    resultSection.classList.remove('hidden');
    statusMsgEl.textContent = "READY TO MIX";
    // 自動スクロール
    resultSection.scrollIntoView({ behavior: 'smooth' });
}

// --- 6. プレビュー & ミキサー制御 ---
function updatePreviewVolume() {
    if (previewGainMic) previewGainMic.gain.value = mixerMicVol.value;
    if (previewGainBgm) previewGainBgm.gain.value = mixerBgmVol.value;
    mixerMicValEl.textContent = Math.round(mixerMicVol.value * 100) + "%";
    mixerBgmValEl.textContent = Math.round(mixerBgmVol.value * 100) + "%";
}

async function togglePreview() {
    if (isPreviewPlaying) {
        stopPreview();
    } else {
        await startPreview();
    }
}

async function startPreview() {
    if (!recordedMicBuffer) return;
    await initAudioContext();
    
    // BGMの音源を取得 (trackElementから直接ではなく、Bufferとして読み込む)
    const bgmResponse = await fetch(trackElement.src);
    const bgmArrayBuffer = await bgmResponse.arrayBuffer();
    const bgmBuffer = await audioCtx.decodeAudioData(bgmArrayBuffer);

    // ソース作成
    previewMicSource = audioCtx.createBufferSource();
    previewMicSource.buffer = recordedMicBuffer;
    previewBgmSource = audioCtx.createBufferSource();
    previewBgmSource.buffer = bgmBuffer;

    previewGainMic = audioCtx.createGain();
    previewGainBgm = audioCtx.createGain();
    
    updatePreviewVolume();

    previewMicSource.connect(previewGainMic).connect(audioCtx.destination);
    previewBgmSource.connect(previewGainBgm).connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    previewMicSource.start(now);
    previewBgmSource.start(now);

    isPreviewPlaying = true;
    playPreviewBtn.textContent = "■ プレビュー停止";
    
    previewMicSource.onended = stopPreview;
}

function stopPreview() {
    if (previewMicSource) { previewMicSource.stop(); previewMicSource = null; }
    if (previewBgmSource) { previewBgmSource.stop(); previewBgmSource = null; }
    isPreviewPlaying = false;
    playPreviewBtn.textContent = "▶ プレビュー再生";
}

// --- 7. MP3 書き出し (Export) ---
async function exportMP3() {
    if (!recordedMicBuffer) return;
    stopPreview();

    exportProgressContainer.classList.remove('hidden');
    exportMp3Btn.disabled = true;

    // BGMの読み込み
    const bgmResponse = await fetch(trackElement.src);
    const bgmArrayBuffer = await bgmResponse.arrayBuffer();
    const bgmBuffer = await audioCtx.decodeAudioData(bgmArrayBuffer);

    // オフラインレンダリング (高速ミックス)
    const duration = Math.max(recordedMicBuffer.duration, bgmBuffer.duration);
    const offlineCtx = new OfflineAudioContext(2, 44100 * duration, 44100);

    const micSource = offlineCtx.createBufferSource();
    micSource.buffer = recordedMicBuffer;
    const bgmSource = offlineCtx.createBufferSource();
    bgmSource.buffer = bgmBuffer;

    const gMic = offlineCtx.createGain();
    const gBgm = offlineCtx.createGain();
    gMic.gain.value = parseFloat(mixerMicVol.value);
    gBgm.gain.value = parseFloat(mixerBgmVol.value);

    micSource.connect(gMic).connect(offlineCtx.destination);
    bgmSource.connect(gBgm).connect(offlineCtx.destination);

    micSource.start(0);
    bgmSource.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    
    // MP3 エンコード (lamejsを使用)
    encodeToMp3(renderedBuffer);
}

function encodeToMp3(audioBuffer) {
    const channels = 2;
    const sampleRate = audioBuffer.sampleRate;
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 64); // 8MB制限のため 64kbps に圧縮
    const mp3Data = [];

    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    
    // Float32 -> Int16
    const leftInt = new Int16Array(left.length);
    const rightInt = new Int16Array(right.length);
    for (let i = 0; i < left.length; i++) {
        leftInt[i] = left[i] < 0 ? left[i] * 32768 : left[i] * 32767;
        rightInt[i] = right[i] < 0 ? right[i] * 32768 : right[i] * 32767;
    }

    const sampleBlockSize = 1152;
    for (let i = 0; i < leftInt.length; i += sampleBlockSize) {
        const leftChunk = leftInt.subarray(i, i + sampleBlockSize);
        const rightChunk = rightInt.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
        
        // 進捗表示
        const progress = Math.round((i / leftInt.length) * 100);
        exportProgressBar.style.width = progress + "%";
        exportPercentEl.textContent = progress + "%";
    }

    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) mp3Data.push(mp3buf);

    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);
    
    // ダウンロード実行
    const a = document.createElement('a');
    a.href = url;
    a.download = `shuttle_run_mix_${Date.now()}.mp3`;
    a.click();

    exportProgressContainer.classList.add('hidden');
    exportMp3Btn.disabled = false;
    alert("MP3の書き出しが完了しました！♡");
}

// --- 8. ユーティリティ ---
function updateMeter(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
        if (!isRecording && !isTestMode) { micMeterEl.style.width = "0%"; return; }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        micMeterEl.style.width = Math.min(100, avg * 400) + "%";
        requestAnimationFrame(loop);
    };
    loop();
}

function startTimer() {
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const diff = Date.now() - startTime;
        const m = Math.floor(diff / 60000).toString().padStart(2, '0');
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
        recordTimeEl.textContent = `${m}:${s}`;
    }, 1000);
}
function stopTimer() { clearInterval(timerInterval); }

function updateUIState(recording) {
    if (recording) {
        startBtn.textContent = "STOP RECORDING";
        startBtn.classList.remove('btn-primary');
        startBtn.classList.add('btn-danger');
    } else {
        startBtn.textContent = "START RECORDING";
        startBtn.classList.remove('btn-danger');
        startBtn.classList.add('btn-primary');
    }
}

function resetRecording() {
    if (!confirm("録音した声を捨ててやり直す？")) return;
    resultSection.classList.add('hidden');
    recordedMicBuffer = null;
    recordTimeEl.textContent = "00:00";
    statusMsgEl.textContent = "WAITING";
}

// イベント
startBtn.onclick = () => { if (isRecording) stopRecording(); else startRecording(); };
retakeBtn.onclick = resetRecording;
playPreviewBtn.onclick = togglePreview;
exportMp3Btn.onclick = exportMP3;
mixerMicVol.oninput = updatePreviewVolume;
mixerBgmVol.oninput = updatePreviewVolume;
