"""Offline acceptance of the lean V3 contract; not evidence of real-model accuracy."""
import asyncio
import builtins
import copy
import io
import json
import os
import socket

import httpx
import pytest
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def offline_only(monkeypatch):
    # Initialize Windows' internal wakeup socketpair before blocking application connections.
    loop = asyncio.SelectorEventLoop()
    monkeypatch.setattr(asyncio, "run", loop.run_until_complete)

    def forbidden(*args, **kwargs):
        raise AssertionError("Offline test attempted network, dotenv or environment settings")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", forbidden)
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    # Guard direct dotenv file reads as well as python-dotenv entry points.
    for module in (builtins, io):
        original = module.open

        def guarded_open(file, *args, _open=original, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                basename = os.path.basename(os.fsdecode(file)).lower()
                if basename == ".env" or basename.startswith(".env."):
                    forbidden()
            return _open(file, *args, **kwargs)

        monkeypatch.setattr(module, "open", guarded_open)
    try:
        import dotenv
        import dotenv.main
    except ImportError:
        pass
    else:
        for module in (dotenv, dotenv.main):
            for name in ("load_dotenv", "dotenv_values", "find_dotenv"):
                monkeypatch.setattr(module, name, forbidden)
        monkeypatch.setattr(dotenv.main.DotEnv, "dict", forbidden)
    from app.settings import Settings
    monkeypatch.setattr(Settings, "from_env", forbidden)
    yield
    loop.close()


class FakeClient:
    def __init__(self, raw):
        self.raw = raw
        self.calls = []

    async def generate(self, request, repair_code=None):
        self.calls.append((request, repair_code))
        return self.raw


def request(**changes):
    from app.schemas import RecommendationRequest
    return RecommendationRequest.model_validate({"scene": "fridge", "ingredientIds": ["potato", "egg", "tomato"], **changes})


def candidate(ids, bodies, *, name="测试热菜", minutes=25, description="食材分步骤处理后装盘。", amounts=None):
    return {
        "name": name, "description": description,
        "ingredients": [{"ingredientId": key, "amount": (amounts or {}).get(key, "100克")} for key in ids],
        "steps": list(bodies), "estimatedTime": minutes,
        "diningCategory": None, "orderingTip": None, "imageFallbackCategory": "vegetable",
    }


def raw_output(recipes):
    return json.dumps({"recipes": recipes}, ensure_ascii=False)


def serve(req, raw):
    from app.service import RecommendationService
    from app.settings import Settings
    fake = FakeClient(raw)
    result = asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), fake).generate(req, "offline"))
    assert fake.calls == [(req, None)]
    assert result.source == "mock" and result.model is None
    return result


def mock_raw(req):
    from app.mock import MockClient
    return asyncio.run(MockClient().generate(req))


@pytest.fixture
def historical():
    soup = candidate(["tomato", "egg", "potato", "water", "salt", "black-pepper"], [
        "番茄200克切块，土豆150克去皮切小块，鸡蛋1个打散备用。",
        "锅中加入600毫升水，放入土豆块，大火烧开后转中小火煮8分钟。",
        "加入番茄块继续煮4分钟，至番茄变软、汤汁略呈红色。",
        "转小火，将蛋液缓慢淋入并停顿2秒再搅散，加2克盐和1克黑胡椒后关火。",
    ], name="番茄土豆蛋花汤", minutes=20, description="将番茄、土豆与鸡蛋做成暖胃汤品，食材简单，适合一人份。",
        amounts={"tomato": "200克", "egg": "1个", "potato": "150克", "water": "600毫升", "salt": "2克", "black-pepper": "1克"})
    stir = candidate(["tomato", "egg", "potato", "oil", "salt"], [
        "番茄180克切块，土豆150克去皮切薄片，鸡蛋2个打散。",
        "锅中倒入10毫升食用油，中火将土豆片煎5分钟至两面微黄，盛出备用。",
        "锅中补5毫升食用油，倒入蛋液炒至凝固后盛出。",
        "原锅放入番茄块炒3分钟，加入土豆片和炒蛋，加2克盐翻炒均匀出锅。",
    ], name="番茄土豆炒蛋", minutes=20,
        amounts={"tomato": "180克", "egg": "2个", "potato": "150克", "oil": "15毫升", "salt": "2克"})
    mash = candidate(["potato", "egg", "tomato", "water", "salt", "black-pepper"], [
        "土豆200克去皮切块，放入300毫升水中大火烧开，转中火煮10分钟至软。",
        "另起锅将鸡蛋1个炒熟炒散，盛出备用。",
        "将煮软的土豆压成泥，加入1克盐和1克黑胡椒拌匀。",
        "番茄100克切小丁，与炒蛋一起拌入土豆泥中，翻拌均匀即可。",
    ], name="番茄土豆泥拌蛋",
        amounts={"potato": "200克", "egg": "1个", "tomato": "100克", "water": "300毫升", "salt": "1克", "black-pepper": "1克"})
    return {"soup": soup, "stir": stir, "mash": mash}


