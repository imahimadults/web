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
let bgmMediaSource = null;    // MediaElementSourceの重複生成防止用

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

// リアルタイム制御用
let micGainNode = null;
let bgmGainNode = null;
let testMicSource = null;
let testBgmSource = null;

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

// 設定UI
const micVolSlider = document.getElementById('mic-volume');
const bgmVolSlider = document.getElementById('bgm-volume');
const micVolValEl = document.getElementById('mic-vol-val');
const bgmVolValEl = document.getElementById('bgm-vol-val');
const monitorMicCheckbox = document.getElementById('monitor-mic');

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

// --- 3. 初期化（アプリが読み込まれたときの準備） ---
window.onload = () => {
    // 互換性チェック
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("お使いのブラウザはマイク録音に対応していないか、HTTPS接続ではありません。別のブラウザ（Safari, Chromeなど）を試してみてね。");
    }
    if (typeof MediaRecorder === 'undefined') {
        console.warn("MediaRecorder is not supported in this browser.");
    }

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

// --- 4. 音声エンジン（ブラウザの音を扱うコア部分） ---
/**
 * AudioContext（音のキャンバスのようなもの）を初期化します。
 * ブラウザのセキュリティ制限により、ユーザーがボタンを押した直後に実行する必要があります。
 */
async function initAudioContext() {
    try {
        if (!audioCtx) {
            // iOS Safariや古いブラウザ向けの互換性対応
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        // 音声エンジンが止まっている（suspended）場合は再開させます
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
    } catch (e) {
        console.error("AudioContext init error:", e);
        throw new Error("音声エンジンの起動に失敗しました。ブラウザの設定を確認してください。");
    }
}

/**
 * 録音に使用するマイクの許可を取り、音声ストリームを取得します。
 * iOSなどのモバイル端末でも動作しやすいよう、シンプルな設定にしています。
 */
async function getMicStream() {
    const constraints = {
        audio: {
            echoCancellation: false, // エコー除去をオフ（本来の声を録るため）
            noiseSuppression: false, // ノイズ抑制をオフ
            autoGainControl: false   // 自動音量調整をオフ
        }
    };
    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        console.error("getUserMedia error:", e);
        throw new Error("マイクの使用が許可されていないか、他のアプリで使われている可能性があります。");
    }
}

/**
 * 録音に使用する最適なファイル形式をブラウザに合わせて選びます。
 * iOS Safariでは 'audio/mp4' が、他では 'audio/webm' が適しています。
 */
function getSupportedMimeType() {
    const types = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/aac',
        'audio/ogg;codecs=opus'
    ];
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            console.log("Selected MIME type:", type);
            return type;
        }
    }
    return ''; // ブラウザのデフォルトを使用
}

// --- 5. ボリューム制御（音量スライダーの反映） ---
function updateRealtimeVolume() {
    const micVal = parseFloat(micVolSlider.value);
    const bgmVal = parseFloat(bgmVolSlider.value);
    
    // スライダーの値を徐々に反映させて、プツプツ音（クリックノイズ）を防ぎます
    if (micGainNode) micGainNode.gain.setTargetAtTime(micVal, audioCtx.currentTime, 0.01);
    if (bgmGainNode) bgmGainNode.gain.setTargetAtTime(bgmVal, audioCtx.currentTime, 0.01);
    
    micVolValEl.textContent = Math.round(micVal * 100) + "%";
    bgmVolValEl.textContent = Math.round(bgmVal * 100) + "%";
}

function syncMicMonitoring() {
    if (!micGainNode || !audioCtx) return;
    
    // 自分の声をスピーカーから出す設定
    if (monitorMicCheckbox.checked && (isRecording || isTestMode)) {
        try { micGainNode.connect(audioCtx.destination); } catch(e) {}
    } else {
        try { micGainNode.disconnect(audioCtx.destination); } catch(e) {}
    }
}

// --- 6. 録音処理 ---
/**
 * 録音を開始します。
 * iOS対策として、AudioContextのレジューム、マイク取得、BGM再生をひとつのボタン操作内で行います。
 */
