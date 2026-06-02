@echo off
echo ====================================================
echo Starting iGaps AI Platform with Python Scrapers...
echo ====================================================
echo.
echo This will boot up MongoDB and build the new Python microservice.
echo The first run may take a few minutes as it installs Google Chrome 
echo inside the Docker container.
echo.
docker-compose up --build
pause
