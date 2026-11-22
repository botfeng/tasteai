import asyncio
import builtins
import io
import logging
import os
import socket
from pathlib import Path

import httpx
import pytest

from app.main import create_app
from app.photos import (
    CACHE_MAX_ENTRIES,
    CACHE_TTL_SECONDS,
    PER_IP_PER_MINUTE,
    USER_AGENT,
    PhotoDish,
    PhotoService,
    acceptable_photo,
    build_queries,
    dish_name_query,
    evaluate_photo,
    parse_photo,
)
from app.settings import Settings

KEY = "a" * 56
SETTINGS = Settings(mode="mock")  # Openverse anonymous search needs no key.
KEYED = Settings(mode="mock", photo_api_key=KEY)
UNCONFIGURED = Settings(mode="mock", invalid_environment=True)
PHOTO_ID = "0e1c4e2a-0000-4000-8000-000000000001"


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    # Windows' internal wakeup socketpair must exist before application connections are blocked.
    loop = asyncio.SelectorEventLoop()
    monkeypatch.setattr(asyncio, "run", loop.run_until_complete)
    monkeypatch.setattr(os, "environ", {})

    def forbidden(*args, **kwargs):
        pytest.fail("Unexpected real transport, network or dotenv read")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "__init__", forbidden)
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    for module in (builtins, io):
        original = module.open

        def guarded(file, *args, _open=original, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                name = Path(os.fsdecode(file)).name
                if name == ".env" or name.startswith(".env."):
                    forbidden()
            return _open(file, *args, **kwargs)

        monkeypatch.setattr(module, "open", guarded)
    yield
    loop.close()


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def dish(name="番茄炒蛋", ids=("tomato", "egg"), dish_id="dish-1", scene="cook"):
    return PhotoDish(id=dish_id, name=name, scene=scene, ingredientIds=list(ids))


def layered_dish(**kwargs):
    # 番茄炒鸡蛋 is a whole-name miss in the dish-name dictionary, so it keeps both
    # query layers and exercises the broadened-retry rules unchanged.
    kwargs.setdefault("name", "番茄炒鸡蛋")
    return dish(**kwargs)


def openverse_photo(title="Stir fried tomato and egg", tags=(), photo_id=PHOTO_ID, width=1200, height=800, **overrides):
    photo = {
        "id": photo_id, "title": title,
        "tags": [{"name": name, "accuracy": 0.9} for name in tags],
        "creator": "Test Photographer",
        "creator_url": "https://www.flickr.com/people/test-photographer/",
        "license": "by", "license_version": "4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "foreign_landing_url": f"https://www.flickr.com/photos/test-photographer/{photo_id}/",
        "url": f"https://live.staticflickr.com/65535/{photo_id}_original.jpg",
        "thumbnail": f"https://api.openverse.org/v1/images/{photo_id}/thumb/",
        "category": "photograph", "width": width, "height": height,
        "mature": False, "provider": "flickr", "source": "flickr",
    }
    photo.update(overrides)
    return photo


def make_transport(respond):
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        return respond(request)

    return httpx.MockTransport(handler), calls


def photos_response(*photos):
    return httpx.Response(200, json={"result_count": len(photos), "page_count": 1,
                                     "page": 1, "page_size": 8, "results": list(photos)})


def service(respond, settings=SETTINGS, clock=None):
    transport, calls = make_transport(respond)
    return PhotoService(settings, transport=transport, clock=clock or Clock()), calls


def match(service, dishes, ip="127.0.0.1"):
    return asyncio.run(service.match(dishes, ip))


# --- Deterministic queries (no model involvement) ---


def test_queries_are_deterministic_english_only():
    queries = build_queries(dish(name="番茄鸡蛋炒饭", ids=("tomato", "egg", "cooked-rice")))
    assert queries == [("tomato egg fried rice", False)]


def test_fallback_query_drops_only_the_method_word():
    queries = build_queries(dish(name="番茄蘑菇鸡胸汤", ids=("tomato", "mushroom", "chicken-breast", "salt")))
    assert queries == [("tomato mushroom soup", False)]  # no method word, so no broadened retry
    queries = build_queries(dish(name="黄瓜蘑菇炒鸡片", ids=("cucumber", "mushroom", "chicken-breast", "salt")))
    assert queries == [("cucumber mushroom stir fry", False), ("cucumber mushroom", True)]


def test_query_caps_mains_at_two_and_never_uses_chinese():
    queries = build_queries(dish(name="番茄蘑菇鸡肉焖饭", ids=("tomato", "mushroom", "chicken-breast", "cooked-rice")))
    assert queries == [("tomato mushroom braised rice", False)]  # only the first two mains are searched
    queries = build_queries(dish(name="清蒸番茄蘑菇鳕鱼", ids=("cod", "tomato", "mushroom")))
    assert [query for query, _ in queries] == ["cod tomato steamed", "cod tomato"]
    assert all(query.isascii() for query, _ in queries)


def test_stir_fry_method_not_duplicated_for_fried_rice():
    queries = build_queries(dish(name="番茄炒饭", ids=("tomato", "cooked-rice")))
    assert queries[0][0] == "tomato rice fried"
    assert len(queries) == 1  # 炒饭 already carries "fried", so nothing is dropped


def test_gentle_method_kept_in_query():
    queries = build_queries(dish(name="清蒸鳕鱼", ids=("cod",)))
    assert queries == [("cod steamed", False), ("cod", True)]


def test_no_fallback_when_nothing_can_be_dropped():
    assert build_queries(dish(name="土豆泥", ids=("potato",))) == [("potato mashed", False)]
    assert build_queries(dish(name="黄瓜沙拉", ids=("cucumber",))) == [("cucumber salad", False)]


def test_queries_are_stable_across_calls():
    target = dish(name="番茄蘑菇鸡肉焖饭", ids=("tomato", "mushroom", "chicken-breast", "cooked-rice"))
    assert build_queries(target) == build_queries(target)


# --- Composite matching: keyword evidence, not rank and not visual recognition ---


def test_exact_match_is_accepted():
    photo = openverse_photo("Stir fried tomato and egg, a classic home style dish")
    assert acceptable_photo(photo, dish()) is True
    parsed = parse_photo(photo, dish())
    assert parsed is not None
    assert parsed.url == photo["thumbnail"]
    assert parsed.pageUrl == photo["foreign_landing_url"]
    assert parsed.photographerUrl == photo["creator_url"]
    assert parsed.photographer == "Test Photographer"
    assert parsed.license == "CC BY 4.0"
    assert parsed.licenseUrl == photo["license_url"]
    assert parsed.source == "openverse"


def test_plural_title_is_accepted():
    assert acceptable_photo(openverse_photo("Tomatoes with scrambled eggs"), dish()) is True


def test_partial_ingredient_with_type_evidence_accepted():
    # Not every main ingredient must appear; one main plus dish-type evidence is enough.
    target = dish(name="番茄蛋花汤", ids=("tomato", "egg"))
    assert acceptable_photo(openverse_photo("Tomato soup"), target) is True


def test_partial_ingredient_with_method_evidence_accepted():
    assert acceptable_photo(openverse_photo("Scrambled eggs"), dish()) is True


def test_single_main_without_other_evidence_rejected():
    assert acceptable_photo(openverse_photo("Fresh tomatoes on a table"), dish()) is False
    assert acceptable_photo(openverse_photo("Tomato soup"), dish()) is False  # soup is not 番茄炒蛋


def test_no_main_ingredient_rejected():
    assert acceptable_photo(openverse_photo("A beautiful mountain landscape"), dish()) is False


def test_concatenated_provider_tags_are_used_as_evidence():
    photo = openverse_photo("", tags=["stirfriedtomatoesandscrambledeggs1"],
                            license="pdm", license_version="1.0",
                            license_url="https://creativecommons.org/publicdomain/mark/1.0/")
    assert acceptable_photo(photo, dish()) is True
    parsed = parse_photo(photo, dish())
    assert parsed is not None
    assert parsed.license == "Public Domain Mark 1.0"


def test_tags_count_as_evidence():
    photo = openverse_photo("A homemade dish", tags=["tomato", "egg", "stir fry"])
    assert acceptable_photo(photo, dish()) is True


def test_rank_one_mismatch_is_skipped_for_later_match():
    first = openverse_photo("Steamed white rice", photo_id="first")
    second = openverse_photo("Stir fried tomato and egg", photo_id="second")
    svc, calls = service(lambda request: photos_response(first, second))
    response = match(svc, [dish()])
    assert response.photos[0].photo is not None
    assert response.photos[0].photo.url == second["thumbnail"]
    assert len(calls) == 1


def test_fried_rice_is_not_white_rice():
    target = dish(name="番茄鸡蛋炒饭", ids=("tomato", "egg", "cooked-rice"))
    assert acceptable_photo(openverse_photo("Steamed white rice in a bowl"), target) is False
    assert acceptable_photo(openverse_photo("Egg fried rice"), target) is True


def test_chicken_salad_is_not_fried_chicken():
    target = dish(name="鸡肉沙拉", ids=("chicken-breast", "lettuce"))
    assert acceptable_photo(openverse_photo("Crispy fried chicken strips"), target) is False
    assert acceptable_photo(openverse_photo("Fresh chicken salad with lettuce"), target) is True


def test_braised_rice_is_not_tomato_scrambled_eggs():
    target = dish(name="番茄蘑菇鸡肉焖饭", ids=("tomato", "mushroom", "chicken-breast", "cooked-rice"))
    assert acceptable_photo(openverse_photo("Tomato scrambled eggs"), target) is False


def test_soup_is_not_fried_wedges():
    target = dish(name="番茄蛋花汤", ids=("tomato", "egg"))
    assert acceptable_photo(openverse_photo("Fried potato wedges with ketchup"), target) is False
    assert acceptable_photo(openverse_photo("Tomato egg drop soup"), target) is True


def test_steamed_fish_rejects_deep_fried_photo():
    target = dish(name="清蒸鳕鱼", ids=("cod",))
    assert acceptable_photo(openverse_photo("Deep fried crispy cod fillet"), target) is False
    assert acceptable_photo(openverse_photo("Steamed cod with ginger"), target) is True


def test_fried_dish_rejects_raw_photo():
    target = dish(name="炸虾", ids=("shrimp",))
    assert acceptable_photo(openverse_photo("Raw shrimp sashimi"), target) is False


def test_mashed_potato_positive_match():
    target = dish(name="土豆泥", ids=("potato",))
    assert acceptable_photo(openverse_photo("Creamy mashed potatoes"), target) is True


# --- Broadened fallback layer: more recall, never less precision ---


def test_fallback_never_accepts_on_ingredient_words_alone():
    photo = openverse_photo("Tomato and egg in a bowl", tags=["tomato", "egg"])
    assert acceptable_photo(photo, dish(), True) is False
    assert evaluate_photo(photo, dish(), True)[1].startswith("fallback needs cooking")
    assert acceptable_photo(openverse_photo("Stir fried tomato with eggs"), dish(), True) is True


def test_dish_form_conflicts_are_rejected():
    rice_photo = openverse_photo("Shrimp fried rice", tags=["shrimp", "rice", "fried"])
    accepted, reason = evaluate_photo(rice_photo, dish(name="炸虾", ids=("shrimp",)))
    assert accepted is False and "fried rice" in reason
    assert acceptable_photo(rice_photo, dish(name="虾仁炒饭", ids=("shrimp", "cooked-rice"))) is True
    pasta_photo = openverse_photo("Beef pasta with tomato sauce", tags=["beef", "pasta", "tomato", "sauce"])
    assert acceptable_photo(pasta_photo, dish(name="番茄炖牛肉", ids=("tomato", "beef"))) is False
    assert acceptable_photo(pasta_photo, dish(name="意大利肉酱面", ids=("spaghetti", "beef", "tomato"))) is True


def test_fallback_requires_evidence_for_two_main_ingredients():
    assert acceptable_photo(openverse_photo("Stir fried eggs"), dish()) is True
    assert acceptable_photo(openverse_photo("Stir fried eggs"), dish(), True) is False


def test_broadened_retry_can_supply_the_match_when_exact_search_is_empty():
    good = openverse_photo("Stir fried tomato and egg", photo_id="good")

    def respond(request):
        return photos_response() if request.url.params["q"].endswith("stir fry") else photos_response(good)

    svc, calls = service(respond)
    photo = match(svc, [layered_dish()]).photos[0].photo
    assert photo is not None and photo.url == good["thumbnail"]
    assert [request.url.params["q"] for request in calls] == ["tomato egg stir fry", "tomato egg"]


def test_broadened_retry_runs_when_every_exact_candidate_is_rejected():
    platter = openverse_photo("Protein Platter", tags=["eggs", "tomatoes", "scrambledeggs"], photo_id="platter")
    good = openverse_photo("Home style stir fried tomatoes and eggs", photo_id="good")

    def respond(request):
        return photos_response(platter) if request.url.params["q"].endswith("stir fry") else photos_response(good)

    svc, calls = service(respond)
    photo = match(svc, [layered_dish()]).photos[0].photo
    assert photo is not None and photo.url == good["thumbnail"]
    assert len(calls) == 2


def test_fallback_scores_every_candidate_instead_of_taking_the_first():
    omelette = openverse_photo("Tomato and egg omelette", photo_id="first")
    right = openverse_photo("Stir fried tomato and egg", photo_id="second")

    def respond(request):
        return photos_response() if request.url.params["q"].endswith("stir fry") else photos_response(omelette, right)

    svc, calls = service(respond)
    photo = match(svc, [layered_dish()]).photos[0].photo
    assert photo is not None and photo.url == right["thumbnail"]
    assert len(calls) == 2


def test_upstream_failure_does_not_spend_the_retry():
    def broken(request):
        raise httpx.ConnectError("upstream down")

    svc, calls = service(broken)
    assert match(svc, [layered_dish()]).photos[0].photo is None
    assert [request.url.params["q"] for request in calls] == ["tomato egg stir fry"]


# --- Saved real Openverse candidates (q="tomato egg", 120 results, page 1) ---

REAL_PROTEIN_PLATTER = {
    "id": "88a456bd-b8c4-429d-ac48-9e377d10abbe", "title": "Protein Platter",
    "tags": [{"name": name} for name in ("america", "arugula", "bacon", "breakfast", "brunch", "california",
                                         "eggs", "food", "keto", "lowcarb", "meal", "protein", "sausage",
                                         "sausageemporium", "scrambledeggs", "sonoma", "sonomacounty",
                                         "sonomavalley", "tomatoes", "unitedstates", "usa")],
    "creator": "sarahstierch", "creator_url": "https://www.flickr.com/photos/7633518@N08",
    "license": "by", "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by/2.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/7633518@N08/52450174693",
    "url": "https://live.staticflickr.com/65535/52450174693_0583299171_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/88a456bd-b8c4-429d-ac48-9e377d10abbe/thumb/",
    "category": "photograph", "width": 1024, "height": 768, "mature": False, "provider": "flickr", "source": "flickr",
}
REAL_POOLSIDE_BRUNCH = {
    "id": "b19b3f10-0247-4fb5-8fda-1fa581902f6d",
    "title": "Poolside Brunch Photo-Op; + Delicious and Healthy Recipe...",
    "tags": [{"name": name} for name in ("booth", "brunch", "celery", "egg", "mayo", "olives", "onion",
                                         "openfacedtunaandeggsandwich", "recipe", "sandwich", "toast",
                                         "tomato", "tuna")],
    "creator": "Chic Bee", "creator_url": "https://www.flickr.com/photos/80454089@N00",
    "license": "by", "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by/2.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/80454089@N00/8077101684",
    "url": "https://live.staticflickr.com/8193/8077101684_e6d10c4c03_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/b19b3f10-0247-4fb5-8fda-1fa581902f6d/thumb/",
    "category": "photograph", "width": 1024, "height": 760, "mature": False, "provider": "flickr", "source": "flickr",
}
REAL_BLT_SANDWICH = {
    "id": "3b742879-c3fe-4c5d-904c-44db42f58a7d",
    "title": "BLT Sandwich - Apple wood smoked bacon, tomato, romaine sourdough with fried egg and avocado",
    "tags": [{"name": "american"}, {"name": "carmel"}],
    "creator": "City Foodsters", "creator_url": "https://www.flickr.com/photos/89060048@N03",
    "license": "by", "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by/2.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/89060048@N03/15957049139",
    "url": "https://live.staticflickr.com/7528/15957049139_dfaef8114d_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/3b742879-c3fe-4c5d-904c-44db42f58a7d/thumb/",
    "category": "photograph", "width": 1024, "height": 683, "mature": False, "provider": "flickr", "source": "flickr",
}
SAVED_REAL_CANDIDATES = (REAL_PROTEIN_PLATTER, REAL_POOLSIDE_BRUNCH, REAL_BLT_SANDWICH)


def test_saved_real_candidates_never_illustrate_tomato_scrambled_eggs():
    for photo in SAVED_REAL_CANDIDATES:
        for strict in (False, True):
            accepted, reason = evaluate_photo(photo, dish(), strict)
            assert accepted is False, (photo["title"], reason)
            assert parse_photo(photo, dish(), strict) is None


def test_real_breakfast_platter_rejected_even_with_scrambled_egg_tag():
    accepted, reason = evaluate_photo(REAL_PROTEIN_PLATTER, dish(), True)
    assert accepted is False
    assert "mixed spread" in reason


def test_real_platter_photo_still_illustrates_a_platter_dish():
    platter = dish(name="西式早餐拼盘", ids=("egg", "tomato"))
    assert evaluate_photo(REAL_PROTEIN_PLATTER, platter, False)[0] is True
    parsed = parse_photo(REAL_PROTEIN_PLATTER, platter)
    assert parsed is not None and parsed.photographer == "sarahstierch"
    assert parsed.license == "CC BY 2.0"


def test_combo_guard_keeps_matching_a_plain_stir_fry():
    assert acceptable_photo(openverse_photo("Stir fried tomato and egg over rice"), dish()) is True


# --- Dish-name dictionary: search terms only, whole normalized name, never a photo ---


def test_dictionary_supplies_the_canonical_english_dish_name():
    assert build_queries(dish()) == [("chinese tomato and eggs", False)]
    assert build_queries(dish(name="意大利肉酱面", ids=("spaghetti", "beef", "tomato", "onion"))) == [
        ("spaghetti bolognese", False)]
    assert build_queries(dish(name="鸡肉沙拉", ids=("chicken-breast", "lettuce", "cucumber"))) == [
        ("chicken salad", False)]


def test_dictionary_matches_whole_normalized_names_only():
    assert dish_name_query("番茄 炒蛋") == "chinese tomato and eggs"
    for name in ("番茄炒鸡蛋", "番茄鸡蛋炒饭", "番茄炒蛋家常版", "意大利面", "鸡肉沙拉卷", "炸虾"):
        assert dish_name_query(name) is None
    assert build_queries(dish(name="番茄炒鸡蛋")) == [("tomato egg stir fry", False), ("tomato egg", True)]
    assert build_queries(dish(name="意大利面", ids=("spaghetti", "tomato"))) == [("spaghetti tomato noodles", False)]


def test_dictionary_dish_searches_once_and_still_keeps_placeholder_on_mismatch():
    svc, calls = service(lambda request: photos_response(openverse_photo("Steamed white rice")))
    assert match(svc, [dish()]).photos[0].photo is None
    assert [request.url.params["q"] for request in calls] == ["chinese tomato and eggs"]


# --- Category synonyms are alternatives; extra category words stay mandatory ---


def test_category_synonyms_are_alternatives_not_conjunctions():
    congee = dish(name="皮蛋瘦肉粥", ids=("cooked-rice", "egg"))
    assert acceptable_photo(openverse_photo("Congee", tags=["congee", "rice"]), congee) is True
    assert acceptable_photo(openverse_photo("Rice porridge", tags=["porridge", "rice"]), congee) is True
    pancake = dish(name="鸡蛋饼", ids=("egg", "flour"))
    assert acceptable_photo(openverse_photo("Egg pancake", tags=["pancake", "egg"]), pancake) is True
    assert acceptable_photo(openverse_photo("Egg fritter", tags=["fritter", "egg"]), pancake) is True


def test_extra_category_words_stay_mandatory():
    fried_rice = dish(name="蛋炒饭", ids=("egg", "cooked-rice"))
    assert acceptable_photo(openverse_photo("Fried rice", tags=["rice", "fried"]), fried_rice) is True
    assert acceptable_photo(openverse_photo("Steamed rice", tags=["rice", "steamed"]), fried_rice) is False


# --- Saved real candidates from the three authorized Day-4 searches ---

REAL_USDA_TOMATO_EGGS = {
    "id": "6c2790c0-2303-48b4-b2a7-d33fc2a6d7d6", "title": "20241025-USDA-FNS-UNK-0083",
    "tags": [{"name": "stirfriedtomatoesandscrambledeggs1"}],
    "creator": "USDAgov", "creator_url": "https://www.flickr.com/photos/41284017@N08",
    "license": "pdm", "license_version": "1.0",
    "license_url": "https://creativecommons.org/publicdomain/mark/1.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/41284017@N08/54092966601",
    "url": "https://live.staticflickr.com/65535/54092966601_83ce82e335_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/6c2790c0-2303-48b4-b2a7-d33fc2a6d7d6/thumb/",
    "category": "photograph", "width": 1024, "height": 768, "mature": False,
    "provider": "flickr", "source": "flickr",
}
REAL_PORK_SPAGHETTI = {
    "id": "b89ac341-188a-42d8-b3bf-70591fcb6ecf", "title": "Spaghetti",
    "tags": [{"name": name} for name in ("bolognesesauce", "food", "mincedpork", "spaghetti")],
    "creator": "chooyutshing", "creator_url": "https://www.flickr.com/photos/25802865@N08",
    "license": "pdm", "license_version": "1.0",
    "license_url": "https://creativecommons.org/publicdomain/mark/1.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/25802865@N08/55315013693",
    "url": "https://live.staticflickr.com/65535/55315013693_6be4d1ea11_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/b89ac341-188a-42d8-b3bf-70591fcb6ecf/thumb/",
    "category": "photograph", "width": 1024, "height": 683, "mature": False,
    "provider": "flickr", "source": "flickr",
}
REAL_AMERICAN_ROOTS_BREAKFAST = {
    "id": "52a58fe1-7e2c-4d4e-8ba3-c20af6925141",
    "title": "American Roots Breakfast (soft scrambled eggs, thick cut house bacon, "
             "crispy potatoes, grits & tomato jam)",
    "tags": [{"name": name} for name in ("bacon", "breakfast", "brunch", "eggs", "food", "grits",
                                         "meal", "potatoes", "scrambledeggs", "tomatojam")],
    "creator": "sarahstierch", "creator_url": "https://www.flickr.com/photos/7633518@N08",
    "license": "by", "license_version": "2.0", "license_url": "https://creativecommons.org/licenses/by/2.0/",
    "foreign_landing_url": "https://www.flickr.com/photos/7633518@N08/52144470531",
    "url": "https://live.staticflickr.com/65535/52144470531_681d096c93_b.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/52a58fe1-7e2c-4d4e-8ba3-c20af6925141/thumb/",
    "category": "photograph", "width": 1024, "height": 768, "mature": False,
    "provider": "flickr", "source": "flickr",
}
REAL_UNATTRIBUTED_CHICKEN_SALAD = {
    "id": "b6c6152d-d4f6-4893-810b-677031fc606f", "title": "Chicken Salad",
    "tags": [{"name": name} for name in ("dish", "food", "health food", "photo", "plant", "salad")],
    "creator": None, "creator_url": None,
    "license": "cc0", "license_version": "1.0",
    "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
    "foreign_landing_url": "https://www.rawpixel.com/image/5969607/chicken-salad",
    "url": "https://images.rawpixel.com/editor_1024/chicken-salad.jpg",
    "thumbnail": "https://api.openverse.org/v1/images/b6c6152d-d4f6-4893-810b-677031fc606f/thumb/",
    "category": "photograph", "width": 5000, "height": 3333, "mature": False,
    "provider": "rawpixel", "source": "rawpixel",
}


def test_real_usda_tomato_and_eggs_candidate_is_accepted_with_attribution():
    parsed = parse_photo(REAL_USDA_TOMATO_EGGS, dish())
    assert parsed is not None
    assert parsed.photographer == "USDAgov"
    assert parsed.license == "Public Domain Mark 1.0"
    assert parsed.url == REAL_USDA_TOMATO_EGGS["thumbnail"]


def test_english_dish_name_rescues_pasta_that_never_says_noodle():
    bolognese = dish(name="意大利肉酱面", ids=("spaghetti", "beef", "tomato", "onion"))
    photo = openverse_photo("Spaghetti Bolognese", tags=["food", "spaghettibolognese"],
                            license="pdm", license_version="1.0",
                            license_url="https://creativecommons.org/publicdomain/mark/1.0/")
    assert acceptable_photo(photo, bolognese) is True
    assert parse_photo(photo, bolognese) is not None
    # A pork mince variant and a sauce-only photo are not this beef recipe.
    assert acceptable_photo(REAL_PORK_SPAGHETTI, bolognese) is False
    assert acceptable_photo(openverse_photo("bolognese pt.1", tags=["food", "mozarella", "spaghetti"]),
                            bolognese) is False


def test_dish_name_evidence_does_not_loosen_the_strict_fallback():
    bolognese = dish(name="意大利肉酱面", ids=("spaghetti", "beef", "tomato", "onion"))
    photo = openverse_photo("Spaghetti Bolognese")
    assert acceptable_photo(photo, bolognese) is True
    assert acceptable_photo(photo, bolognese, True) is False
    assert evaluate_photo(photo, bolognese, True)[1].startswith("fallback needs cooking")


def test_unattributed_candidate_passes_scoring_but_never_the_dto():
    salad = dish(name="鸡肉沙拉", ids=("chicken-breast", "lettuce", "cucumber"))
    assert acceptable_photo(REAL_UNATTRIBUTED_CHICKEN_SALAD, salad) is True
    assert parse_photo(REAL_UNATTRIBUTED_CHICKEN_SALAD, salad) is None


def test_breakfast_spread_stays_rejected_and_the_dictionary_narrows_the_pool():
    assert acceptable_photo(REAL_PROTEIN_PLATTER, dish()) is False
    assert build_queries(dish()) == [("chinese tomato and eggs", False)]


def test_multi_component_breakfast_is_a_known_keyword_limit():
    # Characterization, not a success claim: this photo really does contain scrambled
    # eggs and tomato, so ingredient+method evidence accepts it. It came from the old
    # "tomato egg" query, which 番茄炒蛋 no longer searches. Telling a breakfast spread
    # from one recipe needs visual confirmation, not another keyword guard.
    assert acceptable_photo(REAL_AMERICAN_ROOTS_BREAKFAST, dish()) is True
    assert acceptable_photo(REAL_AMERICAN_ROOTS_BREAKFAST, dish(), True) is True


def test_shrimp_cakes_are_a_known_vision_level_gap():
    # 炸虾 is outside the dictionary and unchanged: a shrimp cake still scores as fried
    # shrimp, while a different dish form (fried rice) is still rejected outright.
    shrimp = dish(name="炸虾", ids=("shrimp",))
    assert acceptable_photo(openverse_photo("Pan Fried Shrimp Cakes", tags=["shrimp", "fried"]), shrimp) is True
    assert acceptable_photo(openverse_photo("Shrimp fried rice", tags=["shrimp", "rice", "fried"]), shrimp) is False
    assert acceptable_photo(openverse_photo("Raw shrimp sashimi"), shrimp) is False


def test_missing_evidence_or_small_photos_rejected():
    assert acceptable_photo(openverse_photo("", tags=()), dish()) is False
    assert acceptable_photo(openverse_photo(None), dish()) is False
    assert acceptable_photo(openverse_photo("Tomato egg", width=500), dish()) is False
    assert acceptable_photo(openverse_photo("Tomato egg", height=300), dish()) is False
    assert acceptable_photo(openverse_photo("Tomato egg", width="1200"), dish()) is False


# --- License allowlist and attribution ---


def test_restrictive_licenses_rejected():
    for code in ("by-nc", "by-nd", "by-sa", "by-nc-sa", None, "unknown"):
        assert parse_photo(openverse_photo(license=code), dish()) is None


def test_cc0_and_pdm_accepted_with_labels():
    cc0 = parse_photo(openverse_photo(license="cc0", license_version="1.0",
                                      license_url="https://creativecommons.org/publicdomain/zero/1.0/"), dish())
    assert cc0 is not None and cc0.license == "CC0 1.0"
    pdm = parse_photo(openverse_photo(license="pdm", license_version="1.0",
                                      license_url="https://creativecommons.org/publicdomain/mark/1.0/"), dish())
    assert pdm is not None and pdm.license == "Public Domain Mark 1.0"


def test_license_version_falls_back_when_missing_or_invalid():
    assert parse_photo(openverse_photo(license_version=None), dish()).license == "CC BY 4.0"
    assert parse_photo(openverse_photo(license_version="evil"), dish()).license == "CC BY 4.0"
    assert parse_photo(openverse_photo(license="cc0", license_version=None,
                                       license_url="https://creativecommons.org/publicdomain/zero/1.0/"), dish()).license == "CC0 1.0"


def test_license_url_must_be_https_creativecommons():
    assert parse_photo(openverse_photo(license_url=None), dish()) is None
    assert parse_photo(openverse_photo(license_url="https://evil.example/licenses/by/4.0/"), dish()) is None
    assert parse_photo(openverse_photo(license_url="http://creativecommons.org/licenses/by/4.0/"), dish()) is None


def test_creator_required_and_creator_url_optional():
    assert parse_photo(openverse_photo(creator=""), dish()) is None
    assert parse_photo(openverse_photo(creator="   "), dish()) is None
    assert parse_photo(openverse_photo(creator=None), dish()) is None
    base = openverse_photo()
    fallback = parse_photo({**base, "creator_url": None}, dish())
    assert fallback is not None and fallback.photographerUrl == base["foreign_landing_url"]
    http_creator = parse_photo({**base, "creator_url": "http://www.flickr.com/people/x/"}, dish())
    assert http_creator is not None and http_creator.photographerUrl == base["foreign_landing_url"]


def test_alt_falls_back_to_tags_when_title_empty():
    photo = openverse_photo("", tags=["tomato", "egg", "stir fry"])
    parsed = parse_photo(photo, dish())
    assert parsed is not None
    assert parsed.alt == "tomato, egg, stir fry"


def test_non_photograph_or_mature_rejected():
    assert parse_photo(openverse_photo(category="illustration"), dish()) is None
    assert parse_photo(openverse_photo(mature=True), dish()) is None


# --- URL whitelist and parsing ---


def test_display_url_must_be_openverse_thumbnail():
    base = openverse_photo()
    assert parse_photo({**base, "thumbnail": "https://evil.example/x/thumb/"}, dish()) is None
    assert parse_photo({**base, "thumbnail": "http://api.openverse.org/v1/images/x/thumb/"}, dish()) is None
    assert parse_photo({**base, "thumbnail": "https://api.openverse.org/v1/images/x/thumb"}, dish()) is None
    assert parse_photo({**base, "thumbnail": "https://api.openverse.org/v1/audio/x/thumb/"}, dish()) is None
    assert parse_photo({**base, "thumbnail": None}, dish()) is None


def test_original_url_field_is_never_used_as_display():
    parsed = parse_photo(openverse_photo(url="https://evil.example/huge-original.jpg"), dish())
    assert parsed is not None
    assert parsed.url == f"https://api.openverse.org/v1/images/{PHOTO_ID}/thumb/"


def test_landing_page_allows_any_https_host_but_not_http():
    commons = "https://commons.wikimedia.org/wiki/File:Tomato_eggs.jpg"
    parsed = parse_photo(openverse_photo(foreign_landing_url=commons), dish())
    assert parsed is not None and parsed.pageUrl == commons
    assert parse_photo(openverse_photo(foreign_landing_url="http://www.flickr.com/photos/x/1/"), dish()) is None
    assert parse_photo(openverse_photo(foreign_landing_url=None), dish()) is None


def test_credential_fragment_and_whitespace_urls_rejected():
    base = openverse_photo()
    assert parse_photo({**base, "foreign_landing_url": "https://user:pass@flickr.com/x/"}, dish()) is None
    assert parse_photo({**base, "foreign_landing_url": "https://flickr.com/x/#frag"}, dish()) is None
    assert parse_photo({**base, "foreign_landing_url": "https://flickr.com/x /"}, dish()) is None
    assert parse_photo({**base, "foreign_landing_url": "https://flickr.com\\x/"}, dish()) is None
    assert parse_photo({**base, "thumbnail": "https://api.openverse.org/v1/images/x /thumb/"}, dish()) is None


# --- Fail-soft service behavior ---


def test_unconfigured_service_makes_no_request():
    svc, calls = service(lambda request: pytest.fail("HTTP called while unconfigured"), settings=UNCONFIGURED)
    response = match(svc, [dish()])
    assert response.configured is False
    assert response.photos[0].photo is None
    assert calls == []


def test_anonymous_request_shape_end_to_end():
    photo = openverse_photo()
    svc, calls = service(lambda request: photos_response(photo))
    response = match(svc, [layered_dish()])
    assert response.configured is True
    result = response.photos[0]
    assert result.dishId == "dish-1"
    assert result.photo is not None
    assert result.photo.url == photo["thumbnail"]
    assert len(calls) == 1
    assert calls[0].url.host == "api.openverse.org"
    assert calls[0].url.path == "/v1/images/"
    assert calls[0].url.params["q"] == "tomato egg stir fry"
    assert calls[0].url.params["page_size"] == "8"
    assert calls[0].url.params["page"] == "1"
    assert calls[0].url.params["license"] == "cc0,pdm,by"
    assert calls[0].url.params["category"] == "photograph"
    assert "Authorization" not in calls[0].headers
    assert calls[0].headers["User-Agent"] == USER_AGENT


def test_optional_key_adds_bearer_header():
    svc, calls = service(lambda request: photos_response(openverse_photo()), settings=KEYED)
    match(svc, [dish()])
    assert calls[0].headers["Authorization"] == f"Bearer {KEY}"


def test_mismatch_keeps_placeholder_end_to_end():
    svc, calls = service(lambda request: photos_response(openverse_photo("Steamed white rice")))
    response = match(svc, [layered_dish()])
    assert response.photos[0].photo is None
    assert [request.url.params["q"] for request in calls] == ["tomato egg stir fry", "tomato egg"]


def test_batch_deduplicates_identical_signatures():
    photo = openverse_photo()
    svc, calls = service(lambda request: photos_response(photo))
    response = match(svc, [dish(dish_id="a"), dish(dish_id="b")])
    assert len(calls) == 1
    assert [item.dishId for item in response.photos] == ["a", "b"]
    assert response.photos[0].photo == response.photos[1].photo


def test_repeat_search_uses_cache_without_http():
    photo = openverse_photo()
    svc, calls = service(lambda request: photos_response(photo))
    match(svc, [dish()])
    response = match(svc, [dish(dish_id="later")])
    assert response.photos[0].photo is not None
    assert len(calls) == 1


def test_completed_empty_search_is_negative_cached():
    svc, calls = service(lambda request: photos_response())
    assert match(svc, [layered_dish()]).photos[0].photo is None
    assert len(calls) == 2  # exact search, then the single broadened retry
    assert match(svc, [layered_dish(dish_id="later")]).photos[0].photo is None
    assert len(calls) == 2


def test_transient_failure_is_not_cached_and_can_retry():
    def broken(request):
        raise httpx.ConnectError("upstream down")

    svc, calls = service(broken)
    assert match(svc, [layered_dish()]).photos[0].photo is None
    assert len(calls) == 1  # an upstream failure is not a relevance signal, so no broadened retry
    assert match(svc, [layered_dish()]).photos[0].photo is None
    assert len(calls) == 2


def test_timeout_and_http_errors_are_soft():
    for failure in (lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
                    lambda request: httpx.Response(500),
                    lambda request: httpx.Response(403, json={"detail": "blocked"})):
        svc, _ = service(failure)
        response = match(svc, [dish()])
        assert response.configured is True
        assert response.photos[0].photo is None


def test_429_exhausts_hourly_and_daily_budgets():
    clock = Clock()
    svc, calls = service(lambda request: httpx.Response(429), clock=clock)
    assert match(svc, [dish()]).photos[0].photo is None
    assert len(calls) == 1
    assert match(svc, [dish(dish_id="other", name="黄瓜沙拉", ids=("cucumber",))]).photos[0].photo is None
    assert len(calls) == 1
    clock.now += 86400
    svc2, calls2 = service(lambda request: photos_response(), clock=clock)
    match(svc2, [dish(dish_id="third", name="土豆泥", ids=("potato",))])
    assert len(calls2) == 1


def test_hourly_budget_limits_requests_and_resets_after_an_hour():
    clock = Clock()
    settings = Settings(mode="mock", photo_hourly_limit=2)
    svc, calls = service(lambda request: photos_response(), settings=settings, clock=clock)
    match(svc, [layered_dish()])
    assert len(calls) == 2  # exact search plus one broadened retry spend the whole hour
    match(svc, [dish(dish_id="other", name="黄瓜沙拉", ids=("cucumber",))])
    assert len(calls) == 2
    match(svc, [dish(dish_id="third", name="土豆泥", ids=("potato",))])
    assert len(calls) == 2
    clock.now += 3600
    match(svc, [dish(dish_id="third", name="土豆泥", ids=("potato",))])
    assert len(calls) == 3


def test_daily_budget_limits_requests_and_resets_after_a_day():
    clock = Clock()
    settings = Settings(mode="mock", photo_daily_limit=3)
    svc, calls = service(lambda request: photos_response(), settings=settings, clock=clock)
    match(svc, [layered_dish()])
    assert len(calls) == 2
    match(svc, [dish(dish_id="other", name="黄瓜沙拉", ids=("cucumber",))])
    assert len(calls) == 3
    match(svc, [dish(dish_id="third", name="土豆泥", ids=("potato",))])
    assert len(calls) == 3
    match(svc, [dish(dish_id="fourth", name="清蒸鳕鱼", ids=("cod",))])
    assert len(calls) == 3
    clock.now += 86400
    match(svc, [dish(dish_id="fourth", name="清蒸鳕鱼", ids=("cod",))])
    assert len(calls) == 5  # a fresh day spends two searches on the steamed-cod dish


def test_per_ip_minute_cap_blocks_without_error():
    clock = Clock()

    def respond(request):
        if "potato" in request.url.params["q"]:
            return photos_response(openverse_photo("Creamy mashed potatoes", photo_id="potato"))
        return photos_response(openverse_photo())

    svc, calls = service(respond, clock=clock)
    for _ in range(PER_IP_PER_MINUTE):
        assert match(svc, [dish()]).photos[0].photo is not None
    blocked = match(svc, [dish(dish_id="new", name="土豆泥", ids=("potato",))])
    assert blocked.configured is True
    assert blocked.photos[0].photo is None
    assert len(calls) == 1
    clock.now += 61
    assert match(svc, [dish(dish_id="new", name="土豆泥", ids=("potato",))]).photos[0].photo is not None


def test_cache_expires_after_ttl():
    clock = Clock()
    photo = openverse_photo()
    svc, calls = service(lambda request: photos_response(photo), clock=clock)
    match(svc, [dish()])
    clock.now += CACHE_TTL_SECONDS + 1
    match(svc, [dish()])
    assert len(calls) == 2


def test_cache_evicts_oldest_at_capacity():
    svc, _ = service(lambda request: photos_response())
    for index in range(CACHE_MAX_ENTRIES):
        svc._store((f"sig-{index}",), None)
    svc._store(("sig-new",), None)
    assert len(svc.cache) == CACHE_MAX_ENTRIES
    assert ("sig-0",) not in svc.cache
    assert ("sig-new",) in svc.cache


def test_mixed_batch_maps_results_by_dish_id():
    def respond(request):
        if "tomato" in request.url.params["q"]:
            return photos_response(openverse_photo())
        return photos_response()

    svc, _ = service(respond)
    response = match(svc, [dish(dish_id="a"), dish(dish_id="b", name="黄瓜沙拉", ids=("cucumber",))])
    assert [item.dishId for item in response.photos] == ["a", "b"]
    assert response.photos[0].photo is not None
    assert response.photos[1].photo is None


def test_api_key_never_leaks_to_response_repr_or_logs(caplog):
    def broken(request):
        raise httpx.ConnectError("upstream down")

    svc, _ = service(broken, settings=KEYED)
    with caplog.at_level(logging.WARNING, logger="app.photos"):
        response = match(svc, [dish()])
    assert KEY not in response.model_dump_json()
    assert KEY not in repr(KEYED)
    assert KEY not in caplog.text
    assert "Photo search unavailable" in caplog.text


# --- Settings isolation ---


def test_anonymous_photo_configured_without_key():
    assert Settings().photo_configured is True
    assert Settings(mode="disabled").photo_configured is True
    assert Settings(photo_api_key="").photo_configured is True


def test_photo_bounds_validation():
    assert Settings(photo_timeout_seconds=0).photo_configured is False
    assert Settings(photo_timeout_seconds=31).photo_configured is False
    assert Settings(photo_hourly_limit=0).photo_configured is False
    assert Settings(photo_hourly_limit=201).photo_configured is False
    assert Settings(photo_daily_limit=0).photo_configured is False
    assert Settings(photo_daily_limit=1001).photo_configured is False
    assert Settings(photo_api_key="bad key").photo_configured is False
    assert Settings(photo_api_key="a" * 32 + "\n").photo_configured is False


def test_photo_proxy_validation():
    assert Settings(photo_proxy="http://127.0.0.1:11801").photo_configured is True
    assert Settings(photo_proxy="https://proxy.example:8443").photo_configured is True
    for proxy in ("ftp://proxy.example", "http://user:pass@proxy.example", "http://proxy.example/?q=1",
                  "http://proxy.example/#f", "http://proxy.example\\x", "not a url", "http://proxy.example:99999",
                  "://missing-scheme"):
        assert Settings(photo_proxy=proxy).photo_configured is False, proxy


def test_photo_env_parse_failure_keeps_safe_defaults():
    settings = Settings.from_env({"LLM_MODE": "mock", "PHOTO_TIMEOUT_SECONDS": "not-a-number"})
    assert settings.configured is True
    assert settings.photo_timeout_seconds == 6.0
    assert settings.photo_daily_limit == 180
    assert settings.photo_proxy == ""
    assert settings.photo_configured is True  # anonymous defaults stay usable


def test_photo_env_reads_daily_limit_and_proxy():
    settings = Settings.from_env({"LLM_MODE": "mock", "PHOTO_DAY_LIMIT": "120", "PHOTO_PROXY": " http://127.0.0.1:11801 "})
    assert settings.photo_daily_limit == 120
    assert settings.photo_proxy == "http://127.0.0.1:11801"
    assert settings.photo_configured is True


def test_invalid_proxy_env_disables_photos_not_recommendations():
    settings = Settings.from_env({"LLM_MODE": "mock", "PHOTO_PROXY": "ftp://bad"})
    assert settings.configured is True
    assert settings.photo_configured is False


def test_invalid_llm_env_also_disables_photos():
    settings = Settings.from_env({"LLM_TIMEOUT_SECONDS": "abc"})
    assert settings.invalid_environment is True
    assert settings.configured is False
    assert settings.photo_configured is False


# --- API integration (ASGI transport, no sockets) ---


def body(dishes=None):
    return {"dishes": dishes if dishes is not None else [
        {"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "egg"]},
    ]}


async def post(app, path, payload):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(path, json=payload)


def test_photos_endpoint_returns_matched_photo():
    photo = openverse_photo()
    svc, _ = service(lambda request: photos_response(photo))
    app = create_app(settings=SETTINGS, photo_service=svc)
    response = asyncio.run(post(app, "/api/photos/match", body()))
    assert response.status_code == 200
    data = response.json()
    assert data["configured"] is True
    assert data["photos"][0]["dishId"] == "dish-1"
    assert data["photos"][0]["photo"]["url"] == photo["thumbnail"]
    assert data["photos"][0]["photo"]["source"] == "openverse"
    assert data["photos"][0]["photo"]["license"] == "CC BY 4.0"
    assert data["photos"][0]["photo"]["licenseUrl"] == photo["license_url"]


def test_photos_endpoint_unconfigured_is_200_with_nulls():
    app = create_app(settings=UNCONFIGURED)
    response = asyncio.run(post(app, "/api/photos/match", body()))
    assert response.status_code == 200
    assert response.json() == {"configured": False, "photos": [{"dishId": "dish-1", "photo": None}]}


def test_photo_upstream_failure_never_breaks_recommendations():
    def broken(request):
        raise httpx.ConnectError("upstream down")

    svc, _ = service(broken)
    app = create_app(settings=Settings(mode="mock"), photo_service=svc)
    photos = asyncio.run(post(app, "/api/photos/match", body()))
    assert photos.status_code == 200
    assert photos.json()["photos"][0]["photo"] is None
    generated = asyncio.run(post(app, "/api/recommendations/generate", {"scene": "cook"}))
    assert generated.status_code == 200
    assert generated.json()["source"] == "mock"
    assert len(generated.json()["recipes"]) >= 1


@pytest.mark.parametrize("payload", [
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["not-in-catalog"]}]),
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "tomato"]}]),
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "egg"]},
          {"id": "dish-1", "name": "土豆泥", "scene": "cook", "ingredientIds": ["potato"]}]),
    body([{"id": f"dish-{index}", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "egg"]}
          for index in range(6)]),
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "egg"], "extra": 1}]),
    {**body(), "extra": 1},
    body([]),
    body([{"id": "bad id!", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": ["tomato", "egg"]}]),
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "invalid", "ingredientIds": ["tomato", "egg"]}]),
    body([{"id": "dish-1", "scene": "cook", "ingredientIds": ["tomato", "egg"]}]),
    body([{"id": "dish-1", "name": "番茄炒蛋", "scene": "cook", "ingredientIds": []}]),
])
def test_photos_endpoint_rejects_invalid_contracts(payload):
    app = create_app(settings=UNCONFIGURED)
    response = asyncio.run(post(app, "/api/photos/match", payload))
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_request"


def test_photos_endpoint_is_post_only():
    app = create_app(settings=UNCONFIGURED)

    async def get():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.get("/api/photos/match")

    assert asyncio.run(get()).status_code == 405