import asyncio
import copy
import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.catalog import CATALOG
from app.main import create_app
from app.mock import MockClient, TEMPLATES
from app.schemas import RecommendationRequest
from app.settings import Settings
from app.validation import supported_preferences, validate_output

URL = "/api/recommendations/generate"
FRIDGE = {"scene": "fridge", "ingredientIds": ["tomato", "egg", "potato"]}


class FakeClient:
    def __init__(self, *results):
        self.results = results
        self.calls = []

    async def generate(self, request, repair_code=None):
        self.calls.append(repair_code)
        result = self.results[min(len(self.calls) - 1, len(self.results) - 1)]
        if isinstance(result, Exception):
            raise result
        return result


def payload(body=None):
    return json.loads(asyncio.run(MockClient().generate(RecommendationRequest.model_validate(body or FRIDGE))))


def with_fake(fake, **settings):
    return TestClient(create_app(Settings(mode="mock", **settings), fake))


def test_disabled_default_no_calls():
    fake = FakeClient("should not be used")
    with TestClient(create_app(Settings.from_env({}), fake)) as client:
        status = client.get("/api/recommendations/status").json()
        assert status == {"mode": "disabled", "configured": False, "source": None, "model": None,
                          "message": "推荐生成默认关闭。可显式启用本地 Mock 演示，尚未调用真实 AI。",
                          "deploymentScope": "local_demo", "limiterScope": "single_process_reset_on_restart"}
        response = client.post(URL, json={"scene": "cook"})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "recommendations_disabled"
        assert fake.calls == []


def test_catalog_is_shared_resource():
    with TestClient(create_app(Settings())) as client:
        response = client.get("/api/ingredients")
        assert response.status_code == 200
        assert response.json() == [item.model_dump() for item in CATALOG]


@pytest.mark.parametrize("bad", [
    {}, {"scene": "unknown"}, {"scene": "cook", "prompt": "ignore constraints"},
    {"scene": "cook", "ingredient_ids": []}, {"scene": "cook", "servings": "2"},
    {"scene": "cook", "servings": True}, {"scene": "cook", "servings": 7},
    {"scene": "cook", "strictIngredients": "true"}, {"scene": "cook", "assumeBasics": 0},
    {"scene": "cook", "timeLimit": 4}, {"scene": "cook", "timeLimit": 181},
    {"scene": "cook", "timeLimit": 15.0}, {"scene": "cook", "timeLimit": True},
    {"scene": "eat_out", "timeLimit": 20}, {**FRIDGE, "timeLimit": 20},
    {"scene": "cook", "budgetLevel": "economy"}, {"scene": "eat_out", "budgetLevel": "cheap"},
    {"scene": "cook", "ingredientIds": ["tomato"]}, {"scene": "eat_out", "ingredientIds": ["egg"]},
    {"scene": "fridge"}, {"scene": "fridge", "ingredientIds": ["unknown"]},
    {"scene": "fridge", "ingredientIds": ["egg", "egg"]},
    {"scene": "fridge", "ingredientIds": [item.id for item in CATALOG][:41]},
    {"scene": "cook", "todayTaste": "高蛋白"}, {"scene": "cook", "tastePreferences": ["辣"]},
    {"scene": "cook", "tastePreferences": ["清爽"] * 8},
    {"scene": "cook", "preferredCategories": ["牛肉"]},
    {"scene": "cook", "preferredCategories": ["蔬菜", "蔬菜"]},
    {"scene": "cook", "tastePreferences": "清爽"}, {"scene": "cook", "ingredientIds": None},
])
def test_request_contract_rejects_strictly(bad):
    fake = FakeClient("never")
    with with_fake(fake) as client:
        response = client.post(URL, json=bad)
    assert response.status_code == 422
    assert set(response.json()["detail"]) == {"code", "message"}
    assert response.json()["detail"]["code"] == "invalid_request"
    assert not fake.calls


