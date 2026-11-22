"""Deterministic dish-photo search via the official Openverse API (anonymous).

Accuracy over hit rate: a photo is only accepted on composite keyword evidence
from its title and tags (ingredient hits, dish-type words, method evidence,
name proximity), never on search rank alone. One broader retry may follow a
failed exact search, and its candidates face a stricter evidence gate so the
extra recall never lowers precision. This is keyword evidence, NOT visual
recognition; accepted photos are labeled as illustrative by the frontend.
Only CC0 / Public Domain Mark / CC BY photos are used, with attribution kept.
Images are hotlinked via the Openverse thumbnail endpoint (never downloaded);
only search metadata is cached. Anonymous limits are 20/min burst, 200/day.
"""
import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.catalog import BY_ID
from app.schemas import Identifier, Scene, ShortText, StrictModel
from app.settings import Settings
from app.validation import normalize_name

SEARCH_URL = "https://api.openverse.org/v1/images/"
USER_AGENT = "TasteAI-local-demo/0.4 (personal recipe demo)"
ALLOWED_LICENSES = {"cc0", "pdm", "by"}
CACHE_TTL_SECONDS = 12 * 3600
CACHE_MAX_ENTRIES = 256
PER_IP_PER_MINUTE = 10
MAX_IP_ENTRIES = 512

# English evidence phrases per catalog main ingredient; the first phrase leads queries.
INGREDIENT_ENGLISH: dict[str, tuple[str, ...]] = {
    "tomato": ("tomato",), "egg": ("egg",), "quail-egg": ("quail egg",), "duck-egg": ("duck egg",),
    "chicken-breast": ("chicken",), "chicken-thigh": ("chicken",), "chicken-wing": ("chicken wing", "chicken"),
    "cucumber": ("cucumber",), "edamame": ("edamame",), "mushroom": ("mushroom",),
    "shiitake": ("shiitake", "mushroom"), "king-oyster-mushroom": ("king oyster mushroom", "mushroom"),
    "enoki": ("enoki", "mushroom"), "oyster-mushroom": ("oyster mushroom", "mushroom"),
    "shimeji": ("shimeji", "mushroom"), "dried-wood-ear": ("wood ear", "black fungus"),
    "dried-snow-fungus": ("snow fungus",),
    "fusilli": ("fusilli", "pasta"), "spaghetti": ("spaghetti", "pasta"),
    "noodles": ("noodle",), "rice-noodles": ("rice noodle",), "dried-vermicelli": ("vermicelli", "glass noodle"),
    "cooked-rice": ("rice",), "raw-rice": ("rice",), "brown-rice": ("brown rice",), "glutinous-rice": ("sticky rice",),
    "lemon": ("lemon",), "ready-salmon": ("salmon",), "raw-salmon": ("salmon",),
    "seaweed-salad": ("seaweed",), "nori": ("nori", "seaweed"),
    "carrot": ("carrot",), "green-bean": ("green bean",), "zucchini": ("zucchini", "courgette"),
    "bell-pepper": ("bell pepper", "pepper"), "potato": ("potato",), "sweet-potato": ("sweet potato",),
    "beef": ("beef",), "beef-brisket": ("beef brisket", "beef"), "pork": ("pork",), "pork-ribs": ("pork rib",),
    "lamb": ("lamb",), "duck": ("duck",),
    "tofu": ("tofu",), "tofu-sheet": ("tofu",), "dried-bean-curd": ("tofu", "bean curd"), "dried-tofu": ("tofu",),
    "broccoli": ("broccoli",), "onion": ("onion",), "shrimp": ("shrimp", "prawn"),
    "milk": ("milk",), "plain-yogurt": ("yogurt",), "cheese": ("cheese",), "soy-milk": ("soy milk",),
    "flour": ("flour",), "spinach": ("spinach",), "napa-cabbage": ("napa cabbage", "cabbage"),
    "cabbage": ("cabbage",), "lettuce": ("lettuce",), "bok-choy": ("bok choy",), "choy-sum": ("choy sum",),
    "celtuce": ("celtuce",), "chrysanthemum-greens": ("chrysanthemum",), "water-spinach": ("water spinach",),
    "amaranth": ("amaranth",), "chinese-kale": ("kale",), "celery": ("celery",), "chinese-chives": ("chive",),
    "garlic-sprouts": ("garlic sprout",), "eggplant": ("eggplant", "aubergine"), "pumpkin": ("pumpkin",),
    "winter-melon": ("winter melon",), "bitter-melon": ("bitter melon",), "loofah": ("loofah", "sponge gourd"),
    "lotus-root": ("lotus root",), "chinese-yam": ("yam",), "taro": ("taro",), "white-radish": ("radish", "daikon"),
    "asparagus": ("asparagus",), "bamboo-shoot": ("bamboo shoot",), "okra": ("okra",),
    "snow-pea": ("snow pea",), "pea": ("pea",), "fresh-corn": ("corn",),
    "mung-bean-sprout": ("bean sprout",), "soybean-sprout": ("bean sprout",),
    "cod": ("cod",), "sea-bass": ("sea bass", "fish"), "hairtail": ("hairtail", "fish"),
    "pomfret": ("pomfret", "fish"), "squid": ("squid",), "clam": ("clam",),
    "soybean": ("soybean",), "mung-bean": ("mung bean",), "adzuki-bean": ("adzuki bean", "red bean"),
    "chickpea": ("chickpea",), "millet": ("millet",), "oat-groats": ("oat",), "rolled-oats": ("oat", "oatmeal"),
    "buckwheat-groats": ("buckwheat",), "barley-grain": ("barley",), "job-tears": ("job tears",),
    "cornmeal": ("cornmeal", "polenta"), "rice-cake": ("rice cake",), "sliced-bread": ("bread", "toast"),
    "apple": ("apple",), "banana": ("banana",), "avocado": ("avocado",), "pear": ("pear",),
    "orange": ("orange",), "pineapple": ("pineapple",), "peanut": ("peanut",), "walnut": ("walnut",),
    "cashew": ("cashew",), "almond": ("almond",), "white-sesame": ("sesame",), "black-sesame": ("sesame",),
}

