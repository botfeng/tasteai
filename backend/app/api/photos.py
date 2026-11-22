from fastapi import APIRouter, Request

from app.photos import PhotoMatchRequest, PhotoMatchResponse
from app.schemas import ErrorResponse

router = APIRouter()


@router.post("/photos/match", response_model=PhotoMatchResponse, tags=["photos"],
             responses={status: {"model": ErrorResponse} for status in (422,)})
async def match_photos(body: PhotoMatchRequest, request: Request):
    # Deliberately ignore X-Forwarded-For: this service is not configured for public proxies.
    ip = request.client.host if request.client else "local-unknown"
    return await request.app.state.photo_service.match(body.dishes, ip)