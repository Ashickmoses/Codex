# Codex Online Compiler

Multi-language online compiler + test-case validator + step-by-step visualizer (Monaco editor, Judge0 execution).

## Run locally (development)
    npm install
    cp .env.example .env
    npm run dev          # http://localhost:3000

## Host (production)
    npm install
    npm run build        # creates dist/
    npm start            # serves dist/ + API on $PORT (default 3000)

Set env vars (`PORT`, `JUDGE0_API_URL`, `JUDGE0_API_KEY`, `JUDGE0_API_HOST`) in your host's dashboard.
Build command: `npm install && npm run build`   Start command: `npm start`   Node >= 20.

Health check: `GET /api/health`