def test_historical_amounts_are_consistent(historical):
    from app.validation import amount_consistency_warnings, validate_output
    for recipe in historical.values():
        parsed = validate_output(raw_output([recipe]), request())[0]
        assert amount_consistency_warnings(parsed) == []


def test_step_usage_exceeding_list_total_warns_without_rejection(historical):
    from app.validation import amount_consistency_warnings, validate_output
    recipe = copy.deepcopy(historical["soup"])
    recipe["ingredients"][4]["amount"] = "1克"
    parsed = validate_output(raw_output([recipe]), request())[0]
    assert any("盐" in warning and "超过总量" in warning for warning in amount_consistency_warnings(parsed))
    result = serve(request(), raw_output([recipe]))
    assert len(result.recipes) == 1
    assert any(w.startswith("第1道 番茄土豆蛋花汤：") and "超过总量" in w for w in result.warnings)


def test_tea_spoon_vs_gram_warns_without_unit_conversion():
    from app.validation import amount_consistency_warnings, validate_output
    recipe = candidate(["tomato", "egg", "salt"], [
        "番茄切块，鸡蛋打散加1茶匙盐。",
        "炒熟后加1茶匙盐调味出锅。",
    ], amounts={"tomato": "200克", "egg": "2个", "salt": "3克"})
    parsed = validate_output(raw_output([recipe]), request())[0]
    warnings = amount_consistency_warnings(parsed)
    assert len(warnings) == 1 and "盐" in warnings[0] and "不同单位" in warnings[0]


def test_longest_name_and_adjacency_prevent_false_attribution():
    from app.validation import amount_consistency_warnings, validate_output
    recipe = candidate(["tomato", "tomato-paste", "egg"], [
        "番茄200克切块，加入番茄膏5克炒匀。",
        "鸡蛋2个打散下锅炒熟。",
    ], amounts={"tomato": "200克", "tomato-paste": "5克", "egg": "2个"})
    assert amount_consistency_warnings(validate_output(raw_output([recipe]), request())[0]) == []
    shared = candidate(["tomato", "egg"], ["番茄鸡蛋2个打散炒熟。"], amounts={"tomato": "1个", "egg": "2个"})
    assert amount_consistency_warnings(validate_output(raw_output([shared]), request())[0]) == []
    clause = candidate(["tomato", "egg", "salt"], ["回锅鸡蛋，加2克盐炒匀出锅。"],
                       amounts={"tomato": "200克", "egg": "3个", "salt": "3克"})
    assert amount_consistency_warnings(validate_output(raw_output([clause]), request())[0]) == []


@pytest.mark.parametrize("ids", [
    pytest.param(["tomato", "egg"], id="two-egg-ingredients"),
    pytest.param(["tomato", "potato", "egg"], id="three-ingredients"),
    pytest.param(["tomato", "potato", "egg", "cucumber", "tofu", "mushroom"], id="six-ingredients"),
    pytest.param(["cucumber", "tofu"], id="vegetarian-two"),
    pytest.param(["chicken-breast", "broccoli"], id="meat-two"),
])
def test_selected_ingredient_scenarios(ids):
    from app.catalog import BASIC_IDS
    req = request(ingredientIds=ids)
    response = serve(req, mock_raw(req))
    assert response.recipes
    for recipe in response.recipes:
        assert {i.ingredientId for i in recipe.ingredients} <= set(ids) | BASIC_IDS


@pytest.mark.parametrize("count", [0, 1, 2], ids=["strict-zero-no-padding", "strict-one-no-padding", "strict-two-no-padding"])
def test_strict_insufficient_candidates_are_not_padded(count):
    req = request(ingredientIds=["tomato", "egg"])
    data = json.loads(mock_raw(req))
    data["recipes"] = data["recipes"][:count]
    result = serve(req, json.dumps(data))
    assert len(result.recipes) == count
    assert f"{count}道" in result.notice


def test_basics_false_does_not_invent_water_or_oil():
    req = request(assumeBasics=False)
    result = serve(req, mock_raw(req))
    assert result.recipes == []


def test_basics_false_allows_explicit_six_selected_items():
    req = request(ingredientIds=["tomato", "potato", "egg", "water", "oil", "salt"], assumeBasics=False)
    assert len(serve(req, mock_raw(req)).recipes) == 3