async function startRecording() {
    if (!trackElement.src) return alert("音源を選んでね♡");

    try {
        // 1. エンジンの準備
        await initAudioContext();
        
        // 2. マイクの準備
        micStream = await getMicStream();

        // 3. 録音ノードの組み立て
        micSource = audioCtx.createMediaStreamSource(micStream);
        micGainNode = audioCtx.createGain();
        const analyser = audioCtx.createAnalyser();
        
        micSource.connect(micGainNode);
        micGainNode.connect(analyser);
        updateMeter(analyser); // メーター表示開始
        
        syncMicMonitoring();

        // 4. BGM（選んだ音楽）の設定
        // MediaElementSource は一度だけ作る必要があります
        if (!bgmMediaSource) {
            bgmMediaSource = audioCtx.createMediaElementSource(trackElement);
        }
        bgmGainNode = audioCtx.createGain();
        bgmMediaSource.connect(bgmGainNode).connect(audioCtx.destination);
        
        updateRealtimeVolume();

        // 5. 録音機（MediaRecorder）の設定
        const options = { mimeType: getSupportedMimeType() };
        recorder = new MediaRecorder(micStream, options);
        recordedChunks = [];
        
        // デー夕が届くたびに保存
        recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        // 停止したときの処理を予約
        recorder.onstop = processRecordedAudio;

        // 6. 録音と再生を同時に開始！
        recorder.start();
        trackElement.currentTime = 0;
        
        // iOSでは play() がPromiseを返すので、念のため完了を待ちます
        await trackElement.play();

        isRecording = true;
        document.body.classList.add('recording');
        updateUIState(true);
        startTimer();
        statusMsgEl.textContent = "RECORDING...";

        // スマホが途中でスリープしないようにする設定
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e){}
        }

    } catch (err) {
        console.error("Start recording error:", err);
        alert("失敗しちゃったみたい: " + err.message);
    }
}

/**
 * テストモードのオンオフを切り替えます。
 */
async function toggleTestMode() {
    if (isRecording) return;

    if (isTestMode) {
        stopTestMode();
    } else {
        await startTestMode();
    }
}

/**
 * テストモードを開始します。
 * 本番の録音はせずに、マイクの音量やBGMとのバランスを確認できます。
 */
async function startTestMode() {
    if (!trackElement.src) return alert("音源を選んでね♡");
    
    try {
        // 1. エンジンの準備
        await initAudioContext();
        
        // 2. マイクの準備
        micStream = await getMicStream();

        // 3. テスト用の接続作り
        // マイク -> 音量調整(micGainNode) -> 出力(destination)
        testMicSource = audioCtx.createMediaStreamSource(micStream);
        micGainNode = audioCtx.createGain();
        const analyser = audioCtx.createAnalyser();
        
        testMicSource.connect(micGainNode);
        micGainNode.connect(analyser);
        updateMeter(analyser); // メーターを動かす
        
        syncMicMonitoring();

        // 4. BGM（音楽）の接続
        trackElement.currentTime = 0;
        if (!bgmMediaSource) {
            bgmMediaSource = audioCtx.createMediaElementSource(trackElement);
        }
        bgmGainNode = audioCtx.createGain();
        bgmMediaSource.connect(bgmGainNode).connect(audioCtx.destination);
        
        updateRealtimeVolume();
        
        // 5. 再生開始
        await trackElement.play();

        isTestMode = true;
        testBtn.textContent = "STOP TEST";
        testBtn.classList.add('btn-danger');
        statusMsgEl.textContent = "TESTING...";
        
    } catch (err) {
        console.error("Start test mode error:", err);
        alert("テスト開始に失敗したよ: " + err.message);
    }
}

/**
 * テストモードを停止します。
 */
function stopTestMode() {
    if (testMicSource) { testMicSource.disconnect(); testMicSource = null; }
    if (micGainNode) { try { micGainNode.disconnect(audioCtx.destination); } catch(e) {} }
    trackElement.pause();
    isTestMode = false;
    testBtn.textContent = "TEST";
    testBtn.classList.remove('btn-danger');
    statusMsgEl.textContent = "WAITING";
}

