"""Structural/lexical checks do not replace human culinary review."""
import re
import unicodedata
from uuid import uuid4

from pydantic import ValidationError

from app.catalog import BASIC_IDS, BY_ID, CATALOG
from app.errors import OutputValidationError
from app.schemas import CATEGORIES, CandidateRecipe, RawModelOutput, Recipe, RecommendationRequest

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
ALIASES = {name: item.id for item in CATALOG for name in (item.name, *item.aliases)}
# Additional detection vocabulary does not extend the selectable catalog.
ALIASES.update({
    "蛋液": "egg", "蛋花": "egg", "烘蛋": "egg", "蒸蛋": "egg", "蛋饼": "egg",
    "鸡肉": "chicken-breast", "米饭": "cooked-rice", "油": "oil", "胡椒": "black-pepper",
    "白砂糖": "sugar", "糖": "sugar", "面饼": "flour", "蒜末": "garlic",
    "鸡腿": "chicken-thigh", "米粉": "rice-noodles", "淀粉汁": "cornstarch",
})
FOOD_PATTERN = re.compile("|".join(re.escape(name) for name in sorted(ALIASES, key=len, reverse=True)))
ENGLISH_IDS = {
    "beef": "beef", "pork": "pork", "chicken": "chicken-breast", "egg": "egg",
    "tomato": "tomato", "potato": "potato", "garlic": "garlic", "salt": "salt",
    "oil": "oil", "water": "water", "pepper": "black-pepper", "rice": "raw-rice",
    "shrimp": "shrimp", "salmon": "raw-salmon", "chili": "chili", "vinegar": "vinegar",
}
UNKNOWN_FOOD = re.compile(
    r"芝士|奶酪|黄油|奶油|培根|火腿|香肠|蚝油|香油|芝麻油|高汤|鸡精|味精|"
    r"番茄酱|花生酱|豆瓣酱|料酒|白酒|啤酒|蜂蜜|菠菜|白菜|卷心菜|生菜|玉米|"
    r"豌豆|茄子|南瓜|山药|牛油果|鳕鱼|金枪鱼|蟹|贝肉|羊肉|鸭肉|肉末|肉馅|"
    r"燕麦|面包|面包糠|淀粉|粉丝|酸奶|水果|苹果|香蕉|花生|芝麻|"
    r"\b(?:cheese|butter|cream|bacon|ham|sausage|stock|spinach|cabbage|corn|bread)\b", re.I,
)
UNSUPPORTED = re.compile(
    r"营养|蛋白质|卡路里|热量|千卡|大卡|千焦|低卡|低脂|高蛋白|零脂|减脂|减肥|"
    r"碳水|脂肪|膳食纤维|维生素|胆固醇|钠含量|钙含量|铁含量|矿物质|富含|低糖|无糖|低钠|"
    r"瘦身|降糖|降脂|降压|控糖|升糖|治愈|治疗|增强免疫|排毒|养胃|暖胃|补血|"
    r"糖尿病|孕妇|孕期|婴儿|婴幼儿|无过敏|不会过敏|无风险|无副作用|安全|保证|百分百|100\s*%|无菌|放心|安心食用|"
    r"\b(?:kcal|calories|protein|nutrition|fat|carbs|guaranteed|safe)\b", re.I,
)
URL = re.compile(r"https?\s*:|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io)\b", re.I)
MERCHANT = re.compile(
    r"餐厅|饭店|餐馆|店|私房菜|地址|营业|开门|打烊|预订|预约|电话|人均|价格|售价|"
    r"海底捞|肯德基|麦当劳|必胜客|星巴克|沙县|兰州|喜茶|瑞幸|"
    r"[路街巷号栋楼座区县市省]|[¥￥$€£]|元|块钱|人民币|\d+(?:\.\d+)?\s*(?:块|rmb|cny)|"
    r"\d{1,2}\s*[:：]\s*\d{2}|[一二三四五六七八九十两零〇\d]+\s*(?:点|时)|\d{7,}|"
    r"全天|星期|周[一二三四五六日天]|\b(?:restaurant|bistro|kfc|mcdonalds)\b", re.I,
)
ACTION = re.compile(r"切|洗|拌|打散|搅|煎|炒|煮|蒸|烤|焖|倒|加入|放入|盛|装|铺|压|沥|翻|擦|处理")
TIMING = re.compile(r"\d+(?:[—~～-]\d+)?\s*(?:分钟|秒)")
HEAT = re.compile(r"煎|炒|煮|蒸|烤|焖")
RAW = {
    "egg", "quail-egg", "duck-egg", "chicken-breast", "chicken-thigh", "chicken-wing", "pork", "beef", "duck", "lamb",
    "pork-ribs", "beef-brisket", "raw-salmon", "shrimp", "cod", "sea-bass", "hairtail", "pomfret", "squid", "clam",
    "green-bean", "edamame", "potato", "taro", "bamboo-shoot", "lotus-root", "mung-bean-sprout", "soybean-sprout",
    "soybean", "mung-bean", "adzuki-bean", "chickpea", "dried-bean-curd", "raw-rice", "brown-rice", "glutinous-rice",
    "millet", "oat-groats", "rolled-oats", "buckwheat-groats", "barley-grain", "job-tears", "flour", "cornmeal",
    "noodles", "fusilli", "spaghetti", "rice-noodles", "dried-vermicelli", "cornstarch",
} | CATEGORY_IDS["菌菇"]