@pytest.mark.parametrize("taste", ["清爽", "微辣", "浓郁", "酸甜", "咸鲜", "原味", "酸辣"], ids=["fresh", "mild-spicy", "rich", "sweet-sour", "savory", "original", "sour-spicy"])
def test_taste_claims_have_ingredient_evidence(taste):
    from app.validation import supported_preferences
    req = request(scene="cook", ingredientIds=[], todayTaste=taste)
    result = serve(req, mock_raw(req))
    for recipe in result.recipes:
        assert set(recipe.matchedPreferences) <= {taste}
        assert set(recipe.matchedPreferences) <= supported_preferences({i.ingredientId for i in recipe.ingredients})


def test_unavailable_spicy_preference_warns_instead_of_inventing_chili():
    req = request(todayTaste="酸辣")
    result = serve(req, mock_raw(req))
    assert all("酸辣" not in r.matchedPreferences for r in result.recipes)
    assert any("未确认匹配" in w and "酸辣" in w for w in result.warnings)


@pytest.mark.parametrize("servings", [1, 2, 6], ids=["one-serving", "two-servings", "six-servings"])
def test_servings_scale_total_amounts_and_server_reason(servings):
    req = request(scene="cook", ingredientIds=[], servings=servings)
    result = serve(req, mock_raw(req))
    baseline = json.loads(mock_raw(request(scene="cook", ingredientIds=[])))
    assert result.servings == servings
    assert result.recipes[0].ingredients[0].amount == f"{180 * servings}克"
    assert result.recipes[0].estimatedTime >= baseline["recipes"][0]["estimatedTime"]
    assert all(f"{servings}人份" in r.recommendationReason for r in result.recipes)


@pytest.mark.parametrize("budget", ["any", "economy", "balanced", "treat"], ids=["budget-any", "budget-economy", "budget-balanced", "budget-treat"])
def test_budget_is_generic_ordering_not_a_real_price(budget):
    req = request(scene="eat_out", ingredientIds=[], budgetLevel=budget)
    result = serve(req, mock_raw(req))
    assert len(result.recipes) >= 3
    for r in result.recipes:
        assert r.orderingTip and r.diningCategory
        assert r.cookingSteps == [] and r.estimatedTime is None
        assert "元" not in r.orderingTip and "￥" not in r.orderingTip


def test_cook_time_limit_is_respected():
    req = request(scene="cook", ingredientIds=[], timeLimit=15)
    assert all(r.estimatedTime <= 15 for r in serve(req, mock_raw(req)).recipes)


def test_five_minute_mock_reports_constraint_failure():
    from app.errors import RecommendationError
    req = request(scene="cook", ingredientIds=[], timeLimit=5)
    with pytest.raises(RecommendationError) as caught:
        mock_raw(req)
    assert caught.value.code == "mock_constraints_unsupported"


@pytest.mark.parametrize("scene", ["cook", "fridge", "eat_out"], ids=["illegal-disliked-cook", "illegal-disliked-fridge", "illegal-disliked-dining"])
def test_disliked_ingredient_ids_are_not_supported_by_schema(scene):
    with pytest.raises(ValidationError) as caught:
        request(scene=scene, ingredientIds=["egg"] if scene == "fridge" else [], dislikedIngredientIds=["egg"])
    assert any(e["loc"] == ("dislikedIngredientIds",) and e["type"] == "extra_forbidden" for e in caught.value.errors())


def test_duplicate_input_selection_is_invalid():
    with pytest.raises(ValidationError):
        request(ingredientIds=["egg", "egg"])


@pytest.mark.parametrize("mutation,code", [
    pytest.param("main", "strict_main_ingredient", id="strict-unselected-main"),
    pytest.param("basics", "basics_disabled", id="unselected-water-basics-false"),
])
def test_material_violations_remain_hard_errors(historical, mutation, code):
    from app.errors import OutputValidationError, RecommendationError
    from app.validation import validate_output
    from app.service import RecommendationService
    from app.settings import Settings
    r = copy.deepcopy(historical["soup"])
    req = request()
    if mutation == "main":
        r["ingredients"].append({"ingredientId": "beef", "amount": "100克"})
    else:
        req = request(assumeBasics=False)
    raw = raw_output([r])
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw, req)
    assert caught.value.code == code
    fake = FakeClient(raw)
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), fake).generate(req, "offline"))
    assert caught.value.code == "invalid_model_output"
    assert len(fake.calls) == 1


def test_step_prose_is_not_scanned_for_hidden_foods(historical):
    from app.validation import validate_output
    r = copy.deepcopy(historical["soup"])
    r["steps"][0] += "搭配芝士和培根风味。"
    assert len(validate_output(raw_output([r]), request())) == 1