async function stopRecording() {
    if (isRecording) {
        recorder.stop();
        if (micGainNode) { try { micGainNode.disconnect(audioCtx.destination); } catch(e) {} }
    }
    trackElement.pause();
    isRecording = false;
    document.body.classList.remove('recording');
    updateUIState(false);
    stopTimer();
    statusMsgEl.textContent = "録音完了！ミキサーを準備中...";
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

/**
 * 録音が終わったあとに、録音データを編集可能な形式（AudioBuffer）に変換します。
 */
async function processRecordedAudio() {
    statusMsgEl.textContent = "音声を解析中...";
    try {
        // 録音されたデータの断片をひとつにまとめます
        const blob = new Blob(recordedChunks);
        const arrayBuffer = await blob.arrayBuffer();
        
        // iOS対策：デコード（解析）の前に音声エンジンが動いていることを確認します
        await initAudioContext();
        
        // 音声データとして読み込みます
        recordedMicBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        // ミキサー画面を表示します
        resultSection.classList.remove('hidden');
        statusMsgEl.textContent = "READY TO MIX";
        
        // ミキサーが見えるように自動でスクロールします
        resultSection.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        console.error("Process audio error:", e);
        alert("録音データの解析に失敗しました。もう一度試してみてください。");
        statusMsgEl.textContent = "ERROR";
    }
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

/**
 * ミキサーでのプレビュー再生を開始します。
 */
async function startPreview() {
    if (!recordedMicBuffer) return;
    
    try {
        // エンジンの準備
        await initAudioContext();
        
        // BGMの音源を再取得して、マイクの声とタイミングを合わせます
        statusMsgEl.textContent = "素材を準備中...";
        const bgmResponse = await fetch(trackElement.src);
        const bgmArrayBuffer = await bgmResponse.arrayBuffer();
        const bgmBuffer = await audioCtx.decodeAudioData(bgmArrayBuffer);

        // 再生用のソース（音を出すノード）を作成
        previewMicSource = audioCtx.createBufferSource();
        previewMicSource.buffer = recordedMicBuffer;
        previewBgmSource = audioCtx.createBufferSource();
        previewBgmSource.buffer = bgmBuffer;

        // 音量調整用のノードを作成
        previewGainMic = audioCtx.createGain();
        previewGainBgm = audioCtx.createGain();
        
        updatePreviewVolume();

        // 接続：音源 -> 音量調整 -> 出力
        previewMicSource.connect(previewGainMic).connect(audioCtx.destination);
        previewBgmSource.connect(previewGainBgm).connect(audioCtx.destination);

        // 同時に再生開始
        const now = audioCtx.currentTime;
        previewMicSource.start(now);
        previewBgmSource.start(now);

        isPreviewPlaying = true;
        playPreviewBtn.textContent = "■ プレビュー停止";
        statusMsgEl.textContent = "PREVIEWING...";
        
        // 再生が終わったらボタンを戻す
        previewMicSource.onended = () => {
            if (isPreviewPlaying) stopPreview();
        };
    } catch (e) {
        console.error("Preview error:", e);
        alert("プレビューの再生に失敗しました。");
    }
}

/**
 * ミキサーでのプレビュー再生を停止します。
 */
function stopPreview() {
    if (previewMicSource) { try { previewMicSource.stop(); } catch(e){} previewMicSource = null; }
    if (previewBgmSource) { try { previewBgmSource.stop(); } catch(e){} previewBgmSource = null; }
    isPreviewPlaying = false;
    playPreviewBtn.textContent = "▶ プレビュー再生";
    statusMsgEl.textContent = "READY TO MIX";
}

// --- 7. MP3 書き出し (Export) ---
/**
 * 録音した声とBGMをミックスしてMP3ファイルを作成します。
 */
async function exportMP3() {
    if (!recordedMicBuffer) return;
    stopPreview();

    try {
        exportProgressContainer.classList.remove('hidden');
        exportMp3Btn.disabled = true;
        statusMsgEl.textContent = "書き出し準備中...";

        // BGMの読み込み
        const bgmResponse = await fetch(trackElement.src);
        const bgmArrayBuffer = await bgmResponse.arrayBuffer();
        await initAudioContext();
        const bgmBuffer = await audioCtx.decodeAudioData(bgmArrayBuffer);

        // オフラインレンダリング（耳には聞こえない超高速なミックス作業）
        const duration = Math.max(recordedMicBuffer.duration, bgmBuffer.duration);
        const sampleRate = audioCtx.sampleRate;
        // 2チャンネル（ステレオ）のキャンバスを用意
        const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * duration), sampleRate);

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

        statusMsgEl.textContent = "ミキシング中...";
        const renderedBuffer = await offlineCtx.startRendering();
        
        // MP3 エンコード（実際にファイル形式を変換する）
        statusMsgEl.textContent = "MP3に変換中...";
        encodeToMp3(renderedBuffer);
    } catch (e) {
        console.error("Export error:", e);
        alert("書き出しに失敗しました: " + e.message);
        exportProgressContainer.classList.add('hidden');
        exportMp3Btn.disabled = false;
    }
}