# First matching rule wins: query words, category synonyms (any one is evidence),
# extra words that must also be present. Synonyms name the same category feature,
# so they are alternatives; `extra` is a separate feature and stays mandatory.
TYPE_RULES: tuple[tuple[str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("炒饭", "fried rice", ("rice",), ("fried",)),
    ("炒面", "fried noodles", ("noodle",), ("fried",)),
    ("焖饭", "braised rice", ("rice",), ()),
    ("煲仔饭", "claypot rice", ("rice",), ()),
    ("盖饭", "rice bowl", ("rice",), ()),
    ("拌饭", "mixed rice", ("rice",), ()),
    ("饭", "rice", ("rice",), ()),
    ("汤", "soup", ("soup",), ()),
    ("羹", "soup", ("soup",), ()),
    ("沙拉", "salad", ("salad",), ()),
    ("粥", "congee", ("congee", "porridge"), ()),
    ("面", "noodles", ("noodle",), ()),
    ("泥", "mashed", ("mashed",), ()),
    ("饼", "pancake", ("pancake", "fritter"), ()),
    ("饺", "dumplings", ("dumpling",), ()),
)
METHOD_RULES: tuple[tuple[str, str], ...] = (
    ("炒", "stir fry"), ("煎", "pan fried"), ("炸", "fried"), ("烤", "roasted"),
    ("蒸", "steamed"), ("炖", "stewed"), ("煮", "boiled"), ("拌", "mixed"),
)
METHOD_QUERIES = dict(METHOD_RULES)
GENTLE_METHODS = {"蒸", "炖", "煮"}
METHOD_EVIDENCE: dict[str, tuple[str, ...]] = {
    "炒": ("stir fry", "stir fried", "scrambled", "sauteed"),
    "煎": ("pan fried", "seared"),
    "炸": ("fried", "crispy"),
    "烤": ("roasted", "baked", "grilled"),
    "蒸": ("steamed",),
    "炖": ("stewed", "braised"),
    "煮": ("boiled", "poached"),
    "拌": ("mixed",),
}

# A photo of a multi-dish spread or a hand-held sandwich does not illustrate one
# recipe, so it is rejected even when the ingredients overlap. Dishes that really
# are a spread or a sandwich (name markers) keep their own photos.
COMBO_MARKERS: tuple[str, ...] = (
    "platter", "buffet", "charcuterie", "assortment", "sampler", "smorgasbord",
    "bento", "sandwich", "burger", "hot dog",
)
COMBO_NAME_MARKERS: tuple[str, ...] = ("拼盘", "自助", "便当", "三明治", "堡", "热狗")

# English dish-form words the photo evidences; each one only fits a recipe whose
# name carries a matching marker, otherwise the photo shows a different course.
FORM_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fried rice", ("饭",)), ("rice bowl", ("饭",)), ("congee", ("粥",)), ("porridge", ("粥",)),
    ("pasta", ("面", "粉")), ("noodles", ("面", "粉")), ("dumplings", ("饺",)),
    ("pancake", ("饼",)), ("pizza", ("比萨", "披萨")),
)

