"""Offline quality signals and controls, not evidence of real-model accuracy."""
import asyncio
import builtins
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


def ingredient(key):
    from app.catalog import BY_ID
    item = BY_ID[key]
    return {"ingredientId": key, "name": item.name, "role": item.role, "amount": "100克"}


def candidate(ids, bodies, *, name="测试热菜", minutes=25, description="食材分步骤处理后装盘。"):
    from app.schemas import CandidateRecipe
    return CandidateRecipe.model_validate({
        "name": name, "description": description,
        "ingredients": [ingredient(key) for key in ids],
        "cookingSteps": [{"title": f"处理步骤{n}", "body": body, "ingredientIds": refs}
                         for n, (body, refs) in enumerate(bodies, 1)],
        "estimatedTime": minutes, "recommendationReason": "按所列食材分步制作。",
        "missingIngredients": [], "imageFallbackCategory": "vegetable",
        "diningCategory": None, "orderingTip": None, "matchedPreferences": [],
    })


def raw_output(recipes):
    return json.dumps({"recipes": [r.model_dump() for r in recipes]}, ensure_ascii=False)


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
        ("番茄200克切块，土豆150克去皮切小块，鸡蛋1个打散备用。", ["tomato", "potato", "egg"]),
        ("锅中加入600毫升水，放入土豆块，大火烧开后转中小火煮8分钟。", ["water", "potato"]),
        ("加入番茄块继续煮4分钟，至番茄变软、汤汁略呈红色。", ["tomato"]),
        ("转小火，将蛋液缓慢淋入并停顿2秒再搅散，加2克盐和1克黑胡椒后关火。", ["egg", "salt", "black-pepper"]),
    ], name="番茄土豆蛋花汤", minutes=20, description="将番茄、土豆与鸡蛋做成暖胃汤品，食材简单，适合一人份。")
    stir = candidate(["tomato", "egg", "potato", "oil", "salt"], [
        ("番茄180克切块，土豆150克去皮切薄片，鸡蛋2个打散。", ["tomato", "potato", "egg"]),
        ("锅中倒入10毫升食用油，中火将土豆片煎5分钟至两面微黄，盛出备用。", ["oil", "potato"]),
        ("锅中补5毫升食用油，倒入蛋液炒至凝固后盛出。", ["oil", "egg"]),
        ("原锅放入番茄块炒3分钟，加入土豆片和炒蛋，加2克盐翻炒均匀出锅。", ["tomato", "potato", "egg", "salt"]),
    ], name="番茄土豆炒蛋", minutes=20)
    mash = candidate(["potato", "egg", "tomato", "water", "salt", "black-pepper"], [
        ("土豆200克去皮切块，放入300毫升水中大火烧开，转中火煮10分钟至软。", ["potato", "water"]),
        ("另起锅将鸡蛋1个炒熟炒散，盛出备用。", ["egg"]),
        ("将煮软的土豆压成泥，加入1克盐和1克黑胡椒拌匀。", ["potato", "salt", "black-pepper"]),
        ("番茄100克切小丁，与炒蛋一起拌入土豆泥中，翻拌均匀即可。", ["tomato", "egg", "potato"]),
    ], name="番茄土豆泥拌蛋")
    amounts = {
        "soup": ["200克", "1个", "150克", "600毫升", "2克", "1克"],
        "stir": ["180克", "2个", "150克", "15毫升", "2克"],
        "mash": ["200克", "1个", "100克", "300毫升", "1克", "1克"],
    }
    recipes = {"soup": soup, "stir": stir, "mash": mash}
    for kind, recipe in recipes.items():
        for item, amount in zip(recipe.ingredients, amounts[kind], strict=True):
            item.amount = amount
    return recipes


def corrected(recipe, kind):
    r = recipe.model_copy(deep=True)
    r.description = "食材分步骤加热后装盘。"
    steps = r.cookingSteps
    if kind in {"soup", "stir"}:
        steps[0].body = steps[0].body.replace("切小块", "切成约1厘米小块").replace("切薄片", "切成约2毫米薄片")
        steps[1].body = steps[1].body.replace("，盛出备用", "") + "用叉子检查土豆中心能轻松穿透且无硬芯，不软继续加热并复查。"
    if kind == "soup":
        steps[3].body = "保持微沸，缓慢淋入蛋液，继续煮约2分钟至蛋液完全凝固，无流动蛋液，加2克盐和1克黑胡椒拌匀后关火。"
    elif kind == "stir":
        steps[2].body = steps[2].body.replace("至凝固", "至完全凝固无流动蛋液")
    else:
        steps[0].body = steps[0].body.replace("去皮切块", "去皮切成约1厘米块") + "用叉子检查土豆中心能轻松穿透且无硬芯，不软继续煮并复查。"
        steps[1].body = "使用不粘锅无油翻炒鸡蛋约3分钟至完全凝固、无流动蛋液，盛出备用。"
        steps[2].body = "先将煮软的土豆沥干，再压成泥，加入1克盐和1克黑胡椒拌匀。"
        steps[3].body = "番茄100克洗净后用未接触生蛋的干净刀板切小丁，与炒蛋一起拌入土豆泥中。"
    return r


