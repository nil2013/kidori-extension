"""pytest 共通 fixture（本ファイルは Phase 1 Track A の所有物）。

SPECS.md §4a の例 YAML、および物理的に整合する最小プロジェクトの fixture を提供する。
他トラック（pack1d/pack2d/dimension 等）が使う汎用ヘルパも置いてよいが、
本トラックの責務外の詳細な fixture は各テストファイル側に持たせる方針とし、
ここでは最小限（YAML/JSON 書き出しヘルパ・最小プロジェクト dict）に留める。
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

import pytest
from ruamel.yaml import YAML

# ---------------------------------------------------------------------------
# SPECS.md §4a の例 YAML
# ---------------------------------------------------------------------------

#: SPECS.md §4a に掲載されている例 YAML（verbatim、改変なし）。
#:
#: 注意: この例は JSON Schema（形式）検証は通るが、side-0（stock: pine-18,
#: length: 1985）は pine-18 の length（1820）を超えており、かつ rot: false の
#: ため回転による救済もできない。設計正本 §2 層2 項目3（物理的事前チェック）
#: により loader.load_project() は ProjectError を送出する（意図した挙動。
#: test_loader.py で明示的に確認する）。SPECS.md はあくまで「正本データの
#: 記法」を示す例であり、物理的整合性の担保は意味検証層の役割である。
SPECS_EXAMPLE_YAML = """\
# yaml-language-server: $schema=./project.schema.json
meta: { project: 書棚, units: mm, schemaVersion: "0.2" }

settings:
  kerf: 3            # 鋸刃厚（mm）
  edgeTrim: 5        # 木口の捨て代（mm）
  candidates: 3
  selectedPlan: null

stocks:
  - { id: 1x4-6f,  label: "1×4材 6F",        kind: bar,   length: 1820, width: 89,  thickness: 19, price: 382 }
  - { id: pine-18, label: "パイン集成材18mm", kind: sheet, length: 1820, width: 910, thickness: 18, price: 6356 }

parts:
  - id: side-0
    label: 側板0
    qty: 1
    stock: pine-18   # ← stocks の id が補完候補になる（§4b）
    length: 1985
    width: 200
    rot: false
    features:
      - { type: groove, face: front, dir: across, pos: 248, width: 7, depth: 6, end: through }
      - { type: hole,   face: front, x: 100, y: 320, dia: 4, depth: 8 }
"""


@pytest.fixture
def specs_example_yaml() -> str:
    """SPECS.md §4a の例 YAML（文字列そのもの）。"""

    return SPECS_EXAMPLE_YAML


@pytest.fixture
def specs_example_project_file(tmp_path: Path) -> Path:
    """SPECS.md §4a の例 YAML を tmp_path/project.yaml として書き出したパスを返す。"""

    path = tmp_path / "project.yaml"
    path.write_text(SPECS_EXAMPLE_YAML, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 最小の正当プロジェクト（物理的に整合。schema・意味検証いずれも通る）
# ---------------------------------------------------------------------------


def minimal_project_dict() -> dict[str, Any]:
    """物理的に整合する最小の正当プロジェクト（dict 表現）を返す。

    schema 層・意味検証層のいずれも通り、warning もゼロ件になることを
    test_loader.py で確認済み。境界値テスト等ではこれを `copy.deepcopy` して
    フィールドを変更するベースラインとして使う。
    """

    return {
        "meta": {"project": "テスト棚", "units": "mm", "schemaVersion": "0.2"},
        "settings": {
            "kerf": 3,
            "edgeTrim": 5,
            "candidates": 3,
            "selectedPlan": None,
        },
        "stocks": [
            {
                "id": "1x4-6f",
                "label": "1×4材 6F",
                "kind": "bar",
                "length": 1820,
                "width": 89,
                "thickness": 19,
                "price": 382,
            },
            {
                "id": "ply-12",
                "label": "合板12mm",
                "kind": "sheet",
                "length": 1820,
                "width": 910,
                "thickness": 12,
                "price": 3000,
            },
        ],
        "parts": [
            {
                "id": "shelf-0",
                "label": "棚板0",
                "qty": 2,
                "stock": "1x4-6f",
                "length": 600,
            },
            {
                "id": "side-0",
                "label": "側板0",
                "qty": 1,
                "stock": "ply-12",
                "length": 800,
                "width": 300,
                "rot": True,
                "features": [
                    {
                        "type": "groove",
                        "face": "front",
                        "dir": "across",
                        "pos": 248,
                        "width": 7,
                        "depth": 6,
                        "end": "through",
                    },
                    {
                        "type": "hole",
                        "face": "front",
                        "x": 100,
                        "y": 150,
                        "dia": 4,
                        "depth": 8,
                    },
                ],
            },
        ],
    }


@pytest.fixture
def minimal_project() -> dict[str, Any]:
    """`minimal_project_dict()` の deepcopy を返す fixture（自由に変更してよい）。"""

    return copy.deepcopy(minimal_project_dict())


# ---------------------------------------------------------------------------
# 汎用ヘルパ（YAML/JSON 書き出し。他トラックからの利用も想定）
# ---------------------------------------------------------------------------


@pytest.fixture
def yaml_writer(tmp_path: Path) -> Callable[..., Path]:
    """dict を YAML として tmp_path 配下に書き出す関数を返す fixture。

    Usage: `path = yaml_writer(data)` または `yaml_writer(data, filename="x.yaml")`。
    """

    def _write(data: dict, filename: str = "project.yaml") -> Path:
        path = tmp_path / filename
        yaml = YAML(typ="safe")
        with path.open("w", encoding="utf-8") as f:
            yaml.dump(data, f)
        return path

    return _write


@pytest.fixture
def json_writer(tmp_path: Path) -> Callable[..., Path]:
    """dict を JSON として tmp_path 配下に書き出す関数を返す fixture。"""

    def _write(data: dict, filename: str = "project.json") -> Path:
        path = tmp_path / filename
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    return _write