/**
 * ミックスされた音声データをMP3形式に変換し、ダウンロードさせます。
 */
function encodeToMp3(audioBuffer) {
    const channels = 2;
    const sampleRate = audioBuffer.sampleRate;
    // lamejs というライブラリを使ってMP3を作ります
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128); 
    const mp3Data = [];

    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    
    // パソコンやスマホで扱える形式（Int16）に音を変換します
    const leftInt = new Int16Array(left.length);
    const rightInt = new Int16Array(right.length);
    for (let i = 0; i < left.length; i++) {
        // 音割れを防ぐ処理
        const sL = Math.max(-1, Math.min(1, left[i]));
        const sR = Math.max(-1, Math.min(1, right[i]));
        leftInt[i] = sL < 0 ? sL * 32768 : sL * 32767;
        rightInt[i] = sR < 0 ? sR * 32768 : sR * 32767;
    }

    const sampleBlockSize = 1152;
    for (let i = 0; i < leftInt.length; i += sampleBlockSize) {
        const leftChunk = leftInt.subarray(i, i + sampleBlockSize);
        const rightChunk = rightInt.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
        
        // 画面に進捗（％）を出します
        const progress = Math.round((i / leftInt.length) * 100);
        exportProgressBar.style.width = progress + "%";
        exportPercentEl.textContent = progress + "%";
    }

    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) mp3Data.push(mp3buf);

    // 完成したデータを「ファイル」としてブラウザに認識させます
    const blob = new Blob(mp3Data, { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    
    // 自動でダウンロードを開始します
    const a = document.createElement('a');
    a.href = url;
    a.download = `shuttle_run_mix_${Date.now()}.mp3`;
    document.body.appendChild(a); // 一時的に追加
    a.click();
    document.body.removeChild(a);

    exportProgressContainer.classList.add('hidden');
    exportMp3Btn.disabled = false;
    statusMsgEl.textContent = "DONE!";
    alert("MP3の書き出しが完了しました！♡\nファイルを探してみてね。");
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
startBtn.onclick = () => {
    if (isTestMode) stopTestMode();
    if (isRecording) stopRecording(); 
    else startRecording(); 
};
testBtn.onclick = toggleTestMode;
retakeBtn.onclick = resetRecording;
playPreviewBtn.onclick = togglePreview;
exportMp3Btn.onclick = exportMP3;
mixerMicVol.oninput = updatePreviewVolume;
mixerBgmVol.oninput = updatePreviewVolume;

// リアルタイム設定反映
micVolSlider.oninput = updateRealtimeVolume;
bgmVolSlider.oninput = updateRealtimeVolume;
monitorMicCheckbox.onchange = syncMicMonitoring;