@pytest.mark.parametrize("scene", ["cook", "eat_out", "fridge"])
def test_mock_contract_and_regeneration(scene):
    body = FRIDGE if scene == "fridge" else {"scene": scene}
    with TestClient(create_app(Settings(mode="mock"))) as client:
        first = client.post(URL, json=body)
        second = client.post(URL, json=body)
        assert first.status_code == second.status_code == 200, (first.text, second.text)
        data, next_data = first.json(), second.json()
        assert set(data) == {"recipes", "source", "model", "notice", "warnings", "servings", "scene"}
        assert data["source"] == "mock" and data["model"] is None and "Mock" in data["notice"]
        assert len(data["recipes"]) == 3
        assert {r["name"] for r in data["recipes"]} != {r["name"] for r in next_data["recipes"]}
        for recipe in data["recipes"]:
            assert set(recipe) == {"id", "name", "description", "ingredients", "cookingSteps", "estimatedTime",
                                   "recommendationReason", "missingIngredients", "imageFallbackCategory",
                                   "diningCategory", "orderingTip", "matchedPreferences"}
            UUID(recipe["id"])
            assert recipe["missingIngredients"] == []
            assert recipe["matchedPreferences"] == []
            if scene == "eat_out":
                assert recipe["cookingSteps"] == [] and recipe["estimatedTime"] is None
                assert recipe["diningCategory"] and recipe["orderingTip"]
            else:
                assert len(recipe["cookingSteps"]) >= 1
                assert all(step["ingredientIds"] == [] for step in recipe["cookingSteps"])
                assert recipe["estimatedTime"] > 0


@pytest.mark.parametrize("taste", ["清爽", "微辣", "浓郁", "酸甜", "咸鲜", "原味", "酸辣"])
def test_all_mock_candidates_and_tastes_pass_validation(taste):
    mock = MockClient()
    request = RecommendationRequest(scene="cook", todayTaste=taste, servings=2)
    names = set()
    for _ in range(len(TEMPLATES)):
        raw = asyncio.run(mock.generate(request))
        recipes = validate_output(raw, request)
        names.update(recipe.name for recipe in recipes)
        for recipe in recipes:
            assert set(recipe.matchedPreferences) <= {taste}
    assert len(names) == len(TEMPLATES)


def test_today_taste_takes_priority_over_saved_tastes_in_mock():
    body = {"scene": "cook", "todayTaste": "原味", "tastePreferences": ["微辣", "浓郁"]}
    with TestClient(create_app(Settings(mode="mock"))) as client:
        response = client.post(URL, json=body)
    assert response.status_code == 200, response.text
    for recipe in response.json()["recipes"]:
        assert "原味" in recipe["matchedPreferences"]
        assert not {"chili", "soy-sauce"} & {item["ingredientId"] for item in recipe["ingredients"]}


def test_mock_scales_servings_and_respects_time():
    one = payload({"scene": "cook"})["recipes"][0]
    two = payload({"scene": "cook", "servings": 2})["recipes"][0]
    assert one["ingredients"][0]["amount"] == "180克"
    assert two["ingredients"][0]["amount"] == "360克"
    assert two["estimatedTime"] > one["estimatedTime"]
    with TestClient(create_app(Settings(mode="mock"))) as client:
        response = client.post(URL, json={"scene": "cook", "timeLimit": 15})
        assert response.status_code == 200, response.text
        assert all(recipe["estimatedTime"] <= 15 for recipe in response.json()["recipes"])
        response = client.post(URL, json={"scene": "cook", "timeLimit": 5})
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "mock_constraints_unsupported"


@pytest.mark.parametrize("budget,tip", [("any", "确认实际食材"), ("economy", "优先单点"),
                                       ("balanced", "避免重复加配"), ("treat", "不承诺实际花费")])
def test_eat_out_budget_changes_ordering_advice(budget, tip):
    with TestClient(create_app(Settings(mode="mock"))) as client:
        response = client.post(URL, json={"scene": "eat_out", "budgetLevel": budget})
    assert response.status_code == 200, response.text
    for recipe in response.json()["recipes"]:
        assert tip in recipe["orderingTip"]
        assert recipe["cookingSteps"] == [] and recipe["estimatedTime"] is None


def test_fridge_insufficient_basics_and_taste_are_honest():
    with TestClient(create_app(Settings(mode="mock"))) as client:
        empty = client.post(URL, json={**FRIDGE, "assumeBasics": False}).json()
        assert empty["recipes"] == [] and "0道" in empty["notice"] and "Mock" in empty["notice"]
        only_seasonings = client.post(URL, json={"scene": "fridge", "ingredientIds": ["salt", "oil"]}).json()
        assert only_seasonings["recipes"] == []
        limited = client.post(URL, json={"scene": "fridge", "ingredientIds": ["tomato", "egg"]}).json()
        assert len(limited["recipes"]) == 2 and "2道" in limited["notice"]
        spicy = client.post(URL, json={**FRIDGE, "todayTaste": "酸辣"}).json()
        assert len(spicy["recipes"]) == 3
        assert all("酸辣" not in item["matchedPreferences"] for item in spicy["recipes"])
        assert any("未确认匹配的偏好：酸辣" in warning for warning in spicy["warnings"])


