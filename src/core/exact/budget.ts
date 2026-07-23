/**
 * 厳密探索の探索ノード予算。
 *
 * 分枝限定は最悪指数時間になるため、試行した候補位置の数に上限を設ける。
 * 上限超過時は tick() が BudgetExceededError を投げ、exactPack1d / exactPack2d が
 * これを内部で捕捉して「その時点の incumbent（実行可能解）＋ complete: false」を
 * 返す。Budget インスタンスは stock 横断で共有されるため、枯渇後の後続 stock は
 * DFS を回さず貪欲解を返す（exhausted で問い合わせる）。
 */

import { KidoriError } from "../errors";

export class BudgetExceededError extends KidoriError {
  constructor() {
    super("厳密探索のノード予算を超過しました");
  }
}

export class Budget {
  private nodes = 0;

  constructor(private readonly limit: number) {}

  /** 候補位置の試行を1つ消費する。上限超過で BudgetExceededError を投げる。 */
  tick(): void {
    this.nodes += 1;
    if (this.nodes > this.limit) {
      throw new BudgetExceededError();
    }
  }

  get used(): number {
    return this.nodes;
  }

  /**
   * 予算を使い切ったか（非例外の問い合わせ API）。
   * 一度でも tick() が上限超過に達すると true を返し続ける。
   * 予算枯渇後の後続 stock で DFS をやり直して例外で死ぬのを避けるために使う。
   */
  get exhausted(): boolean {
    return this.nodes > this.limit;
  }
}
