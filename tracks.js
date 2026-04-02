/**
 * ==========================================================
 * えっちなシャトルラン：音源リスト設定ファイル
 * ==========================================================
 * 
 * 【音源の追加方法】
 * 以下の `presetTracks` の中に、{ } で囲まれたブロックをコピー＆ペーストして増やしてください。
 * 
 * 項目説明:
 * id          : 他と被らない適当な名前（半角英数字）
 * title       : 画面に大きく表示されるタイトル
 * url         : 音声ファイルのパス（assets/xxxx.mp3 など）
 * description : タイトルの下に表示される短い説明文
 */

const presetTracks = [
    {
        id: "play-mode-01",
        title: "基本のシャトルランプレイ",
        url: "assets/shuttle_run_20m.mp3",
        description: "お題に従って遊んでね♡ 基本の20mコースです。"
    },
    {
        id: "play-mode-02",
        title: "指示待ちおねだり録音",
        url: "assets/instruction_play.mp3",
        description: "ゆっくりとお題を聞きながら声を録ってね。"
    },
    {
        id: "play-mode-03",
        title: "激しく挑戦！限界シャトルラン",
        url: "assets/hard_limit.mp3",
        description: "テンポが次第に速くなります…ついてこれるかな？"
    },
    
    /* 
    【テンプレート：ここをコピーして追加できます】
    {
        id: "new-track-01",
        title: "ここにタイトルを書く",
        url: "assets/your-file.mp3",
        description: "ここに説明文を書く♡"
    },
    */
];

// 他のスクリプトから参照できるようにグローバルに公開
window.presetTracks = presetTracks;