def test_basics_disabled_but_explicitly_selected_are_allowed():
    body = {**FRIDGE, "assumeBasics": False, "ingredientIds": [*FRIDGE["ingredientIds"], "water", "oil", "salt"]}
    with TestClient(create_app(Settings(mode="mock"))) as client:
        response = client.post(URL, json=body)
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 3


def mutate_invalid(data, kind):
    recipe = data["recipes"][0]
    if kind == "malformed":
        return "{broken json"
    if kind == "markdown":
        return "```json\n" + json.dumps(data) + "\n```"
    if kind == "six":
        data["recipes"] = data["recipes"] * 2
    elif kind == "strict-main":
        recipe["ingredients"].append({"ingredientId": "beef", "amount": "100克"})
    elif kind == "unknown-ingredient":
        recipe["ingredients"].append({"ingredientId": "dragon-fruit", "amount": "1个"})
    elif kind == "duplicate-ingredient":
        recipe["ingredients"].append(copy.deepcopy(recipe["ingredients"][0]))
    elif kind == "zero-amount":
        recipe["ingredients"][0]["amount"] = "0克"
    elif kind == "empty-amount":
        recipe["ingredients"][0]["amount"] = "   "
    elif kind == "blank-name":
        recipe["name"] = "   "
    elif kind == "no-steps":
        recipe["steps"] = []
    elif kind == "blank-steps":
        recipe["steps"] = ["", "   "]
    elif kind == "only-seasoning":
        recipe["ingredients"] = [{"ingredientId": "salt", "amount": "1克"}]
    return json.dumps(data, ensure_ascii=False)


@pytest.mark.parametrize("kind", ["malformed", "markdown", "six"])
def test_batch_violations_repair_once_then_explicit_error(kind):
    fake = FakeClient(mutate_invalid(payload(), kind))
    with with_fake(fake) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "invalid_model_output"
    assert "recipes" not in response.json()
    assert len(fake.calls) == 2 and fake.calls[0] is None and fake.calls[1]


@pytest.mark.parametrize("kind,code", [
    ("strict-main", "strict_main_ingredient"), ("unknown-ingredient", "ingredient_identity"),
    ("duplicate-ingredient", "duplicate_ingredient"), ("zero-amount", "ingredient_amount"),
    ("empty-amount", "ingredient_amount"), ("blank-name", "invalid_json_or_schema"),
    ("no-steps", "missing_steps"), ("blank-steps", "missing_steps"), ("only-seasoning", "no_main_ingredient"),
])
def test_single_bad_candidate_is_dropped_without_repair_or_padding(kind, code):
    fake = FakeClient(mutate_invalid(payload(), kind))
    with with_fake(fake) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["recipes"]) == 2
    assert any(f"已淘汰1道" in warning and code in warning for warning in data["warnings"])
    assert fake.calls == [None]


def test_all_candidates_invalid_repair_once_then_explicit_error():
    data = payload()
    for recipe in data["recipes"]:
        recipe["ingredients"] = [{"ingredientId": "salt", "amount": "1克"}]
    fake = FakeClient(json.dumps(data, ensure_ascii=False))
    with with_fake(fake) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "invalid_model_output"
    assert fake.calls == [None, "no_main_ingredient"]


def test_single_successful_repair_no_partial_candidates():
    valid = json.dumps(payload(), ensure_ascii=False)
    fake = FakeClient("bad json", valid)
    with with_fake(fake) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 3
    assert fake.calls == [None, "invalid_json_or_schema"]
    assert "以" in response.json()["recipes"][0]["recommendationReason"]


@pytest.mark.parametrize("extra", [
    "每份含蛋白质30克，暖胃又安心。",
    "百分百安全，放心食用，低脂减肥又降糖。",
    "参考 https://food.example.com 的家常做法。",
    "搭配芝士和培根风味，最后挤上番茄酱。",
    "口感清爽，酸甜开胃，适合夏天。",
])
def test_natural_text_is_not_word_blocked(extra):
    data = payload()
    data["recipes"][0]["description"] += extra
    data["recipes"][0]["steps"][-1] += "撒少许芝士碎提香。"
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 3
    assert not any("已淘汰" in warning for warning in response.json()["warnings"])