# Search terms only, never a pinned photo: Openverse ANDs every query token, so the
# mechanical "spaghetti beef noodles" concatenation returns nothing while the real
# English dish name returns candidates. Keys are whole normalized dish names, so a
# near miss (番茄炒鸡蛋, 意大利面) keeps the deterministic ingredient query instead of
# being folded into a different dish.
DISH_NAME_ENGLISH: dict[str, str] = {
    normalize_name("番茄炒蛋"): "chinese tomato and eggs",
    normalize_name("意大利肉酱面"): "spaghetti bolognese",
    normalize_name("鸡肉沙拉"): "chicken salad",
}


def dish_name_query(name: str) -> str | None:
    return DISH_NAME_ENGLISH.get(normalize_name(name))


def _phrase_pattern(phrase: str) -> re.Pattern:
    return re.compile(r"\b" + re.escape(phrase).replace(r"\ ", r"\s+") + r"(?:s|es)?\b")


_PATTERNS = {phrase: _phrase_pattern(phrase)
             for phrases in INGREDIENT_ENGLISH.values() for phrase in phrases}
for _, type_query, synonyms, extra in TYPE_RULES:
    _PATTERNS.setdefault(type_query, _phrase_pattern(type_query))
    for phrase in (*synonyms, *extra):
        _PATTERNS.setdefault(phrase, _phrase_pattern(phrase))
for phrases in METHOD_EVIDENCE.values():
    for phrase in phrases:
        _PATTERNS.setdefault(phrase, _phrase_pattern(phrase))
for phrase in (*COMBO_MARKERS, *(phrase for phrase, _ in FORM_MARKERS),
               "fried", "crispy", "raw", "sashimi"):
    _PATTERNS.setdefault(phrase, _phrase_pattern(phrase))
for phrase in DISH_NAME_ENGLISH.values():
    _PATTERNS.setdefault(phrase, _phrase_pattern(phrase))


def _hit(text: str, phrase: str) -> bool:
    return _PATTERNS[phrase].search(text) is not None


def _any_hit(text: str, phrases: tuple[str, ...]) -> bool:
    return any(_hit(text, phrase) for phrase in phrases)


def main_ingredient_ids(dish: "PhotoDish") -> list[str]:
    seen = []
    for key in dish.ingredientIds:
        if BY_ID[key].role == "main" and key in INGREDIENT_ENGLISH and key not in seen:
            seen.append(key)
    return seen


def dish_type(name: str) -> tuple[str | None, tuple[str, ...], tuple[str, ...]]:
    for marker, query, synonyms, extra in TYPE_RULES:
        if marker in name:
            return query, synonyms, extra
    return None, (), ()


def dish_method(name: str) -> str | None:
    for marker, _ in METHOD_RULES:
        if marker in name:
            return marker
    return None