ERROR_FIELDS = {
    **{code: ("ingredients",) for code in ("duplicate_ingredient", "no_main_ingredient", "no_selected_main", "strict_main_ingredient", "basics_disabled")},
    "missing_ingredients_mismatch": ("missingIngredients",),
    "unselected_preference": ("matchedPreferences",),
    "unselected_preference_reason": ("recommendationReason",),
    "unsupported_preference": ("matchedPreferences",),
    "dining_cooking_fields": ("cookingSteps",),
    "dining_fields": ("diningCategory",),
    "cooking_dining_fields": ("diningCategory",),
    "time_limit": ("estimatedTime",),
    "non_executable_steps": ("cookingSteps",),
    "raw_food_instructions": ("cookingSteps",),
    "recipe_count": ("recipes",),
    "duplicate_recipe": ("recipes",),
}


def fail(code: str, field_path: tuple[str | int, ...] = ()):
    raise OutputValidationError(code, field_path or ERROR_FIELDS.get(code, ()))


def dangerous_raw_advice(text: str) -> bool:
    for match in re.finditer(r"半熟|溏心|生吃|生食|刺身", text):
        prefix = text[:match.start()]
        negation = re.search(r"(?:避免|不要|不得|禁止|不可|不能|切勿|严禁)(?:直接)?$", prefix)
        if negation is None or re.search(r"(?:不必|不用|无需|无须|不需要|不应|不该|不要|不能|并非)$", prefix[:negation.start()]):
            return True
    return False


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in value if unicodedata.category(char)[0] in {"L", "N"})


def food_ids(text: str, field_path: tuple[str | int, ...] = ()) -> set[str]:
    # Longest matches keep 熟米饭/生米 and 番茄膏/番茄 distinct.
    text = re.sub(r"厘米|毫米|毫升|水分|口水", "", unicodedata.normalize("NFKC", text))
    text = re.sub(r"无油|不(?:加|放|使用)(?:食用)?油|无需(?:加|用)油", "", text)
    matches = list(FOOD_PATTERN.finditer(text))
    ids = {ALIASES[match.group()] for match in matches}
    remaining = FOOD_PATTERN.sub(" ", text)
    for unknown in UNKNOWN_FOOD.finditer(text):
        if not any(known.start() <= unknown.start() and known.end() >= unknown.end() for known in matches):
            fail("uncatalogued_food", field_path)
    for word, ingredient_id in ENGLISH_IDS.items():
        if re.search(r"\b" + word + r"\b", remaining, re.I):
            ids.add(ingredient_id)
    return ids


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


def computed_missing(recipe: CandidateRecipe, request: RecommendationRequest):
    if request.scene != "fridge":
        return []
    available = set(request.ingredientIds) | (BASIC_IDS if request.assumeBasics else set())
    return [ingredient for ingredient in recipe.ingredients if ingredient.ingredientId not in available]