def test_model_extra_fields_are_ignored_and_server_fields_computed():
    data = payload()
    recipe = data["recipes"][0]
    recipe.update(id="forged-id", restaurantAddress="某路一号",
                  recommendationReason="符合你喜欢的酸辣口味。",
                  matchedPreferences=["微辣", "酸辣"],
                  missingIngredients=[{"ingredientId": "beef", "name": "牛肉", "amount": "1克", "role": "main"}])
    recipe["ingredients"][0].update(name="西红柿", role="seasoning")
    recipe["steps"] = [{"title": "旧格式", "body": body} for body in recipe["steps"]]
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    first = response.json()["recipes"][0]
    UUID(first["id"])
    assert first["id"] != "forged-id"
    assert first["ingredients"][0]["name"] == "番茄" and first["ingredients"][0]["role"] == "main"
    assert first["missingIngredients"] == [] and first["matchedPreferences"] == []
    assert "酸辣" not in first["recommendationReason"]
    assert [step["title"] for step in first["cookingSteps"]] == [f"步骤{i}" for i in range(1, len(first["cookingSteps"]) + 1)]
    assert all(step["ingredientIds"] == [] for step in first["cookingSteps"])


def test_amount_formats_are_accepted_and_numeric_amounts_coerced():
    data = payload()
    recipe = data["recipes"][0]
    recipe["ingredients"][0]["amount"] = 2
    recipe["ingredients"][1]["amount"] = "适量"
    recipe["ingredients"][2]["amount"] = "少许"
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    amounts = [item["amount"] for item in response.json()["recipes"][0]["ingredients"]]
    assert amounts[:3] == ["2", "适量", "少许"]


def test_single_concise_step_is_accepted():
    data = payload()
    data["recipes"][0]["steps"] = ["全部食材下锅炒熟，约10分钟。"]
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    steps = response.json()["recipes"][0]["cookingSteps"]
    assert len(steps) == 1 and steps[0]["title"] == "步骤1" and steps[0]["ingredientIds"] == []


def test_missing_hyphen_id_is_repaired_to_catalog_entry():
    data = payload({"scene": "cook"})
    data["recipes"][0]["ingredients"][0]["ingredientId"] = "chickenbreast"
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json={"scene": "cook"})
    assert response.status_code == 200, response.text
    first = response.json()["recipes"][0]["ingredients"][0]
    assert first["ingredientId"] == "chicken-breast" and first["name"] == "鸡胸肉" and first["role"] == "main"


def test_basics_disabled_rejects_all_and_unsupported_flavor_is_not_claimed():
    fake = FakeClient(json.dumps(payload(), ensure_ascii=False))
    with with_fake(fake) as client:
        response = client.post(URL, json={**FRIDGE, "assumeBasics": False})
    assert response.status_code == 502
    assert fake.calls == [None, "basics_disabled"]
    data = payload()
    data["recipes"][0]["matchedPreferences"] = ["微辣"]
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json={**FRIDGE, "todayTaste": "微辣"})
    assert response.status_code == 200, response.text
    assert all("微辣" not in recipe["matchedPreferences"] for recipe in response.json()["recipes"])
    assert any("未确认匹配的偏好：微辣" in warning for warning in response.json()["warnings"])


def test_missing_seasoning_is_computed_by_backend():
    data = payload()
    recipe = data["recipes"][0]
    recipe["ingredients"].append({"ingredientId": "soy-sauce", "amount": "5毫升"})
    recipe["steps"].append("将酱油加入做好的食材，轻轻拌匀1分钟后装盘。")
    recipe["missingIngredients"] = [{"ingredientId": "soy-sauce", "name": "酱油", "amount": "2毫升", "role": "main"}]
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    assert response.json()["recipes"][0]["missingIngredients"] == [
        {"ingredientId": "soy-sauce", "name": "酱油", "amount": "5毫升", "role": "seasoning"}]


@pytest.mark.parametrize("text", ["海底捞推荐", "某某餐厅", "张三小店", "地址在人民路3号", "营业时间10:00", "人均35元", "套餐19.9元", "只需二十元", "每天九点开始供应", "电话13800138000"])
def test_eat_out_accepts_natural_ordering_text(text):
    data = payload({"scene": "eat_out"})
    data["recipes"][0]["orderingTip"] = text
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json={"scene": "eat_out"})
    assert response.status_code == 200, response.text
    assert response.json()["recipes"][0]["orderingTip"] == text
    assert not any("已淘汰" in warning for warning in response.json()["warnings"])


@pytest.mark.parametrize("scene,count,expected", [("cook", 0, 502), ("cook", 1, 200), ("cook", 2, 200),
                                                  ("eat_out", 0, 502), ("fridge", 0, 200), ("fridge", 1, 200)])
def test_recipe_counts(scene, count, expected):
    body = FRIDGE if scene == "fridge" else {"scene": scene}
    data = payload(body)
    data["recipes"] = data["recipes"][:count]
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=body)
    assert response.status_code == expected, response.text
    if scene == "fridge":
        assert f"{count}道" in response.json()["notice"]