def _query_tokens(mains: list[str], method: str | None, type_query: str | None, *, with_method: bool) -> list[str]:
    words: list[str] = [INGREDIENT_ENGLISH[key][0] for key in mains[:2]]
    if with_method and method and not (type_query and method == "炒"):
        words.append(METHOD_QUERIES[method])
    if type_query:
        words.append(type_query)
    tokens: list[str] = []
    for word in words:
        for token in word.split():
            if token not in tokens:
                tokens.append(token)
    return tokens


def build_queries(dish: "PhotoDish") -> list[tuple[str, bool]]:
    """(English query, strict-evidence) layers: exact first, then one broader retry.

    A catalogued dish name is already the broadest useful query, so it is searched
    alone: appending the ingredient concatenation would only re-open the candidate
    pool that produced a wrong breakfast-platter photo for 番茄炒蛋.

    Otherwise Openverse ANDs every term over mostly-English metadata, so 3+ main
    ingredients or a Chinese-name query empirically return zero results and only
    burn the anonymous quota; mains stay capped at two. The single fallback drops
    the cooking-method term to widen recall, and is therefore scored with the strict
    evidence gate so that extra recall never becomes extra mistakes.
    """
    english = dish_name_query(dish.name)
    if english:
        return [(english, False)]
    mains = main_ingredient_ids(dish)
    if not mains:
        return []
    type_query, _, _ = dish_type(dish.name)
    method = dish_method(dish.name)
    exact = _query_tokens(mains, method, type_query, with_method=True)
    if not exact:
        return []
    layers: list[tuple[str, bool]] = [(" ".join(exact), False)]
    broad = _query_tokens(mains, method, type_query, with_method=False)
    if broad and broad != exact:
        layers.append((" ".join(broad), True))
    return layers


def _evidence(photo: dict) -> tuple[str, list[str]]:
    title = photo.get("title")
    title = title if isinstance(title, str) else ""
    names: list[str] = []
    tags = photo.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, dict) and isinstance(tag.get("name"), str):
                names.append(tag["name"])
    text = re.sub(r"\s+", " ", (title + " " + " ".join(names)).lower().replace("-", " ").replace("_", " "))
    # Some providers concatenate tag words ("stirfriedtomatoesandscrambledeggs1").
    long_tags = [name.lower() for name in names if len(name) >= 12 and " " not in name]
    return text, long_tags


def _evidence_hit(text: str, long_tags: list[str], phrases: tuple[str, ...]) -> bool:
    if _any_hit(text, phrases):
        return True
    return any(len(phrase) >= 4 and (phrase in tag or phrase.replace(" ", "") in tag)
               for tag in long_tags for phrase in phrases)


def _combo_conflict(dish: "PhotoDish", text: str, long_tags: list[str]) -> bool:
    if any(marker in dish.name for marker in COMBO_NAME_MARKERS):
        return False
    return _evidence_hit(text, long_tags, COMBO_MARKERS)


def _form_conflict(dish: "PhotoDish", text: str, long_tags: list[str]) -> str | None:
    for phrase, markers in FORM_MARKERS:
        if any(marker in dish.name for marker in markers):
            continue
        if _evidence_hit(text, long_tags, (phrase,)):
            return phrase
    return None


