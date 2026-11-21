"""Hand-authored local demo recipes. No network and no masquerading as AI."""
import json
from dataclasses import dataclass

from app.catalog import BASIC_IDS, BY_ID
from app.errors import RecommendationError
from app.schemas import RecommendationRequest
from app.validation import food_ids, supported_preferences


@dataclass(frozen=True)
class Template:
    name: str
    description: str
    amounts: tuple[tuple[str, int, str], ...]
    minutes: int
    category: str
    steps: tuple[tuple[str, str], ...]


TEMPLATES = (
    Template("番茄鸡蛋快炒", "番茄炒出汁后与鸡蛋翻拌，适合作为一餐中的一道热菜。",
             (("tomato", 180, "克"), ("egg", 2, "个"), ("water", 100, "毫升"), ("oil", 5, "毫升")), 12, "protein", (
                 ("准备食材", "用水洗净番茄后切小块，将鸡蛋打散备用。"),
                 ("炒制鸡蛋", "锅中加入食用油，中小火倒入鸡蛋，翻炒约3分钟至凝固后盛出。"),
                 ("合炒出汁", "放入番茄和剩余水，中火煮3分钟，再加入鸡蛋翻炒2分钟至熟透。"))),
    Template("土豆鸡蛋薄煎", "土豆切细丝后与鸡蛋混合摊薄，做成有口感的小份煎菜。",
             (("potato", 180, "克"), ("egg", 2, "个"), ("water", 150, "毫升"), ("oil", 8, "毫升")), 18, "protein", (
                 ("切丝备料", "土豆去皮切细丝，用水冲洗沥干，鸡蛋打散备用。"),
                 ("先熟土豆", "锅中加食用油，放入土豆，中小火翻炒6分钟至变软。"),
                 ("摊薄煎制", "将鸡蛋倒入土豆中摊薄，小火两面各煎3分钟，检查中心熟透后盛出。"))),
    Template("番茄土豆焖煮", "土豆切小块与番茄一起焖软，用食材本身的风味搭配。",
             (("tomato", 180, "克"), ("potato", 180, "克"), ("water", 350, "毫升"), ("oil", 5, "毫升")), 22, "vegetable", (
                 ("清洗切块", "用水洗净番茄和土豆，土豆去皮后切成约1厘米的小块。"),
                 ("炒出汁液", "锅中加入食用油和番茄，中小火翻炒3分钟后放入土豆。"),
                 ("加水焖软", "倒入剩余水与番茄、土豆一同煮开，加盖小火焖15分钟，检查土豆软熟再盛出。"))),
    Template("番茄鸡蛋蒸盅", "将番茄切碎加入鸡蛋液，用小碗分装蒸制。",
             (("tomato", 100, "克"), ("egg", 2, "个"), ("water", 600, "毫升")), 22, "protein", (
                 ("处理番茄", "用少量水洗净番茄，切碎后放入耐热小碗备用。"),
                 ("调匀蛋液", "鸡蛋打散，加入100毫升水拌匀，与番茄混合后分装小碗。"),
                 ("蒸制成型", "剩余水放入蒸锅煮开，将番茄与鸡蛋的小碗放入，中火蒸15分钟，检查中心熟透后取出。"))),
    Template("土豆鸡蛋烘盘", "土豆切薄片先处理再铺入鸡蛋液，使用耐热烤盘制作。",
             (("potato", 180, "克"), ("egg", 2, "个"), ("water", 200, "毫升"), ("oil", 5, "毫升")), 30, "protein", (
                 ("预热备料", "烤箱预热至180摄氏度，土豆用水洗净去皮切薄片，鸡蛋打散备用。"),
                 ("处理薄片", "锅中放入土豆和剩余水，煮开后中火煮5分钟，沥干后放入抹好食用油的烤盘。"),
                 ("烘烤成型", "将鸡蛋倒在土豆薄片上，放入烤箱烤18分钟，检查中心熟透再切块盛出。"))),
    Template("番茄土豆鸡蛋汤", "番茄与土豆煮成热汤，最后加入鸡蛋形成蛋花。",
             (("tomato", 150, "克"), ("potato", 120, "克"), ("egg", 1, "个"), ("water", 550, "毫升")), 22, "soup", (
                 ("备好小块", "用少量水洗净番茄和土豆，土豆去皮切小块，鸡蛋打散备用。"),
                 ("煮软食材", "锅中加入剩余水、番茄和土豆，煮开后小火煮15分钟，检查土豆软熟。"),
                 ("淋入蛋液", "保持番茄土豆汤微沸，将鸡蛋缓缓倒入并搅动，再煮2分钟至熟透后盛出。"))),
    Template("黄瓜豆腐拌碗", "黄瓜切片，搭配加热后放温的豆腐，作为简单的一道配菜。",
             (("cucumber", 160, "克"), ("tofu", 180, "克"), ("water", 500, "毫升")), 10, "vegetable", (
                 ("清洗切片", "用少量水洗净黄瓜，切成薄片后放入干净碗中备用。"),
                 ("煮好豆腐", "锅中放入剩余水，加入切块的豆腐，煮开后继续煮3分钟，捞出放温。"),
                 ("轻拌装碗", "将豆腐与黄瓜放在一起，轻轻拌匀1分钟后装碗，避免压碎豆腐。"))),
    Template("蘑菇鸡蛋煎盘", "蘑菇先炒至熟软，再加入鸡蛋，小火煎成厚薄均匀的一盘。",
             (("mushroom", 160, "克"), ("egg", 2, "个"), ("water", 100, "毫升"), ("oil", 5, "毫升")), 14, "protein", (
                 ("整理备料", "用水洗净蘑菇并沥干切片，鸡蛋在碗中打散备用。"),
                 ("炒熟蘑菇", "锅中加入食用油和蘑菇，中火翻炒5分钟至熟软。"),
                 ("倒入鸡蛋", "将鸡蛋均匀倒在蘑菇上，小火煎3分钟后翻面再煎2分钟，检查熟透后盛出。"))),
    Template("番茄螺旋面", "螺旋面煮好后拌入煮软的番茄，做成一份简单热面。",
             (("tomato", 180, "克"), ("fusilli", 90, "克"), ("water", 1000, "毫升"), ("oil", 5, "毫升")), 20, "noodles", (
                 ("整理番茄", "用少量水洗净番茄并切小块，将螺旋面按份量备好。"),
                 ("煮好面食", "锅中加剩余水煮开，放入螺旋面，按包装提示煮约10分钟至熟后沥干。"),
                 ("翻拌装盘", "锅中加食用油与番茄，中火炒5分钟，放入螺旋面拌匀再加热1分钟后盛出。"))),
    Template("鸡胸肉西兰花焖盘", "鸡胸肉切薄片，与西兰花分阶段入锅，制作一份热菜。",
             (("chicken-breast", 160, "克"), ("broccoli", 180, "克"), ("water", 250, "毫升"), ("oil", 5, "毫升")), 22, "protein", (
                 ("分别备料", "西兰花用水洗净切小朵，鸡胸肉使用另一个砧板切成薄片。"),
                 ("煎制薄片", "锅中加入食用油，放入鸡胸肉，中火两面各煎3分钟。"),
                 ("焖熟装盘", "加入西兰花和剩余水，与鸡胸肉一起加盖焖8分钟，检查食材熟透后盛出。"))),
)


