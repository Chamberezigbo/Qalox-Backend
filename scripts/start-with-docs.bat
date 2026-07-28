@echo off
REM Qalox Backend - Start with Documentation (Windows)
REM This script starts the development server and automatically opens Swagger UI in the browser

echo.
echo 🚀 Starting Qalox Backend Server with Documentation...
echo.
echo Configuration:
echo   ✅ ENABLE_DOCS=true ^(Documentation enabled^)
echo   📍 Server: http://localhost:3000
echo   📚 Docs: http://localhost:3000/docs
echo.

REM Enable documentation
set ENABLE_DOCS=true
set NODE_ENV=development

REM Open docs in browser after a delay (in background)
start /B cmd /C "timeout /t 3 /nobreak && start http://localhost:3000/docs && echo 📖 Swagger UI opened in browser"

REM Start the development server
npm run dev

pause
