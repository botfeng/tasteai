from fastapi import FastAPI

from app.api.health import router as health_router

app = FastAPI(
    title="TasteAI API",
    version="0.1.0",
    description="TasteAI Day 0：仅提供服务存活检查，尚未接入数据库或推荐算法。",
)
app.include_router(health_router, prefix="/api")