class MockClient:
    def __init__(self):
        self.generation = 0

    async def generate(self, request: RecommendationRequest, repair_code: str | None = None) -> str:
        available = set(request.ingredientIds) | (BASIC_IDS if request.assumeBasics else set())
        requested = request.preferences()
        flavors = {request.todayTaste} if request.todayTaste else set(request.tastePreferences)
        candidates = []
        for template in TEMPLATES:
            amounts = list(template.amounts)
            if request.scene == "fridge" and any(key not in available for key, _, _ in amounts):
                continue
            # Add only available seasonings in fridge mode, never manufacture a taste match.
            desired = []
            if flavors & {"微辣", "酸辣"}:
                desired.append(("chili", 3, "克"))
            if flavors & {"酸甜", "酸辣"}:
                desired.append(("vinegar", 5, "毫升"))
            if "酸甜" in flavors:
                desired.append(("sugar", 3, "克"))
            if "浓郁" in flavors:
                desired.append(("soy-sauce", 5, "毫升"))
            desired.append(("salt", 1, "克"))
            extras = [item for item in desired if request.scene != "fridge" or item[0] in available]
            amounts.extend(extras)
            minutes = template.minutes + 2 * (request.servings - 1)
            if request.timeLimit is not None and minutes > request.timeLimit:
                continue
            ingredients = [{"ingredientId": key, "name": BY_ID[key].name, "amount": f"{amount * request.servings}{unit}",
                            "role": BY_ID[key].role} for key, amount, unit in amounts]
            ids = {item["ingredientId"] for item in ingredients}
            steps = [{"title": title, "body": body, "ingredientIds": sorted(food_ids(title + body) & ids)}
                     for title, body in template.steps]
            if extras:
                names = "、".join(BY_ID[key].name for key, _, _ in extras)
                steps.append({"title": "调味装盘", "body": f"将{names}按整份用量加入做好的食材，轻轻拌匀1分钟后装盘。",
                              "ingredientIds": [key for key, _, _ in extras]})
            # Explicit fixed water allocations scale with the requested batch, too.
            if request.servings > 1:
                for step in steps:
                    step["body"] = step["body"].replace("100毫升", f"{100 * request.servings}毫升")
            dining = request.scene == "eat_out"
            tip = "先向商家确认实际食材、份量与供应情况，再按人数点单。"
            if request.budgetLevel == "economy":
                tip = "优先单点，先向商家确认份量与收费，再决定是否加配。"
            elif request.budgetLevel == "treat":
                tip = "按食量选择组合，先确认供应与计费方式，不承诺实际花费。"
            elif request.budgetLevel == "balanced":
                tip = "先按人数确认份量，再决定单点或组合，避免重复加配。"
            candidates.append({
                "name": template.name, "description": ("通用点单搭配参考：" if dining else "") + template.description,
                "ingredients": ingredients, "cookingSteps": [] if dining else steps,
                "estimatedTime": None if dining else minutes,
                "recommendationReason": "根据已声明食材提供搭配参考。", "missingIngredients": [],
                "imageFallbackCategory": template.category,
                "diningCategory": ("面食小馆" if template.category == "noodles" else "家常菜") if dining else None,
                "orderingTip": tip if dining else None,
                "matchedPreferences": sorted(requested & supported_preferences(ids)),
            })
        # Rank useful matches first; alternate subsets from ten genuinely different recipes.
        candidates.sort(key=lambda item: (request.todayTaste in item["matchedPreferences"] if request.todayTaste else False,
                                          len(item["matchedPreferences"])), reverse=True)
        if len(candidates) < 3 and request.scene != "fridge":
            raise RecommendationError("mock_constraints_unsupported", "演示食谱暂不能满足这些条件，请放宽用时等选项；未调用真实 AI。", 422)
        offset = (self.generation * 3) % len(candidates) if candidates else 0
        selected = (candidates[offset:] + candidates[:offset])[:3]
        self.generation += 1
        return json.dumps({"recipes": selected}, ensure_ascii=False)
