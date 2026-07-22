"""schema.py のテスト（設計正本 §10 項目8）。

対象: 生成スキーマ自体のメタ検証（Draft 2020-12 として妥当）、SPECS §4 の例
YAML が（スキーマ層としては）pass すること、未知キー・不正 stock 参照
（enum）・負の寸法が fail すること、stocks 空のとき enum が無いこと。

注意: 「SPECS 例 YAML の pass」はスキーマ層（形式検証）のみを指す。
side-0 の物理的な詰め込み可否（意味検証層）は test_loader.py 側で扱う
（conftest.py の SPECS_EXAMPLE_YAML docstring 参照）。
"""

from __future__ import annotations

from jsonschema import Draft202012Validator
from ruamel.yaml import YAML

from kidori.schema import DESCRIPTIONS, build_schema, write_schema


def _load_yaml(text: str) -> dict:
    yaml = YAML(typ="safe")
    return yaml.load(text)


def test_schema_is_valid_draft_2020_12() -> None:
    schema = build_schema(["a", "b"])
    # 不正なスキーマなら Draft202012Validator.check_schema が例外を送出する。
    Draft202012Validator.check_schema(schema)


def test_schema_empty_stock_ids_has_no_enum() -> None:
    schema = build_schema([])
    stock_prop = schema["properties"]["parts"]["items"]["properties"]["stock"]
    assert "enum" not in stock_prop
    assert stock_prop["type"] == "string"


def test_schema_nonempty_stock_ids_injects_enum() -> None:
    schema = build_schema(["1x4-6f", "pine-18"])
    stock_prop = schema["properties"]["parts"]["items"]["properties"]["stock"]
    assert stock_prop["enum"] == ["1x4-6f", "pine-18"]


def test_specs_example_passes_schema_validation(specs_example_yaml: str) -> None:
    raw = _load_yaml(specs_example_yaml)
    stock_ids = [s["id"] for s in raw["stocks"]]
    schema = build_schema(stock_ids)

    errors = list(Draft202012Validator(schema).iter_errors(raw))
    assert errors == []


def test_minimal_project_passes_schema_validation(minimal_project: dict) -> None:
    stock_ids = [s["id"] for s in minimal_project["stocks"]]
    schema = build_schema(stock_ids)

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors == []


def test_unknown_top_level_key_fails(minimal_project: dict) -> None:
    minimal_project["unknownKey"] = "x"
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_unknown_part_key_fails(minimal_project: dict) -> None:
    minimal_project["parts"][0]["extraField"] = 123
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_invalid_stock_reference_fails_enum(minimal_project: dict) -> None:
    minimal_project["parts"][0]["stock"] = "not-a-real-stock"
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_negative_part_length_fails(minimal_project: dict) -> None:
    minimal_project["parts"][0]["length"] = -100
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_negative_stock_length_fails(minimal_project: dict) -> None:
    minimal_project["stocks"][0]["length"] = -1
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_zero_qty_fails(minimal_project: dict) -> None:
    # qty は exclusiveMinimum: 0 のため 0 は不正。
    minimal_project["parts"][0]["qty"] = 0
    schema = build_schema([s["id"] for s in minimal_project["stocks"]])

    errors = list(Draft202012Validator(schema).iter_errors(minimal_project))
    assert errors


def test_groove_and_hole_features_each_validate_against_own_shape() -> None:
    # groove 由来のプロパティで hole を作ると additionalProperties: false + 必須
    # 不足の両方で oneOf のどちらにもマッチしないはず。
    schema = build_schema([])
    bad_feature = {
        "type": "hole",
        "face": "front",
        "dir": "across",  # hole に無いキー（groove 由来）
        "pos": 100,
        "x": 10,
        "y": 10,
        "dia": 4,
    }
    project = {
        "meta": {"project": "p", "units": "mm", "schemaVersion": "0.2"},
        "stocks": [
            {
                "id": "s1",
                "label": "s1",
                "kind": "sheet",
                "length": 1000,
                "width": 1000,
                "thickness": 10,
            }
        ],
        "parts": [
            {
                "id": "p1",
                "label": "p1",
                "qty": 1,
                "stock": "s1",
                "length": 100,
                "width": 100,
                "features": [bad_feature],
            }
        ],
    }
    errors = list(Draft202012Validator(schema).iter_errors(project))
    assert errors


def test_write_schema_creates_file_matching_build_schema(tmp_path) -> None:
    project_path = tmp_path / "project.yaml"
    project_path.write_text("meta: {}\n", encoding="utf-8")

    stock_ids = ["a", "b"]
    schema_path = write_schema(project_path, stock_ids)

    assert schema_path == tmp_path / "project.schema.json"
    assert schema_path.exists()

    import json

    written = json.loads(schema_path.read_text(encoding="utf-8"))
    assert written == build_schema(stock_ids)


def test_descriptions_are_all_non_empty_japanese_strings() -> None:
    assert DESCRIPTIONS
    for key, desc in DESCRIPTIONS.items():
        assert isinstance(desc, str) and desc.strip(), key
        # 全角文字（日本語）を1文字以上含むことを軽く確認する。
        assert any(ord(ch) > 0x3000 for ch in desc), (key, desc)
