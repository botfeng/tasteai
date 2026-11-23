"""Structural checks and user-condition enforcement; cooking quality lives in the prompt.

Text is never scanned for banned vocabulary. Rejections are limited to unparseable
output, unknown/duplicate ingredients, violated user restrictions and blank results.
"""
import re
import unicodedata
from uuid import uuid4

from pydantic import ValidationError

from app.catalog import BASIC_IDS, BY_ID, CATALOG
from app.errors import OutputValidationError
from app.schemas import (CookingStep, Ingredient, ModelRecipe, RawModelOutput, Recipe,
                         RecommendationRequest)

CATEGORY_IDS = {
    "蔬菜": {
        "tomato", "potato", "cucumber", "carrot", "green-bean", "zucchini", "bell-pepper", "broccoli", "onion", "edamame",
        "spinach", "napa-cabbage", "cabbage", "lettuce", "bok-choy", "choy-sum", "celtuce", "chrysanthemum-greens",
        "water-spinach", "amaranth", "chinese-kale", "celery", "chinese-chives", "garlic-sprouts", "eggplant", "pumpkin",
        "winter-melon", "bitter-melon", "loofah", "lotus-root", "chinese-yam", "taro", "sweet-potato", "white-radish",
        "asparagus", "bamboo-shoot", "okra", "snow-pea", "pea", "fresh-corn", "mung-bean-sprout", "soybean-sprout",
    },
    "鸡肉": {"chicken-breast", "chicken-thigh", "chicken-wing"},
    "鱼虾": {"ready-salmon", "raw-salmon", "shrimp", "cod", "sea-bass", "hairtail", "pomfret", "squid", "clam"},
    "面食": {"fusilli", "noodles", "flour", "cornmeal", "rice-noodles", "dried-vermicelli", "spaghetti", "sliced-bread", "rice-cake"},
    "蛋奶": {"egg", "milk", "quail-egg", "duck-egg", "plain-yogurt", "cheese"},
    "菌菇": {"mushroom", "shiitake", "king-oyster-mushroom", "enoki", "oyster-mushroom", "shimeji", "dried-wood-ear", "dried-snow-fungus"},
}
DINING_CATEGORIES = {"家常菜", "轻食简餐", "面食小馆", "中式快餐", "简餐"}
IMAGE_CATEGORIES = {"vegetable", "protein", "bowl", "soup", "noodles"}
DEFAULT_ORDERING_TIP = "先向商家确认实际食材、份量与供应情况，再按人数点单。"

ERROR_FIELDS = {
    **{code: ("ingredients",) for code in ("duplicate_ingredient", "no_main_ingredient", "no_selected_main", "strict_main_ingredient", "basics_disabled")},
    "missing_steps": ("steps",),
    "time_limit": ("estimatedTime",),
    "recipe_count": ("recipes",),
    "duplicate_recipe": ("recipes",),
    "excluded_recipe": ("recipes",),
}


def fail(code: str, field_path: tuple[str | int, ...] = ()):
    raise OutputValidationError(code, field_path or ERROR_FIELDS.get(code, ()))


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in value if unicodedata.category(char)[0] in {"L", "N"})


def supported_preferences(ids: set[str]) -> set[str]:
    result = {category for category, members in CATEGORY_IDS.items() if members & ids}
    acid = bool(ids & {"vinegar", "lemon"})
    if "chili" in ids:
        result.add("微辣")
        if acid:
            result.add("酸辣")
    if acid and "sugar" in ids:
        result.add("酸甜")
    if ids & {"salt", "soy-sauce"}:
        result.add("咸鲜")
    if ids & {"mayonnaise", "tomato-paste", "soy-sauce"}:
        result.add("浓郁")
    if not ids & {"chili", "vinegar", "soy-sauce", "mayonnaise", "tomato-paste", "sugar"}:
        result.add("原味")
        if ids & (CATEGORY_IDS["蔬菜"] | {"tofu"}):
            result.add("清爽")
    return result


def computed_missing(ingredients: list[Ingredient], request: RecommendationRequest) -> list[Ingredient]:
    if request.scene != "fridge":
        return []
    available = set(request.ingredientIds) | (BASIC_IDS if request.assumeBasics else set())
    return [ingredient for ingredient in ingredients if ingredient.ingredientId not in available]