@pytest.mark.parametrize("kind,codes", [
    pytest.param("soup", {"potato_size_review", "potato_doneness_review", "egg_doneness_review"}, id="historical-soup-two-second-egg"),
    pytest.param("stir", {"potato_size_review", "potato_doneness_review"}, id="historical-thin-potato-five-minutes"),
    pytest.param("mash", {"mash_drain_review", "frying_medium_review"}, id="historical-undrained-mash-dry-egg"),
])
def test_historical_quality_is_advisory(historical, kind, codes):
    from app.validation import quality_review
    result = quality_review(historical[kind])
    assert isinstance(result, list)
    assert codes <= set(result)


@pytest.mark.parametrize("kind,codes", [
    pytest.param("soup", {"potato_size_review", "potato_doneness_review", "egg_doneness_review"}, id="corrected-soup"),
    pytest.param("stir", {"potato_size_review", "potato_doneness_review"}, id="corrected-stir"),
    pytest.param("mash", {"mash_drain_review", "frying_medium_review"}, id="corrected-mash"),
])
def test_historical_corrected_controls_validate(historical, kind, codes):
    from app.validation import quality_review, validate_output
    recipe = corrected(historical[kind], kind)
    assert not codes & set(quality_review(recipe))
    req = request()
    assert len(validate_output(raw_output([recipe]), req)) == 1
    assert len(serve(req, raw_output([recipe])).recipes) == 1


@pytest.mark.parametrize("kind", ["soup", "stir", "mash"], ids=["soup-objective-description", "stir-review-not-rejection", "mash-review-not-rejection"])
def test_historical_objective_candidates_warn_without_hard_rejection(historical, kind):
    r = historical[kind].model_copy(deep=True)
    r.description = "食材分步骤处理后装盘。"
    result = serve(request(), raw_output([r]))
    assert len(result.recipes) == 1
    notices = [w for w in result.warnings if w.startswith("第1道候选待人工复核：")]
    assert notices and any(any("\u4e00" <= c <= "\u9fff" for c in w.split("：", 1)[1]) for w in notices)
    assert all("_review" not in w for w in notices)


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
    pytest.param("hidden", "hidden_step_ingredient", id="hidden-step-meat"),
    pytest.param("basics", "basics_disabled", id="unselected-water-basics-false"),
])
def test_material_violations_remain_hard_errors(historical, mutation, code):
    from app.errors import OutputValidationError, RecommendationError
    from app.validation import validate_output
    from app.service import RecommendationService
    from app.settings import Settings
    r = corrected(historical["soup"], "soup")
    req = request()
    if mutation == "main":
        r.ingredients.append(type(r.ingredients[0]).model_validate(ingredient("beef")))
    elif mutation == "hidden":
        r.cookingSteps[0].body += "加入牛肉。"
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


@pytest.mark.parametrize("changed", ["name", "metadata", "format"], ids=["duplicate-renamed", "duplicate-title-amount-order", "duplicate-body-format"])
def test_identical_material_set_and_steps_are_hard_duplicates(historical, changed):
    from app.errors import OutputValidationError
    from app.validation import validate_output
    r = corrected(historical["soup"], "soup")
    other = r.model_copy(deep=True)
    other.name = "另一道热汤"
    if changed == "metadata":
        other.ingredients.reverse()
        other.ingredients[0].amount = "200克"
        other.cookingSteps[0].title = "换个步骤标题"
    elif changed == "format":
        for step in other.cookingSteps:
            step.body = step.body.replace("，", ", ").replace("。", ".")
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw_output([r, other]), request())
    assert caught.value.code == "duplicate_recipe"


def test_same_ingredients_with_different_operations_not_hard_duplicate(historical):
    from app.validation import validate_output
    r = corrected(historical["soup"], "soup")
    other = r.model_copy(deep=True)
    other.name = "分装蒸盅"
    other.cookingSteps[-1].body = "将鸡蛋倒入小碗中蒸10分钟，检查蛋液完全凝固后加入盐和黑胡椒再装盘。"
    assert len(validate_output(raw_output([r, other]), request())) == 2


@pytest.mark.parametrize("key,body,expected", [
    pytest.param("chicken-breast", "鸡胸肉切片后煎5分钟，装盘备用。", True, id="chicken-without-doneness"),
    pytest.param("chicken-breast", "鸡胸肉煎熟，用食品温度计检查中心温度达到74摄氏度后装盘。", False, id="chicken-core-temperature"),
    pytest.param("shrimp", "虾仁放入锅中煮5分钟后装盘备用。", True, id="shrimp-without-doneness"),
    pytest.param("shrimp", "虾仁蒸5分钟，检查中心完全不透明、肉质紧实后装盘。", True, id="shrimp-appearance-still-review"),
    pytest.param("shrimp", "虾仁蒸5分钟，用食品温度计核对中心温度达到63摄氏度，未达标继续加热再检查。", False, id="shrimp-temperature-method"),
    pytest.param("green-bean", "四季豆放入锅中炒5分钟后装盘备用。", True, id="beans-without-doneness"),
    pytest.param("green-bean", "四季豆煮15分钟至完全熟透，检查内外熟软、无生硬感后装盘。", False, id="beans-fully-soft"),
])
def test_meat_seafood_beans_review_controls(key, body, expected):
    from app.validation import quality_review
    r = candidate([key], [(body, [key])])
    assert ("doneness_review" in quality_review(r)) is expected