QUALITY_MESSAGES = {
    "potato_size_review": "土豆切块大小或片厚未明确，请核对切配与加热条件。",
    "potato_doneness_review": "未识别到土豆中心软熟的具体检查，请用筷子或叉子核实无硬芯。",
    "egg_doneness_review": "未识别到蛋液完全凝固的说明，请核对加入鸡蛋后的加热与熟度。",
    "mash_drain_review": "水煮后压泥的沥水顺序未明确，请核对余水处理。",
    "frying_medium_review": "煎炒鸡蛋未列油或明确无油设备条件，请核对实际用料与操作。",
    "ingredient_heating_review": "部分需熟食材未识别到对应加热步骤，请逐项复核。",
    "doneness_review": "肉类、水产或豆类的适用熟度核实不明确，不能仅凭颜色或时间判断。",
    "duration_review": "某步参考时长超过预计总耗时，请核对备料、并行操作与总时间。",
    "flavor_review": "口味描述未获当前食材映射支持，可能来自食材自然风味或主观感受；请复核，不代表已满足口味偏好，也不应据此额外添加材料。",
}


def quality_review(recipe: CandidateRecipe) -> list[str]:
    # Missing lexical evidence is a review signal, never proof of unsafe or safe food.
    ids = {item.ingredientId for item in recipe.ingredients}
    steps = recipe.cookingSteps
    prose = "\n".join((recipe.name, recipe.description, recipe.orderingTip or "",
                       *(value for step in steps for value in (step.title, step.body))))
    issues = []
    if any(taste in prose and taste not in supported_preferences(ids)
           for taste in ("微辣", "酸辣", "酸甜", "浓郁", "咸鲜")):
        issues.append("flavor_review")
    if not steps:
        return issues
    text = unicodedata.normalize("NFKC", "\n".join(step.body for step in steps))
    if "potato" in ids:
        potato_text = "\n".join(step.body for step in steps if "potato" in step.ingredientIds)
        if not re.search(r"\d+(?:\.\d+)?\s*(?:毫米|厘米)", potato_text):
            issues.append("potato_size_review")
        if not (re.search(r"筷子|叉子", potato_text) and re.search(r"穿透|穿过|无硬芯|没有硬芯", potato_text)):
            issues.append("potato_doneness_review")
        boil = next((i for i, step in enumerate(steps)
                     if "potato" in step.ingredientIds and "water" in step.ingredientIds and "煮" in step.body), None)
        mash = next((i for i, step in enumerate(steps)
                     if "potato" in step.ingredientIds and re.search(r"压.*泥|捣.*泥|碾.*泥", step.body)), None)
        if boil is not None and mash is not None and boil <= mash:
            before_mash = "\n".join(step.body for step in steps[boil:mash + 1])
            before_mash = re.split(r"压.*?泥|捣.*?泥|碾.*?泥", before_mash, maxsplit=1)[0]
            if not re.search(r"沥|滤|倒掉.*水|倒去.*水", before_mash):
                issues.append("mash_drain_review")
    egg_ids = ids & {"egg", "duck-egg", "quail-egg"}
    if egg_ids:
        egg_text = "\n".join(step.body for step in steps if egg_ids & set(step.ingredientIds))
        if not re.search(r"完全凝固|全部凝固|凝固.*(?:无|没有).*液|蛋白.*蛋黄.*凝固", egg_text):
            issues.append("egg_doneness_review")
        if (re.search(r"炒|煎", egg_text) and not ids & {"oil", "butter"}
                and not (re.search(r"无油|不加油|无需加油|不放油", egg_text) and re.search(r"不粘锅|不粘平底锅", egg_text))):
            issues.append("frying_medium_review")
    for ingredient_id in sorted(ids & RAW):
        related = "\n".join(step.body for step in steps if ingredient_id in step.ingredientIds)
        if not HEAT.search(related):
            issues.append("ingredient_heating_review")
            break
    sensitive = ids & (CATEGORY_IDS["鸡肉"] | (CATEGORY_IDS["鱼虾"] - {"ready-salmon"}) | {
        "pork", "beef", "duck", "lamb", "pork-ribs", "beef-brisket", "green-bean", "edamame",
        "soybean", "mung-bean", "adzuki-bean", "chickpea",
    })
    for ingredient_id in sorted(sensitive):
        related = "\n".join(step.body for step in steps if ingredient_id in step.ingredientIds)
        beans = {"green-bean", "edamame", "soybean", "mung-bean", "adzuki-bean", "chickpea"}
        evidence = (r"无硬芯|没有硬芯|完全软熟|内外熟软.*无生硬感" if ingredient_id in beans
                    else r"温度计|中心温度")
        if not re.search(evidence, related):
            issues.append("doneness_review")
            break
    if recipe.estimatedTime is not None:
        durations = re.findall(r"(\d+(?:\.\d+)?)(?:[—~～-](\d+(?:\.\d+)?))?\s*分钟", text)
        if any(float(low) > recipe.estimatedTime for low, _ in durations):
            issues.append("duration_review")
    return issues


