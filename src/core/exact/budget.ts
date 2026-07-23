/**
 * 厳密探索の探索ノード予算。
 *
 * 分枝限定は最悪指数時間になるため、探索ノード数に上限を設ける。
 * 上限超過時は BudgetExceededError を投げ、呼び出し側（exact/index.ts）が
 * 「打ち切りにより最適性未証明」として扱う。
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

  /** 探索ノードを1つ消費する。上限超過で BudgetExceededError を投げる。 */
  tick(): void {
    this.nodes += 1;
    if (this.nodes > this.limit) {
      throw new BudgetExceededError();
    }
  }

  get used(): number {
    return this.nodes;
  }
}
