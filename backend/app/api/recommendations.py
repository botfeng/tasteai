from fastapi import APIRouter, Request

from app.catalog import CATALOG, CatalogIngredient
from app.schemas import ErrorResponse, RecommendationRequest, RecommendationResponse, RecommendationStatus

router = APIRouter()


@router.get("/ingredients", response_model=list[CatalogIngredient], tags=["ingredients"])
def ingredients():
    return CATALOG


@router.get("/recommendations/status", response_model=RecommendationStatus, tags=["recommendations"])
def recommendation_status(request: Request):
    return request.app.state.recommendation_service.status()


@router.post("/recommendations/generate", response_model=RecommendationResponse, tags=["recommendations"],
             responses={status: {"model": ErrorResponse} for status in (422, 429, 502, 503, 504)})
async def generate_recommendations(body: RecommendationRequest, request: Request):
    # Deliberately ignore X-Forwarded-For: this service is not configured for public proxies.
    ip = request.client.host if request.client else "local-unknown"
    return await request.app.state.recommendation_service.generate(body, ip)
