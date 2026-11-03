// OneDrive連携で使う「アプリケーション(クライアント)ID」。空のままなら、画面から入力して端末に保存する。
// IDは秘密情報ではない(認証はPKCEで行い、シークレットは使わない)。設定手順: docs/ONEDRIVE.md
export const CLIENT_ID = "";

// 別の窓のエクスプローラーから、ドラッグで図面を受け取る(js/remote-drop.js)。取りに行ってよい接続先(ホスト名)だけを書く。
export const EXPLORER_HOSTS = ["i-sf.tailbc9241.ts.net"];