def evaluate_photo(photo: dict, dish: "PhotoDish", strict: bool = False) -> tuple[bool, str]:
    """Composite keyword scoring; never accept on rank alone, reject clear conflicts.

    Ingredient words alone are not enough: a candidate needs cooking or dish-type
    evidence, the catalogued English dish name, or every main ingredient.
    Spread/sandwich photos and photos of a different dish form (fried rice for a
    plain stir-fry) are rejected outright. `strict` is the broadened fallback
    layer's tighter rule: that query lost its method word, so only cooking or
    dish-type evidence counts, plus at least two main ingredients. The acceptance
    threshold itself never moves.
    """
    width, height = photo.get("width"), photo.get("height")
    if type(width) is not int or type(height) is not int or width < 600 or height < 400:
        return False, "too small or dimensions missing"
    text, long_tags = _evidence(photo)
    mains = main_ingredient_ids(dish)
    if not mains:
        return False, "dish has no catalogued main ingredient"
    hits = sum(1 for key in mains if _evidence_hit(text, long_tags, INGREDIENT_ENGLISH[key]))
    if hits == 0:
        return False, "no main-ingredient evidence in title/tags"
    if _combo_conflict(dish, text, long_tags):
        return False, "photo shows a mixed spread or hand-held dish, not this recipe"
    form = _form_conflict(dish, text, long_tags)
    if form:
        return False, f"photo evidences a {form}, but the dish name declares no such form"
    method = dish_method(dish.name)
    if method in GENTLE_METHODS and _evidence_hit(text, long_tags, ("fried", "crispy")):
        return False, f"cooking conflict: {method} vs fried/crispy evidence"
    if "沙拉" in dish.name and _evidence_hit(text, long_tags, ("fried",)):
        return False, "cooking conflict: salad vs fried evidence"
    if method in {"炸", "烤"} and _evidence_hit(text, long_tags, ("raw", "sashimi")):
        return False, f"cooking conflict: {method} vs raw/sashimi evidence"

    type_query, type_synonyms, type_extra = dish_type(dish.name)
    type_evidence = (bool(type_synonyms) and _evidence_hit(text, long_tags, type_synonyms)
                     and all(_evidence_hit(text, long_tags, (phrase,)) for phrase in type_extra))
    method_evidence = bool(method) and _evidence_hit(text, long_tags, METHOD_EVIDENCE[method])
    english_name = dish_name_query(dish.name)
    name_evidence = bool(english_name) and _evidence_hit(text, long_tags, (english_name,))
    if strict:
        if not (method_evidence or type_evidence):
            return False, "fallback needs cooking or dish-type evidence, not ingredient words alone"
        if hits < min(2, len(mains)):
            return False, "fallback needs evidence for at least two main ingredients"
    elif not (method_evidence or type_evidence or name_evidence or hits == len(mains)):
        return False, "only part of the main ingredients is evidenced and no method, type or dish name backs it up"

    score = 2 * hits
    if type_evidence:
        score += 3
    if method_evidence:
        score += 2
    if (normalize_name(dish.name) in text.replace(" ", "") or name_evidence
            or (type_query and _evidence_hit(text, long_tags, (type_query,)))):
        score += 3
    if score < 4:
        return False, f"keyword evidence too weak (score {score} < 4)"
    return True, "accepted"


def acceptable_photo(photo: dict, dish: "PhotoDish", strict: bool = False) -> bool:
    return evaluate_photo(photo, dish, strict)[0]


def _https_url(value: object, host: str, prefix: str) -> str | None:
    if not isinstance(value, str) or len(value) > 2000 or "\\" in value or any(c.isspace() for c in value):
        return None
    try:
        url = urlsplit(value)
        _ = url.port
    except ValueError:
        return None
    if url.scheme != "https" or url.hostname != host or url.username is not None or url.password is not None or url.fragment:
        return None
    if not url.path.startswith(prefix):
        return None
    return value


def _open_https_url(value: object) -> str | None:
    """Strict HTTPS link validation without a host allowlist (landing/creator pages)."""
    if not isinstance(value, str) or len(value) > 2000 or "\\" in value or any(c.isspace() for c in value):
        return None
    try:
        url = urlsplit(value)
        _ = url.port
    except ValueError:
        return None
    if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None or url.fragment:
        return None
    return value


