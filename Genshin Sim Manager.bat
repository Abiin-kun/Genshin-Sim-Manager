@echo off
title Genshin Sim Manager

cd /d "%~dp0"

:: Check if pnpm is installed, if not, install it globally
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] pnpm not found. Installing pnpm globally via npm...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install pnpm globally. Make sure Node.js/npm is installed first.
        pause
        exit /b
    )
)

echo Installing/checking dependencies...
call pnpm install

echo Starting server...
start "Server" cmd /c "pnpm start"

echo Waiting for server to initialize...
timeout /t 5 >nul

echo Opening browser...
start http://localhost:3000

echo Done! Server is running in a separate window.
pause