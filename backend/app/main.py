import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.api.health import router as health_router
from app.api.photos import router as photos_router
from app.api.recommendations import router as recommendations_router
from app.clients import RecommendationClient
from app.errors import RecommendationError
from app.limiter import LocalLimiter
from app.photos import PhotoService
from app.service import RecommendationService
from app.settings import Settings


def create_app(settings: Settings | None = None, client: RecommendationClient | None = None,
               limiter: LocalLimiter | None = None, photo_service: PhotoService | None = None) -> FastAPI:
    application = FastAPI(
        title="TasteAI API", version="0.4.1",
        description="TasteAI Day 4：仅供单进程本地演示；推荐默认关闭，真实 AI 需显式配置与费用授权；菜品示意图使用 Openverse 匿名搜索（CC0/PDM/CC BY），默认启用。",
    )
    settings = settings or Settings.from_env()
    origins = [value.strip() for value in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if value.strip()]
    if any(value == "*" or not value.startswith(("https://", "http://localhost:", "http://127.0.0.1:")) or "/" in value.split("://", 1)[1] for value in origins):
        raise ValueError("CORS_ALLOWED_ORIGINS must contain exact origins without trailing slashes")
    application.add_middleware(CORSMiddleware, allow_origins=origins,
                               allow_credentials=False, allow_methods=["GET", "POST"],
                               allow_headers=["Content-Type"])
    application.state.recommendation_service = RecommendationService(settings, client, limiter)
    application.state.photo_service = photo_service or PhotoService(settings)

    @application.exception_handler(RecommendationError)
    async def recommendation_error(_: Request, error: RecommendationError):
        headers = {"Retry-After": "60"} if error.code in {"rate_limit", "limiter_capacity"} else None
        return JSONResponse(status_code=error.status, headers=headers,
                            content={"detail": {"code": error.code, "message": error.message}})

    @application.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, __: RequestValidationError):
        return JSONResponse(status_code=422, content={"detail": {
            "code": "invalid_request", "message": "请求参数无效，请检查场景、食材与偏好选项；不接受自由文本或额外字段。"}})

    @application.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException):
        return JSONResponse(status_code=error.status_code, headers=error.headers, content={"detail": {
            "code": "not_found" if error.status_code == 404 else "http_error",
            "message": "请求地址不存在。" if error.status_code == 404 else "请求方法或格式不受支持。"}})

    @application.exception_handler(Exception)
    async def unexpected_error(_: Request, __: Exception):
        return JSONResponse(status_code=500, content={"detail": {
            "code": "internal_error", "message": "服务暂时无法处理请求，请稍后再试。"}})

    application.include_router(health_router, prefix="/api")
    application.include_router(recommendations_router, prefix="/api")
    application.include_router(photos_router, prefix="/api")
    return application


app = create_app()