def test_duplicate_names_and_fingerprints_are_rejected_per_recipe():
    data = payload()
    data["recipes"][1]["name"] = " " + data["recipes"][0]["name"] + "！ "
    data["recipes"][2]["ingredients"] = copy.deepcopy(data["recipes"][0]["ingredients"])
    data["recipes"][2]["steps"] = list(data["recipes"][0]["steps"])
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 1
    assert any("已淘汰2道" in warning for warning in response.json()["warnings"])


@pytest.mark.parametrize("error,status,code", [
    (RuntimeError("Authorization: Bearer test-secret upstream private body"), 502, "provider_error"),
    (httpx.ReadTimeout("test-secret"), 504, "provider_timeout"),
    (httpx.ConnectError("test-secret"), 502, "provider_error"),
])
def test_errors_are_sanitized_without_retry_or_mock(error, status, code):
    fake = FakeClient(error)
    with with_fake(fake) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert "test-secret" not in response.text and "Authorization" not in response.text
    assert fake.calls == [None]


@pytest.mark.parametrize("ingredient_id,category", [
    ("spinach", "蔬菜"), ("chicken-thigh", "鸡肉"), ("cod", "鱼虾"),
    ("rice-noodles", "面食"), ("cheese", "蛋奶"), ("enoki", "菌菇"),
])
def test_expanded_catalog_categories_have_ingredient_evidence(ingredient_id, category):
    assert category in supported_preferences({ingredient_id})
    assert category not in supported_preferences({"salt", "water"})


def test_non_strict_missing_main_and_required_selected_main():
    data = payload()
    first = data["recipes"][0]
    first["ingredients"].append({"ingredientId": "mushroom", "amount": "100克"})
    first["steps"].append("将蘑菇切片后加入锅中，小火翻炒5分钟至熟软。")
    raw = json.dumps(data, ensure_ascii=False)
    with with_fake(FakeClient(raw)) as client:
        response = client.post(URL, json={**FRIDGE, "strictIngredients": False})
    assert response.status_code == 200, response.text
    assert response.json()["recipes"][0]["missingIngredients"] == [
        {"ingredientId": "mushroom", "name": "蘑菇", "amount": "100克", "role": "main"}]
    with with_fake(FakeClient(raw)) as client:
        response = client.post(URL, json=FRIDGE)
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 2
    assert any("strict_main_ingredient" in warning for warning in response.json()["warnings"])
    # Non-strict still cannot recommend a dish unrelated to the selected main.
    with with_fake(FakeClient(json.dumps(payload(), ensure_ascii=False))) as client:
        response = client.post(URL, json={"scene": "fridge", "ingredientIds": ["shrimp"], "strictIngredients": False})
    assert response.status_code == 502


@pytest.mark.parametrize("change", ["dining-time", "dining-steps", "cook-string-time", "cook-dining-field"])
def test_scene_fields_are_normalized_not_rejected(change):
    dining = change.startswith("dining")
    body = {"scene": "eat_out"} if dining else {"scene": "cook", "timeLimit": 15}
    data = payload(body)
    first = data["recipes"][0]
    if change == "dining-time":
        first["estimatedTime"] = 10
    elif change == "dining-steps":
        first["steps"] = ["不该出现的做法步骤。"]
    elif change == "cook-string-time":
        first["estimatedTime"] = "12"
    else:
        first["diningCategory"] = "家常菜"
        first["orderingTip"] = "不该出现的点单提示。"
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json=body)
    assert response.status_code == 200, response.text
    result = response.json()["recipes"][0]
    if dining:
        assert result["cookingSteps"] == [] and result["estimatedTime"] is None
    elif change == "cook-string-time":
        assert result["estimatedTime"] == 12
    else:
        assert result["diningCategory"] is None and result["orderingTip"] is None


def test_cook_time_over_limit_rejects_only_offending_candidates():
    data = payload({"scene": "cook", "timeLimit": 15})
    data["recipes"][0]["estimatedTime"] = 16
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json={"scene": "cook", "timeLimit": 15})
    assert response.status_code == 200, response.text
    assert len(response.json()["recipes"]) == 2
    assert any("time_limit" in warning for warning in response.json()["warnings"])
    for recipe in data["recipes"]:
        recipe["estimatedTime"] = 16
    with with_fake(FakeClient(json.dumps(data, ensure_ascii=False))) as client:
        response = client.post(URL, json={"scene": "cook", "timeLimit": 15})
    assert response.status_code == 502


def test_malformed_request_json_does_not_echo_input():
    with with_fake(FakeClient("never")) as client:
        response = client.post(URL, content='{"secret":"private", broken', headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and "private" not in response.text