def resolve_ingredient(item, index: int) -> Ingredient:
    key = item.ingredientId.strip()
    if key not in BY_ID:
        # Only a missing hyphen is recoverable; never substitute another known food.
        matches = [entry.id for entry in CATALOG if entry.id.replace("-", "") == key]
        if len(matches) != 1:
            fail("ingredient_identity", ("ingredients", index))
        key = matches[0]
    amount = item.amount
    if not amount:
        fail("ingredient_amount", ("ingredients", index, "amount"))
    number = re.match(r"\d+(?:\.\d+)?", amount)
    if number and float(number.group()) <= 0:
        fail("ingredient_amount", ("ingredients", index, "amount"))
    entry = BY_ID[key]
    return Ingredient(ingredientId=key, name=entry.name, amount=amount, role=entry.role)


def validate_recipe(candidate: ModelRecipe, request: RecommendationRequest) -> Recipe:
    ingredients = [resolve_ingredient(item, index) for index, item in enumerate(candidate.ingredients)]
    ids = {ingredient.ingredientId for ingredient in ingredients}
    if len(ids) != len(ingredients):
        fail("duplicate_ingredient")
    mains = {key for key in ids if BY_ID[key].role == "main"}
    if not mains:
        fail("no_main_ingredient")
    if request.scene == "fridge":
        selected = set(request.ingredientIds)
        if not mains & selected:
            fail("no_selected_main")
        if request.strictIngredients and mains - selected:
            fail("strict_main_ingredient")
        # With basics disabled, even an explicit missing entry cannot add basics.
        if not request.assumeBasics and (ids & BASIC_IDS) - selected:
            fail("basics_disabled")

    text_fields = [(("name",), candidate.name), (("description",), candidate.description)]
    text_fields += [(("steps", index), value) for index, value in enumerate(candidate.steps)]
    text_fields += [(("diningCategory",), candidate.diningCategory or ""), (("orderingTip",), candidate.orderingTip or "")]
    for path, value in text_fields:
        if any(unicodedata.category(char) in {"Cf", "Cs"} or (unicodedata.category(char) == "Cc" and char not in "\n\t")
               for char in unicodedata.normalize("NFKC", value)):
            fail("invalid_text", path)

    if request.scene == "eat_out":
        # Dining advice never carries cooking instructions; extra model fields are discarded.
        steps: list[CookingStep] = []
        estimated = None
        dining = candidate.diningCategory if candidate.diningCategory in DINING_CATEGORIES else "简餐"
        tip = candidate.orderingTip or DEFAULT_ORDERING_TIP
    else:
        dining = None
        tip = None
        estimated = candidate.estimatedTime
        if estimated is None or not 1 <= estimated <= 180 or (request.timeLimit is not None and estimated > request.timeLimit):
            fail("time_limit")
        bodies = [value for value in candidate.steps if value]
        if not bodies:
            fail("missing_steps")
        steps = [CookingStep(title=f"步骤{number}", body=body, ingredientIds=[])
                 for number, body in enumerate(bodies, 1)]

    missing = computed_missing(ingredients, request)
    matched = sorted(request.preferences() & supported_preferences(ids))
    names = "、".join(BY_ID[key].name for key in sorted(mains))
    reason = f"以{names}为主要食材，按{request.servings}人份提供建议。"
    if request.scene == "fridge":
        reason += "包含已选主要食材。"
    if request.scene != "eat_out":
        reason += f"预计用时{estimated}分钟"
        if request.timeLimit is not None:
            reason += f"，不超过{request.timeLimit}分钟的限制"
        reason += "。"
    if request.todayTaste and request.todayTaste in matched:
        reason += f"食材搭配贴合今天想吃的{request.todayTaste}。"
    elif matched:
        reason += "食材搭配可参考所选偏好：" + "、".join(matched) + "。"
    image = candidate.imageFallbackCategory if candidate.imageFallbackCategory in IMAGE_CATEGORIES else "bowl"
    description = candidate.description or f"{candidate.name}，根据本次条件生成。"
    return Recipe(name=candidate.name, description=description, ingredients=ingredients, cookingSteps=steps,
                  estimatedTime=estimated, recommendationReason=reason, missingIngredients=missing,
                  imageFallbackCategory=image, diningCategory=dining, orderingTip=tip,
                  matchedPreferences=matched, id=str(uuid4()))