def _clean_text(value: object, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = "".join(char for char in value.strip() if char.isprintable())
    return value[:limit] if value else None


def _license_label(code: str, version: object) -> str:
    if not isinstance(version, str) or not re.fullmatch(r"[0-9.]{1,8}", version):
        version = "4.0" if code == "by" else "1.0"
    return {"cc0": f"CC0 {version}", "pdm": f"Public Domain Mark {version}", "by": f"CC BY {version}"}[code]


class DishPhoto(BaseModel):
    url: str
    alt: str
    photographer: str
    photographerUrl: str
    pageUrl: str
    width: int
    height: int
    license: str
    licenseUrl: str
    source: Literal["openverse"] = "openverse"


def parse_photo(photo: dict, dish: "PhotoDish", strict: bool = False) -> DishPhoto | None:
    if not acceptable_photo(photo, dish, strict):
        return None
    if photo.get("category") != "photograph" or photo.get("mature") is True:
        return None
    code = photo.get("license")
    if code not in ALLOWED_LICENSES:
        return None
    license_url = _https_url(photo.get("license_url"), "creativecommons.org", "/")
    url = _https_url(photo.get("thumbnail"), "api.openverse.org", "/v1/images/")
    if not url or not url.endswith("/thumb/"):
        return None
    page = _open_https_url(photo.get("foreign_landing_url"))
    photographer = _clean_text(photo.get("creator"), 200)
    if not license_url or not page or not photographer:
        return None
    creator_url = _open_https_url(photo.get("creator_url"))
    alt = _clean_text(photo.get("title"), 300)
    if not alt:
        tags = photo.get("tags")
        names = [tag["name"] for tag in tags if isinstance(tag, dict) and isinstance(tag.get("name"), str)] if isinstance(tags, list) else []
        alt = _clean_text(", ".join(names[:8]), 300)
    if not alt:
        return None
    return DishPhoto(url=url, alt=alt, photographer=photographer, photographerUrl=creator_url or page,
                     pageUrl=page, width=photo["width"], height=photo["height"],
                     license=_license_label(code, photo.get("license_version")), licenseUrl=license_url)


class PhotoDish(StrictModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")]
    name: ShortText
    scene: Scene
    ingredientIds: list[Identifier] = Field(min_length=1, max_length=30)
    diningCategory: ShortText | None = None

    @model_validator(mode="after")
    def known_ingredients(self):
        if len(self.ingredientIds) != len(set(self.ingredientIds)) or any(key not in BY_ID for key in self.ingredientIds):
            raise ValueError("unknown or duplicate ingredient")
        return self


class PhotoMatchRequest(StrictModel):
    dishes: list[PhotoDish] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def unique_dishes(self):
        if len({dish.id for dish in self.dishes}) != len(self.dishes):
            raise ValueError("duplicate dish id")
        return self


class PhotoMatchResult(BaseModel):
    dishId: str
    photo: DishPhoto | None


class PhotoMatchResponse(BaseModel):
    configured: bool
    photos: list[PhotoMatchResult]


@dataclass
class _CacheEntry:
    expires: float
    photo: DishPhoto | None


class PhotoService:
    """Fail-soft photo matching: any upstream problem yields None, never an API error."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 clock=time.monotonic):
        self.settings = settings
        self.transport = transport
        self.clock = clock
        self.cache: dict[tuple, _CacheEntry] = {}
        self.hour_start = clock()
        self.hour_count = 0
        self.day_start = clock()
        self.day_count = 0
        self.ips: dict[str, list[float]] = {}
        self.slots = asyncio.Semaphore(2)

    def _signature(self, dish: PhotoDish) -> tuple:
        return normalize_name(dish.name), tuple(sorted(main_ingredient_ids(dish))), dish.scene

    def _cached(self, signature: tuple) -> tuple[bool, DishPhoto | None]:
        entry = self.cache.get(signature)
        if entry is None:
            return False, None
        if entry.expires <= self.clock():
            del self.cache[signature]
            return False, None
        return True, entry.photo

    def _store(self, signature: tuple, photo: DishPhoto | None):
        if len(self.cache) >= CACHE_MAX_ENTRIES:
            del self.cache[next(iter(self.cache))]
        self.cache[signature] = _CacheEntry(self.clock() + CACHE_TTL_SECONDS, photo)

    def _budget_left(self) -> bool:
        now = self.clock()
        if now - self.hour_start >= 3600:
            self.hour_start, self.hour_count = now, 0
        if now - self.day_start >= 86400:
            self.day_start, self.day_count = now, 0
        return self.hour_count < self.settings.photo_hourly_limit and self.day_count < self.settings.photo_daily_limit

    def _ip_allowed(self, ip: str) -> bool:
        now = self.clock()
        self.ips = {key: recent for key, values in self.ips.items()
                    if (recent := [value for value in values if value > now - 60])}
        if len(self.ips.get(ip, [])) >= PER_IP_PER_MINUTE:
            return False
        if ip not in self.ips and len(self.ips) >= MAX_IP_ENTRIES:
            return False
        self.ips.setdefault(ip, []).append(now)
        return True

    async def _search(self, query: str) -> list[dict] | None:
        """None means the upstream attempt failed; [] is a completed empty search."""
        self.hour_count += 1
        self.day_count += 1
        headers = {"User-Agent": USER_AGENT}
        if self.settings.photo_api_key:
            headers["Authorization"] = f"Bearer {self.settings.photo_api_key}"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.settings.photo_timeout_seconds, connect=min(5.0, self.settings.photo_timeout_seconds)),
                follow_redirects=False, trust_env=False, proxy=self.settings.photo_proxy or None,
                transport=self.transport or httpx.AsyncHTTPTransport(retries=0, trust_env=False),
            ) as client:
                response = await client.get(SEARCH_URL, params={"q": query, "page_size": 8, "page": 1,
                                                                 "license": "cc0,pdm,by", "category": "photograph"},
                                            headers=headers)
            if response.status_code == 429:
                self.hour_count = self.settings.photo_hourly_limit
                self.day_count = self.settings.photo_daily_limit
                return None
            if response.status_code != 200:
                return None
            data = response.json()
            photos = data.get("results") if isinstance(data, dict) else None
            parsed = [photo for photo in photos if isinstance(photo, dict)][:8] if isinstance(photos, list) else []
            logging.getLogger("uvicorn.error").info("Openverse search q=%r returned %d candidates", query, len(parsed))
            return parsed
        except (httpx.HTTPError, ValueError, UnicodeError):
            logging.getLogger(__name__).warning("Photo search unavailable; placeholder retained.")
            return None

    async def _match_one(self, dish: PhotoDish) -> DishPhoto | None:
        signature = self._signature(dish)
        hit, photo = self._cached(signature)
        if hit:
            return photo
        if not self._budget_left():
            return None
        result = None
        completed = False
        for query, strict in build_queries(dish):
            if not self._budget_left():
                break
            async with self.slots:
                photos = await self._search(query)
            if photos is None:
                # An upstream failure says nothing about relevance, so the broader
                # retry is skipped and the signature stays uncached.
                break
            completed = True
            for candidate in photos:
                result = parse_photo(candidate, dish, strict)
                if result:
                    break
            if photos and not result:
                logging.getLogger("uvicorn.error").info(
                    "Photo candidates rejected for %s (query=%r, strict=%s): %s", dish.name, query, strict,
                    [(c.get("title"), evaluate_photo(c, dish, strict)[1]) for c in photos])
            if result:
                break
        # Transient upstream failures stay uncached so a later attempt can retry.
        if completed or result:
            self._store(signature, result)
        return result

    async def match(self, dishes: list[PhotoDish], ip: str) -> PhotoMatchResponse:
        if not self.settings.photo_configured:
            return PhotoMatchResponse(configured=False, photos=[PhotoMatchResult(dishId=dish.id, photo=None) for dish in dishes])
        if not self._ip_allowed(ip):
            return PhotoMatchResponse(configured=True, photos=[PhotoMatchResult(dishId=dish.id, photo=None) for dish in dishes])
        by_signature: dict[tuple, list[PhotoDish]] = {}
        for dish in dishes:
            by_signature.setdefault(self._signature(dish), []).append(dish)
        matched = await asyncio.gather(*(self._match_one(group[0]) for group in by_signature.values()))
        resolved = {signature: photo for signature, photo in zip(by_signature, matched)}
        return PhotoMatchResponse(configured=True, photos=[
            PhotoMatchResult(dishId=dish.id, photo=resolved[self._signature(dish)]) for dish in dishes])