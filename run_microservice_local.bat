@echo off
echo ====================================================
echo Starting Python Microservice Locally...
echo ====================================================
echo.
cd backend\python_microservice
echo Installing Requirements...
pip install -r requirements.txt
echo.
echo Starting FastAPI server...
python -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
