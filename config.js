/*
 * Webブース予約 設定ファイル
 * 別の環境へ移すときは、基本的にこのファイルだけを書き換えます。
 */
window.WEBBOOTH_CONFIG = {
  /*
   * 予約の保存先
   *   "firebase" … Firebase Firestore（速い・リアルタイム反映。どこに置いても共有できる）
   *   "gas"      … Googleスプレッドシート（どこに置いても共有できる。保存に数秒かかる）
   *   "php"      … 同じサーバーの api.php → data/bookings.csv（PHPが動くサーバー）
   *   "local"    … この端末のブラウザだけ（動作確認用）
   *   "auto"     … 設定があるものを firebase → gas → php → local の順に使う
   */
  backend: "php",

  // Firebase コンソール「プロジェクトの設定」→「マイアプリ」の firebaseConfig を貼り付け
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },
  // Firestore のコレクション名（同じプロジェクトで別アプリと分けたいときに変更）
  firebaseCollection: "webbooth",

  // Apps Script を「ウェブアプリ」としてデプロイしたときの URL（…/exec）
  gasUrl: "",

  // api.php の場所（index.html からの相対パス）
  phpUrl: "api.php",

  // gas / php のとき、他の人の予約を読み直す間隔（秒）。firebase は即時反映
  pollSeconds: 10,

  // 教室の一覧（先頭が初期表示）。id は保存データに記録される値
  // map … [マップ]ボタンで開く画像（index.html からの相対パス）。省略するとボタンは出ない
  places: [
    { id: "331", name: "331教室", map: "images/map_3-331.jpg" }
  ]
};
