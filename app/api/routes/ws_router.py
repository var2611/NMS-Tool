from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from core.alert_engine import register_ws, unregister_ws
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    register_ws(websocket)
    logger.info(f"WebSocket client connected: {websocket.client}")
    try:
        while True:
            # Keep alive — client can send pings
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        unregister_ws(websocket)
        logger.info(f"WebSocket client disconnected")