def test_natural_warming_description_is_accepted(historical):
    result = serve(request(), raw_output([historical["soup"]]))
    assert len(result.recipes) == 1
    assert not any("已淘汰" in w for w in result.warnings)


@pytest.mark.parametrize("changed", ["name", "metadata", "format"], ids=["duplicate-renamed", "duplicate-ingredient-order", "duplicate-body-format"])
def test_identical_material_set_and_steps_are_hard_duplicates(historical, changed):
    from app.errors import OutputValidationError
    from app.validation import validate_output
    r = historical["soup"]
    other = copy.deepcopy(r)
    other["name"] = "另一道热汤"
    if changed == "metadata":
        other["ingredients"].reverse()
        other["ingredients"][0]["amount"] = "200克"
        other["description"] = "换个简介。"
    elif changed == "format":
        other["steps"] = [body.replace("，", ", ").replace("。", ".") for body in other["steps"]]
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw_output([r, other]), request())
    assert caught.value.code == "duplicate_recipe"


def test_same_ingredients_with_different_operations_not_hard_duplicate(historical):
    from app.validation import validate_output
    r = historical["soup"]
    other = copy.deepcopy(r)
    other["name"] = "分装蒸盅"
    other["steps"][-1] = "将鸡蛋倒入小碗中蒸10分钟，检查蛋液完全凝固后加入盐和黑胡椒再装盘。"
    assert len(validate_output(raw_output([r, other]), request())) == 2


def test_single_concise_step_parses_without_per_step_ids():
    r = candidate(["tomato", "egg"], ["番茄鸡蛋一起炒熟，约10分钟出锅。"], amounts={"tomato": "200克", "egg": "2个"})
    result = serve(request(ingredientIds=["tomato", "egg"]), raw_output([r]))
    assert len(result.recipes) == 1
    step = result.recipes[0].cookingSteps[0]
    assert step.title == "步骤1" and step.ingredientIds == []


def test_old_format_without_plain_steps_is_rejected_not_silently_converted():
    from app.errors import OutputValidationError
    from app.validation import validate_output
    r = candidate(["tomato", "egg"], ["炒熟出锅。"])
    r["cookingSteps"] = [{"title": "炒", "body": "炒熟出锅。", "ingredientIds": ["tomato", "egg"]}]
    del r["steps"]
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw_output([r]), request())
    assert caught.value.code == "missing_steps"


@pytest.mark.parametrize("scene", ["cook", "fridge", "eat_out"], ids=["prompt-cook", "prompt-fridge", "prompt-dining"])
def test_prompt_v3_keeps_user_payload_structured(scene):
    from app.prompts import build_messages
    req = request(scene=scene, ingredientIds=["egg", "tomato"] if scene == "fridge" else [])
    messages = build_messages(req)
    assert [m["role"] for m in messages] == ["system", "user"]
    assert "V3" in messages[0]["content"]
    payload = json.loads(messages[1]["content"])
    assert payload["request"] == req.model_dump()
    assert payload["catalog"] and payload["outputSchema"]
    system = messages[0]["content"]
    # Check scenario-specific identifiers, not brittle full prose wording.
    if scene != "eat_out":
        assert "budgetLevel" not in system
    if scene != "fridge":
        assert "assumeBasics" not in system and "strictIngredients" not in system


def test_prompt_v3_states_amount_sum_and_plain_steps():
    from app.prompts import build_messages
    messages = build_messages(request(scene="cook", ingredientIds=[]))
    system = messages[0]["content"]
    assert "合计不得超过材料表" in system
    assert "纯文本字符串数组" in system
    schema = json.loads(messages[1]["content"])["outputSchema"]
    props = schema["$defs"]["ModelRecipe"]["properties"]
    assert set(props) == {"name", "description", "ingredients", "steps", "estimatedTime",
                          "diningCategory", "orderingTip", "imageFallbackCategory"}
    serialized = json.dumps(schema)
    assert "cookingSteps" not in serialized and "matchedPreferences" not in serialized
    assert "missingIngredients" not in serialized and "recommendationReason" not in serialized


def test_prompt_allowed_catalog_and_repair_are_data():
    from app.prompts import build_messages
    messages = build_messages(request(), "duplicate_recipe", frozenset({"egg", "potato", "tomato"}))
    payload = json.loads(messages[1]["content"])
    assert payload["allowedIngredientIds"] == ["egg", "potato", "tomato"]
    assert {item["id"] for item in payload["catalog"]} == {"egg", "potato", "tomato"}
    assert payload["repair"]["validationCode"] == "duplicate_recipe"