def validate_recipe(recipe: CandidateRecipe, request: RecommendationRequest) -> Recipe:
    ids = {ingredient.ingredientId for ingredient in recipe.ingredients}
    if len(ids) != len(recipe.ingredients):
        fail("duplicate_ingredient")
    for field in ("ingredients", "missingIngredients"):
        for index, ingredient in enumerate(getattr(recipe, field)):
            catalog = BY_ID.get(ingredient.ingredientId)
            if catalog is None or ingredient.role != catalog.role or ingredient.name not in {catalog.name, *catalog.aliases}:
                fail("ingredient_identity", (field, index))
            if float(re.match(r"[\d.]+", ingredient.amount).group()) <= 0:
                fail("ingredient_amount", (field, index, "amount"))
            ingredient.name = catalog.name
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
    missing = computed_missing(recipe, request)
    expected = {item.ingredientId: item.model_dump() for item in missing}
    actual = {item.ingredientId: item.model_dump() for item in recipe.missingIngredients}
    if len(actual) != len(recipe.missingIngredients) or expected != actual:
        fail("missing_ingredients_mismatch")

    text_fields = [((field,), getattr(recipe, field) or "") for field in
                   ("name", "description", "recommendationReason", "diningCategory", "orderingTip")]
    text_fields += [(("matchedPreferences", index), value) for index, value in enumerate(recipe.matchedPreferences)]
    text_fields += [(("cookingSteps", index, field), getattr(step, field))
                    for index, step in enumerate(recipe.cookingSteps) for field in ("title", "body")]
    text_fields = [(path, unicodedata.normalize("NFKC", value)) for path, value in text_fields]
    text = "\n".join(value for _, value in text_fields)
    for path, value in text_fields:
        if any(unicodedata.category(char) in {"Cf", "Cs"} or (unicodedata.category(char) == "Cc" and char not in "\n\t") for char in value):
            fail("invalid_text", path)
        claim_text = re.sub(r"(?:^|(?<=[。！？；!?;\n]))\s*(?:请)?注意(?:食品|饮食)?安全(?=[，,。！？；!?;\n]|$)", "", value)
        if UNSUPPORTED.search(claim_text) or URL.search(value):
            fail("unsupported_claim_or_url", path)
    claimed = set(recipe.matchedPreferences)
    if len(claimed) != len(recipe.matchedPreferences) or not claimed <= request.preferences():
        fail("unselected_preference")
    # Model-authored reasons are replaced below; only structured matches can claim preferences.
    if not claimed <= supported_preferences(ids):
        fail("unsupported_preference", ("matchedPreferences",))
    # Strip category labels only from reasons; 鸡肉 in dish prose can hide real meat.
    reason_prose = recipe.recommendationReason
    for category in CATEGORIES:
        reason_prose = reason_prose.replace(category, "")
    for field, value in (("name", recipe.name), ("description", recipe.description),
                         ("recommendationReason", reason_prose), ("orderingTip", recipe.orderingTip or "")):
        if food_ids(value, (field,)) - ids:
            fail("hidden_ingredient", (field,))
    if request.scene == "eat_out":
        if recipe.cookingSteps or recipe.estimatedTime is not None:
            fail("dining_cooking_fields", ("cookingSteps",) if recipe.cookingSteps else ("estimatedTime",))
        if recipe.diningCategory not in DINING_CATEGORIES or not recipe.orderingTip:
            fail("dining_fields", ("diningCategory",) if recipe.diningCategory not in DINING_CATEGORIES else ("orderingTip",))
        if MERCHANT.search(text):
            fail("merchant_facts", next(path for path, value in text_fields if MERCHANT.search(value)))
    else:
        if recipe.diningCategory is not None or recipe.orderingTip is not None:
            fail("cooking_dining_fields", ("diningCategory",) if recipe.diningCategory is not None else ("orderingTip",))
        if recipe.estimatedTime is None or (request.timeLimit is not None and recipe.estimatedTime > request.timeLimit):
            fail("time_limit")
        if len(recipe.cookingSteps) < 3:
            fail("non_executable_steps")
        covered = set()
        for index, step in enumerate(recipe.cookingSteps):
            step_ids = set(step.ingredientIds)
            if len(step_ids) != len(step.ingredientIds) or not step_ids <= ids:
                path = ("cookingSteps", index, "ingredientIds")
                body_ids = food_ids(step.body, ("cookingSteps", index, "body"))
                if re.search(r"不要|不加|不放|不用|无需|无须|未加|未用|禁止|避免|可选|或", step.body):
                    fail("step_ingredient_reference", path)
                normalized = []
                for key in step.ingredientIds:
                    if key in ids:
                        target = key
                    else:
                        # Only a missing hyphen is recoverable; never substitute another known food.
                        matches = [item.id for item in CATALOG if item.id.replace("-", "") == key]
                        if key in BY_ID or len(matches) != 1:
                            fail("step_ingredient_reference", path)
                        target = matches[0]
                    if target not in ids or target not in body_ids:
                        fail("step_ingredient_reference", path)
                    if target not in normalized:
                        normalized.append(target)
                step.ingredientIds = normalized
                step_ids = set(normalized)
            for field in ("title", "body"):
                path = ("cookingSteps", index, field)
                if food_ids(getattr(step, field), path) - step_ids:
                    fail("hidden_step_ingredient", path)
            if len(step.body) < 12 or not ACTION.search(step.body):
                fail("non_executable_steps", ("cookingSteps", index, "body"))
            covered |= step_ids
        steps_text = "\n".join(step.body for step in recipe.cookingSteps)
        if covered != ids or not TIMING.search(steps_text):
            fail("non_executable_steps")
        if ids & RAW:
            if not HEAT.search(steps_text):
                fail("raw_food_instructions")
            for path, value in text_fields:
                if dangerous_raw_advice(value):
                    fail("raw_food_instructions", path)

    # Ground reasons in validated data instead of publishing model persuasion.
    names = "、".join(BY_ID[key].name for key in sorted(mains))
    reason = f"以{names}为主要食材，按{request.servings}人份提供建议。"
    if request.scene == "fridge":
        reason += "包含已选主要食材。"
    if request.scene != "eat_out":
        reason += f"预计用时{recipe.estimatedTime}分钟。"
    if claimed:
        reason += "食材搭配可参考所选偏好：" + "、".join(sorted(claimed)) + "。"
    return Recipe(**recipe.model_dump(exclude={"recommendationReason", "missingIngredients"}),
                  recommendationReason=reason, missingIngredients=missing, id=str(uuid4()))


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
    for index, candidate in enumerate(output.recipes):
        try:
            try:
                recipe = CandidateRecipe.model_validate(candidate)
            except ValidationError as error:
                location = tuple(error.errors(include_input=False, include_context=False, include_url=False)[0]["loc"])
                fail("invalid_json_or_schema", location)
            recipe = validate_recipe(recipe, request)
            name = normalize_name(recipe.name)
            if not name or name in names:
                fail("duplicate_recipe", ("name",))
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
