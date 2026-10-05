/*
 * Webブース予約 設定ファイル
 *
 * ■ この端末のブラウザだけに保存する場合
 *   このままで動きます（apiKey が空なら localStorage に保存）。
 *
 * ■ 全員で予約を共有する場合（Firebase Firestore）
 *   Firebase コンソールの「プロジェクトの設定」→「マイアプリ」に表示される
 *   firebaseConfig の値を下に貼り付けてください。
 */
window.WEBBOOTH_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
