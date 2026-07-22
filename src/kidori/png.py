"""cairosvg ラッパ（設計正本 .claude/logs/2026-07-22-design.md §0・§9 準拠）。

cairosvg（および背後の libcairo）はシステムライブラリへの依存があり、
インストールされていない環境では import 自体が失敗しうる。そのため
cairosvg は関数呼び出し時に遅延 import し、失敗時は日本語の警告を出して
PNG 生成をスキップする（build 全体は成功扱いとする。設計正本 §0）。
"""

from __future__ import annotations

import sys
from pathlib import Path

#: cairosvg 利用不可の警告を1度だけ出すためのモジュールレベルフラグ。
#: 同一プロセス内（例: watch モードでの複数回 build）で警告が連続して
#: 大量に出力されるのを防ぐ。
_warned_unavailable = False


def svg_to_png(svg_str: str, out_path: Path, scale: float = 2.0) -> bool:
    """SVG 文字列を PNG に変換し、out_path に書き出す。

    cairosvg が利用できない環境（未インストール、または libcairo が
    見つからない等）では、日本語警告を stderr に1度だけ出力して False を
    返す（例外は送出しない。呼び出し側の build.py はこれを「スキップ」として
    扱い、build 自体は成功扱いにする）。

    Args:
        svg_str: SVG 文書の文字列（render_cutplan/render_partcard の戻り値）。
        out_path: 書き出す PNG のパス（親ディレクトリが無ければ作成する）。
        scale: SVG px から PNG px への倍率（cairosvg.svg2png の scale 引数）。

    Returns:
        変換・書き出しに成功したら True。cairosvg が利用不可でスキップした
        場合は False。
    """

    global _warned_unavailable

    try:
        import cairosvg  # 遅延 import（設計正本 §0: 利用不可なら警告してスキップ）
    except Exception as e:  # ImportError だけでなく libcairo 未検出等も含めて広く捕捉する
        if not _warned_unavailable:
            print(
                "[警告] cairosvg（または libcairo）が利用できないため PNG 生成を"
                f"スキップします（{e}）。SVG のみ出力します。"
                "--no-png を指定すると、この警告と PNG 生成試行自体を省略できます。",
                file=sys.stderr,
            )
            _warned_unavailable = True
        return False

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(bytestring=svg_str.encode("utf-8"), write_to=str(out_path), scale=scale)
    return True
