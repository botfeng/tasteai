"""The shared packaged catalog is the authority for ingredient identity and role."""
import json
from importlib.resources import files
from types import MappingProxyType

from pydantic import BaseModel, ConfigDict
from typing import Literal


class CatalogIngredient(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    id: str
    name: str
    aliases: list[str]
    role: Literal["main", "seasoning"]
    basic: bool


CATALOG = tuple(
    CatalogIngredient.model_validate(item)
    for item in json.loads(files("app").joinpath("data/ingredients.json").read_text(encoding="utf-8"))
)
BY_ID = MappingProxyType({item.id: item for item in CATALOG})
BASIC_IDS = frozenset(item.id for item in CATALOG if item.basic)
if len(BY_ID) != len(CATALOG):
    raise RuntimeError("Ingredient catalog contains duplicate IDs")
