from celery import Celery

celery_app = Celery("timer", broker="redis://localhost:6379/0")

@celery_app.task
def countdown_timer(seconds: int):
    import time
    time.sleep(seconds)
    return "時間到！"
