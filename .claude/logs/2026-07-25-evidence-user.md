# ユーザ提供の一次証拠（2026-07-25）

出典: ユーザ報告（実機観察）。Main Agent の解釈は一切含まない逐語転記。

## Q1: 実行形態

**回答: インストール済み VSIX**（`kidori-0.4.0.vsix` 等を VS Code にインストールして通常利用中）

## Q2: Webview Developer Tools の Console

**回答: 「関連しそうなのはこれぐらい？」として以下を提示**

```
VM14:147 Uncaught SyntaxError: Failed to execute 'write' on 'Document': Invalid or unexpected token
    at index.html?id=8322566f-1062-44b6-b9d4-7bd9cace21d1&parentId=2&origin=ecd4c655-281e-45ff-a81e-d8099fccdbf8&swVersion=5&extensionId=tnishimura.kidori&platform=electron&vscode-resource-base-authority=vscode-resource.vscode-cdn.net&parentOrigin=vscode-file%3A%2F%2Fvscode-app:1064:23
(anonymous) @ index.html?...:1064
PendingScript
(anonymous) @ index.html?...:1064
setTimeout
onFrameLoaded @ index.html?...:1062
(anonymous) @ index.html?...:1094
```

補足（逐語ではない事実の抽出のみ）:
- `extensionId=tnishimura.kidori` — インストール済み拡張として動作していることを示す
- `platform=electron`
- スタックは VS Code webview シェルの `index.html` 内 `document.write` 呼び出し
