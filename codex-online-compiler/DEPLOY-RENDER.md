# Render la deploy panna

1. Project-a GitHub repo-la push pannunga (`.env` push panna vendaam, .gitignore already block pannum).
2. Render dashboard > New > Web Service > GitHub repo select pannunga.
   (Or New > Blueprint -> `render.yaml` auto-detect aagum.)
3. Settings:
   - Runtime: Node
   - Build Command: `npm install --include=dev && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
   - Env var `NODE_VERSION` = `22`
4. Environment variables: `JUDGE0_API_URL`, `JUDGE0_API_KEY`, `JUDGE0_API_HOST`
   (`PORT` Render thaane set pannum, neenga add panna vendaam.)
5. Deploy. URL: `https://<name>.onrender.com`

Note: Free plan 15 min idle-na sleep aagum; first request-ku ~1 min aagalaam.
