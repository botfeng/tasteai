from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.catalog import BY_ID

Scene = Literal["cook", "eat_out", "fridge"]
Taste = Literal["清爽", "微辣", "浓郁", "酸甜", "咸鲜", "原味", "酸辣"]
Category = Literal["蔬菜", "鸡肉", "鱼虾", "面食", "蛋奶", "菌菇"]
TASTES = ("清爽", "微辣", "浓郁", "酸甜", "咸鲜", "原味", "酸辣")
CATEGORIES = ("蔬菜", "鸡肉", "鱼虾", "面食", "蛋奶", "菌菇")
Identifier = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9-]*$")]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
FreeText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
AmountText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=24)]
StepText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RecommendationRequest(StrictModel):
    scene: Scene
    ingredientIds: list[Identifier] = Field(default_factory=list, max_length=40)
    tastePreferences: list[Taste] = Field(default_factory=list, max_length=7)
    todayTaste: Taste | None = None
    preferredCategories: list[Category] = Field(default_factory=list, max_length=6)
    timeLimit: int | None = Field(default=None, ge=5, le=180)
    budgetLevel: Literal["any", "economy", "balanced", "treat"] | None = None
    servings: int = Field(default=1, ge=1, le=6)
    maxRecipes: int = Field(default=5, ge=3, le=5)
    strictIngredients: bool = True
    assumeBasics: bool = True

    @model_validator(mode="after")
    def scene_constraints(self):
        for values in (self.ingredientIds, self.tastePreferences, self.preferredCategories):
            if len(values) != len(set(values)):
                raise ValueError("duplicate selection")
        if self.scene == "fridge":
            if not self.ingredientIds or any(value not in BY_ID for value in self.ingredientIds):
                raise ValueError("fridge requires known ingredients")
        elif self.ingredientIds:
            raise ValueError("ingredientIds is fridge-only")
        if self.scene != "cook" and self.timeLimit is not None:
            raise ValueError("timeLimit is cook-only")
        if self.scene != "eat_out" and self.budgetLevel is not None:
            raise ValueError("budgetLevel is eat_out-only")
        return self

    def preferences(self) -> set[str]:
        return set(self.tastePreferences) | set(self.preferredCategories) | ({self.todayTaste} if self.todayTaste else set())


class Ingredient(StrictModel):
    ingredientId: Identifier
    name: ShortText
    amount: AmountText
    role: Literal["main", "seasoning"]


class CookingStep(StrictModel):
    title: ShortText
    body: Text
    ingredientIds: list[Identifier] = Field(max_length=30)


class CandidateRecipe(StrictModel):
    # Backend-owned output DTO; every field is required, including nullable fields.
    name: ShortText
    description: FreeText
    ingredients: list[Ingredient] = Field(min_length=1, max_length=30)
    cookingSteps: list[CookingStep] = Field(max_length=12)
    estimatedTime: int | None = Field(ge=1, le=180)
    recommendationReason: Text
    missingIngredients: list[Ingredient] = Field(max_length=30)
    imageFallbackCategory: Literal["vegetable", "protein", "bowl", "soup", "noodles"]
    diningCategory: ShortText | None
    orderingTip: Text | None
    matchedPreferences: list[ShortText] = Field(max_length=13)


class ModelIngredient(BaseModel):
    """Lean model input: the backend resolves names, roles and missing materials."""
    model_config = ConfigDict(extra="forbid")

    ingredientId: Annotated[str, StringConstraints(max_length=64)]
    amount: AmountText

    @model_validator(mode="before")
    @classmethod
    def tolerant_input(cls, data):
        if isinstance(data, dict):
            data = {key: value for key, value in data.items() if key in cls.model_fields}
            if isinstance(data.get("amount"), (int, float)) and not isinstance(data["amount"], bool):
                data["amount"] = str(data["amount"])
        return data


class ModelRecipe(BaseModel):
    """Lean model input: plain-text steps, no per-step ingredient references.

    Fields stay required (no defaults) so the strict json_schema contract holds;
    the before-validator drops unknown keys and fills optional omissions.
    """
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    description: FreeText
    ingredients: list[ModelIngredient] = Field(min_length=1, max_length=30)
    steps: list[StepText] = Field(max_length=12)
    estimatedTime: int | None
    diningCategory: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None
    orderingTip: FreeText | None
    imageFallbackCategory: Annotated[str, StringConstraints(max_length=32)] | None

    @model_validator(mode="before")
    @classmethod
    def tolerant_input(cls, data):
        if not isinstance(data, dict):
            return data
        data = {key: value for key, value in data.items() if key in cls.model_fields}
        for key, default in (("description", ""), ("steps", []), ("estimatedTime", None),
                             ("diningCategory", None), ("orderingTip", None), ("imageFallbackCategory", None)):
            data.setdefault(key, default)
        if isinstance(data["steps"], list):
            steps = []
            for item in data["steps"]:
                if isinstance(item, dict):
                    item = item.get("body") or item.get("text") or item.get("description")
                if isinstance(item, str):
                    steps.append(item)
            data["steps"] = steps
        time = data["estimatedTime"]
        if isinstance(time, str) and time.strip().isdigit():
            time = int(time.strip())
        if isinstance(time, float) and time.is_integer():
            time = int(time)
        data["estimatedTime"] = time if isinstance(time, int) and not isinstance(time, bool) else None
        return data


class ModelOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recipes: list[ModelRecipe] = Field(max_length=5)


class RawModelOutput(StrictModel):
    recipes: list[object] = Field(max_length=5)


class Recipe(CandidateRecipe):
    id: str


class RecommendationResponse(StrictModel):
    recipes: list[Recipe]
    source: Literal["mock", "ai"]
    model: str | None
    notice: str
    warnings: list[str]
    servings: int
    scene: Scene


class RecommendationStatus(StrictModel):
    mode: Literal["disabled", "mock", "openai_compatible"]
    configured: bool
    source: Literal["mock", "ai"] | None
    model: str | None
    message: str
    deploymentScope: Literal["local_demo"] = "local_demo"
    limiterScope: Literal["single_process_reset_on_restart"] = "single_process_reset_on_restart"


class ErrorDetail(StrictModel):
    code: str
    message: str


class ErrorResponse(StrictModel):
    detail: ErrorDetail
