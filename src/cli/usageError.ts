/**
 * CLI 引数エラー用の例外クラス。
 *
 * `src/cli/main.ts` から分離しているのは、`src/cli/agentCommands.ts`
 * （`kidori check`/`kidori schema` の実装。SPECS.md §3b）からも参照するため。
 * `main.ts` はトップレベルで `main()` を実行する CLI エントリポイントであり、
 * テストから直接 import すると副作用（実際の argv 解析・プロセス終了コード設定）が
 * 走ってしまう。ロジックを import 可能な小モジュールに分けることで、
 * main.ts を import せずに単体テストできるようにしている。
 */
export class UsageError extends Error {}