LIST_AMOUNT = re.compile(r"^(\d+(?:\.\d+)?)\s*(克|毫升|个|片|根|朵|瓣|勺|茶匙|汤匙|份)$")
STEP_QTY = re.compile(r"(\d+(?:\.\d+)?)\s*(克|毫升|个|片|根|朵|瓣|茶匙|汤匙|勺|份)")
# Longest-first catalog tokenization keeps 番茄膏/番茄 and 熟米饭/生米 distinct.
NAMES = {name: item.id for item in CATALOG for name in (item.name, *item.aliases)}
NAME_PATTERN = re.compile("|".join(re.escape(name) for name in sorted(NAMES, key=len, reverse=True)))


def amount_consistency_warnings(recipe: Recipe) -> list[str]:
    """Advisory reminders only: no unit conversion, never a rejection."""
    totals = {}
    for item in recipe.ingredients:
        match = LIST_AMOUNT.match(item.amount)
        if match:
            totals[item.ingredientId] = (float(match.group(1)), match.group(2), item.name)
    if not totals or not recipe.cookingSteps:
        return []
    used: dict[str, float] = {}
    mixed: set[str] = set()
    for step in recipe.cookingSteps:
        text = unicodedata.normalize("NFKC", step.body)
        names = [(m.start(), m.end(), NAMES[m.group()]) for m in NAME_PATTERN.finditer(text)]
        quantities = [(m.start(), m.end(), float(m.group(1)), m.group(2)) for m in STEP_QTY.finditer(text)]
        for ns, ne, key in names:
            if key not in totals:
                continue
            for qs, qe, value, unit in quantities:
                gap = qs - ne if qs >= ne else ns - qe
                if not 0 <= gap <= 2:
                    continue
                lo, hi = (ne, qs) if qs >= ne else (qe, ns)
                if any(os < hi and oe > lo for os, oe, _ in names):
                    continue
                # Punctuation between name and quantity means they belong to different clauses.
                if any(char not in "约各共的 　" for char in text[lo:hi]):
                    continue
                if unit != totals[key][1]:
                    mixed.add(key)
                else:
                    used[key] = used.get(key, 0.0) + value
                break
    warnings = []
    for key, (total, unit, name) in totals.items():
        if key in mixed:
            warnings.append(f"材料表「{name}」以{unit}计量，步骤使用了不同单位，无法自动换算，请核对各步骤用量合计不超过总量。")
        elif key in used and used[key] > total:
            warnings.append(f"材料表「{name}」共{total:g}{unit}，步骤中可识别的用量合计约{used[key]:g}{unit}，超过总量，请核对。")
    return warnings


def validate_output(raw: str, request: RecommendationRequest,
                    rejected: list[OutputValidationError] | None = None) -> list[Recipe]:
    # Offline acceptance callers remain fail-fast; generation collects per-recipe rejections.
    if not isinstance(raw, str):
        fail("invalid_json")
    try:
        if len(raw.encode("utf-8")) > 120_000:
            fail("invalid_json")
        output = RawModelOutput.model_validate_json(raw)
    except ValidationError as error:
        location = tuple(error.errors(include_input=False, include_context=False, include_url=False)[0]["loc"])
        fail("invalid_json_or_schema", location)
    except (ValueError, UnicodeError):
        fail("invalid_json_or_schema")
    if len(output.recipes) > request.maxRecipes or (request.scene != "fridge" and not output.recipes):
        fail("recipe_count")
    recipes = []
    names = set()
    fingerprints = set()
    excluded = {normalize_name(value) for value in request.excludedRecipeNames}
    for index, candidate in enumerate(output.recipes):
        try:
            try:
                recipe = ModelRecipe.model_validate(candidate)
            except ValidationError as error:
                location = tuple(error.errors(include_input=False, include_context=False, include_url=False)[0]["loc"])
                fail("invalid_json_or_schema", location)
            recipe = validate_recipe(recipe, request)
            name = normalize_name(recipe.name)
            if not name or name in names:
                fail("duplicate_recipe", ("name",))
            if name in excluded:
                fail("excluded_recipe", ("name",))
            fingerprint = (tuple(sorted(item.ingredientId for item in recipe.ingredients)),
                           tuple(normalize_name(step.body) for step in recipe.cookingSteps))
            if recipe.cookingSteps and fingerprint in fingerprints:
                fail("duplicate_recipe", ("cookingSteps",))
            recipes.append(recipe)
            names.add(name)
            if recipe.cookingSteps:
                fingerprints.add(fingerprint)
        except OutputValidationError as error:
            error.field_path = ("recipes", index, *error.field_path)
            if rejected is None:
                raise
            rejected.append(error)
    if output.recipes and not recipes:
        raise rejected[0]
    return recipes