def test_each_raw_ingredient_needs_its_own_heating_step():
    from app.validation import quality_review
    r = candidate(["egg", "potato"], [
        ("土豆切成1厘米小块后蒸15分钟，用筷子检查中心易穿透无硬芯。", ["potato"]),
        ("鸡蛋打散后放在另一只碗里备用。", ["egg"]),
    ])
    assert "ingredient_heating_review" in quality_review(r)
    r.cookingSteps[1].body = "鸡蛋打散后蒸10分钟，检查完全凝固无流动蛋液。"
    assert "ingredient_heating_review" not in quality_review(r)


def test_steamed_mash_does_not_require_draining():
    from app.validation import quality_review
    r = candidate(["potato"], [("土豆切成1厘米小块蒸15分钟，用筷子检查中心无硬芯，再压成土豆泥。", ["potato"])])
    assert "mash_drain_review" not in quality_review(r)


@pytest.mark.parametrize("medium", ["oil", "butter", "nonstick"], ids=["declared-oil", "declared-butter", "explicit-no-oil-nonstick"])
def test_frying_medium_controls(medium):
    from app.validation import quality_review
    ids = ["egg"] + ([] if medium == "nonstick" else [medium])
    body = "使用不粘锅无油翻炒鸡蛋3分钟至完全凝固。" if medium == "nonstick" else "鸡蛋翻炒3分钟至完全凝固后装盘。"
    assert "frying_medium_review" not in quality_review(candidate(ids, [(body, ids)]))


@pytest.mark.parametrize("bodies,expected", [
    pytest.param(["土豆蒸30分钟后压成泥。"], True, id="single-step-exceeds-total"),
    pytest.param(["土豆蒸10分钟后装盘。"], False, id="single-step-within-total"),
    pytest.param(["土豆蒸12分钟后装盘。", "土豆同时另锅煮12分钟后沥干。"], False, id="parallel-times-not-summed"),
])
def test_duration_review_does_not_sum_parallel_steps(bodies, expected):
    from app.validation import quality_review
    r = candidate(["potato"], [(body, ["potato"]) for body in bodies], minutes=20)
    assert ("duration_review" in quality_review(r)) is expected


@pytest.mark.parametrize("scene", ["cook", "fridge", "eat_out"], ids=["prompt-cook", "prompt-fridge", "prompt-dining"])
def test_prompt_v2_keeps_user_payload_structured(scene):
    from app.prompts import build_messages
    req = request(scene=scene, ingredientIds=["egg", "tomato"] if scene == "fridge" else [])
    messages = build_messages(req)
    assert [m["role"] for m in messages] == ["system", "user"]
    assert "V2" in messages[0]["content"]
    payload = json.loads(messages[1]["content"])
    assert payload["request"] == req.model_dump()
    assert payload["catalog"] and payload["outputSchema"]
    system = messages[0]["content"]
    # Check scenario-specific identifiers, not brittle full prose wording.
    if scene != "eat_out":
        assert "budgetLevel" not in system
    if scene != "fridge":
        assert "assumeBasics" not in system and "strictIngredients" not in system


@pytest.mark.parametrize("body", [
    "使用不粘锅无油翻炒鸡蛋3分钟，随后加入食用油拌匀。",
    "使用不粘锅不加油翻炒鸡蛋3分钟，随后倒油拌匀。",
])
def test_no_oil_disclaimer_does_not_hide_actual_oil_use(historical, body):
    from app.errors import OutputValidationError
    from app.validation import validate_output
    recipe = corrected(historical["mash"], "mash")
    recipe.cookingSteps[1].body = body
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw_output([recipe]), request())
    assert caught.value.code == "hidden_step_ingredient"


def test_draining_after_mashing_still_requires_review(historical):
    from app.validation import quality_review
    recipe = historical["mash"].model_copy(deep=True)
    recipe.cookingSteps[2].body += "最后再沥去水。"
    assert "mash_drain_review" in quality_review(recipe)


def test_warming_stomach_claim_is_not_published(historical):
    from app.errors import OutputValidationError
    from app.validation import validate_output
    with pytest.raises(OutputValidationError) as caught:
        validate_output(raw_output([historical["soup"]]), request())
    assert caught.value.code == "unsupported_claim_or_url"


def test_prompt_allowed_catalog_and_repair_are_data():
    from app.prompts import build_messages
    messages = build_messages(request(), "duplicate_recipe", frozenset({"egg", "potato", "tomato"}))
    payload = json.loads(messages[1]["content"])
    assert payload["allowedIngredientIds"] == ["egg", "potato", "tomato"]
    assert {item["id"] for item in payload["catalog"]} == {"egg", "potato", "tomato"}
    assert payload["repair"]["validationCode"] == "duplicate_recipe"
